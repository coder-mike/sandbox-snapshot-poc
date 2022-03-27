import assert from 'assert/strict'

const mapValues = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]))
const unexpected = () => { throw new Error('Did not expect to get here') }

export class Sandbox {
  #wet // The app side of the membrane
  #dry // The host side of the membrane
  #ioJournal // A recording of all IO between wet and dry side
  #dryGlobals
  #wetGlobals
  #controlChannelDry
  #mode
  #journalReplayCursor

  constructor (opts) {
    const { globalThis } = opts ?? {}

    this.#dryGlobals = globalThis ?? {}
    this.#ioJournal = []
    this.#wet = new SerializingMembrane(this.#sendToDry.bind(this), 'wet', 'dry')
    this.#dry = new SerializingMembrane(this.#sendToWet.bind(this), 'dry', 'wet')
    this.#mode = 'live'

    // Set up globals
    this.#dry.defineWellKnownLocal('globalThis', this.#createGlobalThis())
    this.#wetGlobals = this.#wet.defineWellKnownRemote('globalThis')

    // Connect to wet controlChannel from dry side
    this.#wet.defineWellKnownLocal('controlChannel', this.#controlChannelWet())
    this.#controlChannelDry = this.#dry.defineWellKnownRemote('controlChannel')
  }

  evaluateCommonJsModule(moduleText, filename) {
    // Send to wet side to be evaluated
    return this.#controlChannelDry.evaluateCommonJsModule(moduleText, filename)
  }

  takeSnapshot(captures) {
    const exportList = mapValues(captures, v => this.#dry.serialize(v));
    const ioJournal = this.#ioJournal;
    const json = JSON.stringify({ ioJournal, exportList })
    const buffer = Buffer.from(json, 'utf-8')
    return buffer;
  }

  static restoreFromSnapshot(snapshot, opts) {
    const sandbox = new Sandbox(opts)
    return sandbox.#restoreFromSnapshot(snapshot)
  }

  #createGlobalThis() {
    // Using a proxy to prevent the app accessing any globals it likes
    return new Proxy({}, {
      get: (_, p) => this.#dryGlobals[p],
      set: (_, p) => false,
      has: (_, p) => true,
    })
  }

  #controlChannelWet() {
    return {
      evaluateCommonJsModule: this.#evaluateCommonJsModule.bind(this)
    }
  }

  #evaluateCommonJsModule(moduleText, filename) {
    const wrapped = `(function(globalThis){with(globalThis){return function(module,exports,require){${moduleText}}}})`;
    const wrapper = globalThis.eval(wrapped)
    const wetModule = { exports: {} };
    const wetExports = wetModule.exports;
    const require = undefined;
    wrapper(this.#wetGlobals)(wetModule, wetExports, require);
    Object.assign(wetExports, wetModule.exports);
    return wetExports
  }

  #restoreFromSnapshot(snapshot) {
    const json = snapshot.toString('utf-8')
    const { ioJournal, exportList } = JSON.parse(json)
    this.#ioJournal = ioJournal;
    this.#mode = 'replay'
    this.#journalReplayCursor = 0
    while (this.#journalReplayCursor < this.#ioJournal.length) {
      const entry = this.#ioJournal[this.#journalReplayCursor]
      // The root loop is a set of actions to be performed against the sandbox.
      // We don't support async/await in sandboxes yet so the sandbox cannot
      // spontaneously call out to the host
      entry.type === 'action-to-wet' || unexpected();
      this.#sendToWet(entry.action)
    }
    this.#mode = 'live'
    const captures = mapValues(exportList, v => {
      // Resolve value inside app
      const wet = this.#wet.deserialize(v)
      // Move back across the boundary (message travelling the opposite direction)
      const msg = this.#wet.serialize(wet)
      const dry = this.#dry.deserialize(msg)
      return dry
    });
    return captures;
  }

  #sendToWet(action) {
    if (this.#mode === 'live') {
      this.#ioJournalAppend({ type: 'action-to-wet', action })
      const result = this.#wet.receiveAction(action);
      this.#ioJournalAppend({ type: 'return-from-wet', result })
      return result;
    } else {
      this.#expectNextJournalEntry({ type: 'action-to-wet', action })
      const result = this.#wet.receiveAction(action)
      this.#expectNextJournalEntry({ type: 'return-from-wet', result })
      return result;
    }
  }

  #sendToDry(action) {
    if (this.#mode === 'live') {
      this.#ioJournalAppend({ type: 'action-to-dry', action })
      const result = this.#dry.receiveAction(action);
      this.#ioJournalAppend({ type: 'return-from-dry', result })
      return result;
    } else {
      this.#expectNextJournalEntry({ type: 'action-to-dry', action })
      const entry = this.#nextJournalEntry()
      entry.type === 'return-from-dry' || unexpected();
      return entry.result
    }
  }

  #ioJournalAppend(event) {
    event.index = this.#ioJournal.length
    this.#logJournalEvent(event)
    this.#ioJournal.push(event)
  }

  #logJournalEvent(event) {
    return;
    if (event.type.startsWith('action')) {
      console.log(this.#mode, event.index, event.type, event.action?.type, event.action?.target?.id, event.action)
    } else if (event.type.startsWith('return')) {
      console.log(this.#mode, event.index, event.type, event.result)
    } else {
      console.log(this.#mode, event.index, event.type, event)
    }
  }

  #expectNextJournalEntry(expect) {
    expect.index = this.#journalReplayCursor
    const entry = this.#nextJournalEntry()
    assert.deepEqual(expect, entry)
  }

  #nextJournalEntry() {
    const entry = this.#ioJournal[this.#journalReplayCursor++] ?? unexpected()
    this.#logJournalEvent(entry)
    return entry;
  }
}

/** A synchronous JavaScript membrane where all IO flows through `sendAction`
 * and `receiveAction`, where actions are POD. */
class SerializingMembrane {
  /**
   * @param sendAction A callback when the membrane needs to send an action to
   * the remote side
   */
  constructor (sendAction, localDebugId, remoteDebugId) {
    this.sendAction = sendAction
    this.serializedByObject = new WeakMap() // In the form that we would send to the other side
    this.objectsByLocalId = new Map()
    this.objectsByRemoteId = new Map()
    this.nextLocalId = 1
    this.localDebugId = localDebugId
    this.remoteDebugId = remoteDebugId
  }

  /**
   * Handle an action sent by the other side
   * @returns A serialized representation of the result
   */
  receiveAction(action) {
    switch (action.type) {
      case 'apply': {
        const target = this.deserialize(action.target);
        const thisArg = this.deserialize(action.thisArg);
        const args = action.args.map(arg => this.deserialize(arg));
        const result = Reflect.apply(target, thisArg, args);
        return this.serialize(result);
      }

      case 'get': {
        const target = this.deserialize(action.target);
        const receiver = this.deserialize(action.receiver);
        const propertyKey = this.deserialize(action.propertyKey);
        const result = Reflect.get(target, propertyKey, receiver);
        return this.serialize(result);
      }

      case 'has': {
        const target = this.deserialize(action.target);
        const propertyKey = this.deserialize(action.propertyKey);
        const result = Reflect.has(target, propertyKey);
        return this.serialize(result);
      }

      case 'set': {
        const target = this.deserialize(action.target);
        const receiver = this.deserialize(action.receiver);
        const value = this.deserialize(action.value);
        const propertyKey = this.deserialize(action.propertyKey);
        const result = Reflect.set(target, propertyKey, value, receiver);
        return this.serialize(result);
      }

      default: unexpected()
    }
  }

  defineWellKnownLocal(id, localObj) {
    this.objectsByLocalId.set(id, localObj)
    // Cache the serialized form of how this would be sent to the other side
    this.serializedByObject.set(localObj, {
      type: 'src-obj',
      objectType: 'object',
      id
    })
  }

  defineWellKnownRemote(id) {
    return this.#proxyRemoteObject(id, 'object')
  }

  serialize(value) {
    switch (typeof value) {
      case 'undefined':
      case 'boolean':
      case 'number':
      case 'string':
        return { type: 'literal', value };

      case 'function':
      case 'object': {
        if (value === null) return { type: 'literal', value }

        // Note: Local objects will be in this Map if they've been sent
        // previously. Remote objects will always be in this Map because we map
        // them when we receive them, so if control passes these 2 lines then
        // it's definitely a local object.
        let serialized = this.serializedByObject.get(value)
        if (serialized) return serialized;

        const id = this.nextLocalId++
        const type = 'src-obj'
        const objectType = typeof value // function or object
        serialized = { type, id, objectType };
        this.serializedByObject.set(value, serialized)
        this.objectsByLocalId.set(id, value)

        return serialized
      }

      case 'symbol': {
        switch (value) {
          case Symbol.asyncIterator: return { type: 'well-known-symbol', name: 'asyncIterator' }
          case Symbol.hasInstance: return { type: 'well-known-symbol', name: 'hasInstance' }
          case Symbol.isConcatSpreadable: return { type: 'well-known-symbol', name: 'isConcatSpreadable' }
          case Symbol.iterator: return { type: 'well-known-symbol', name: 'iterator' }
          case Symbol.match: return { type: 'well-known-symbol', name: 'match' }
          case Symbol.matchAll: return { type: 'well-known-symbol', name: 'matchAll' }
          case Symbol.replace: return { type: 'well-known-symbol', name: 'replace' }
          case Symbol.search: return { type: 'well-known-symbol', name: 'search' }
          case Symbol.species: return { type: 'well-known-symbol', name: 'species' }
          case Symbol.split: return { type: 'well-known-symbol', name: 'split' }
          case Symbol.toPrimitive: return { type: 'well-known-symbol', name: 'toPrimitive' }
          case Symbol.toStringTag: return { type: 'well-known-symbol', name: 'toStringTag' }
          case Symbol.unscopables: return { type: 'well-known-symbol', name: 'unscopables' }
          default:
            unexpected(); // Not implemented yet: user-defined symbols
        }
      }

      default: unexpected()
    }
  }

  deserialize(value) {
    switch (value.type) {
      case 'literal': return value.value;
      case 'src-obj': {
        const remoteId = value.id;
        if (this.objectsByRemoteId.has(remoteId)) {
          return this.objectsByRemoteId.get(remoteId)
        }
        return this.#proxyRemoteObject(remoteId, value.objectType)
      }
      case 'dst-obj': {
        return this.objectsByLocalId.get(value.id) ?? unexpected();
      }
      case 'well-known-symbol': {
        switch (value.name) {
          case 'asyncIterator': return Symbol.asyncIterator
          case 'hasInstance': return Symbol.hasInstance
          case 'isConcatSpreadable': return Symbol.isConcatSpreadable
          case 'iterator': return Symbol.iterator
          case 'match': return Symbol.match
          case 'matchAll': return Symbol.matchAll
          case 'replace': return Symbol.replace
          case 'search': return Symbol.search
          case 'species': return Symbol.species
          case 'split': return Symbol.split
          case 'toPrimitive': return Symbol.toPrimitive
          case 'toStringTag': return Symbol.toStringTag
          case 'unscopables': return Symbol.unscopables
          default:
            unexpected(); // Not implemented yet: user-defined symbols
        }
      }
      default:
        throw new Error('Not implemented')
    }
  }

  #proxyRemoteObject(remoteId, objectType) {
    const target = objectType === 'function' ? () => {} : {};
    target.debugId = `${this.remoteDebugId}:${remoteId}`;
    const obj = new Proxy(target, {
      get: (_target, propertyKey, receiver) => {
        // Remote object accessed from local side
        const result = this.sendAction({
          type: 'get',
          target: this.serialize(obj),
          propertyKey: this.serialize(propertyKey),
          receiver: this.serialize(receiver)
        })
        return this.deserialize(result)
      },

      has: (_target, propertyKey) => {
        // Remote object accessed from local side
        const result = this.sendAction({
          type: 'has',
          target: this.serialize(obj),
          propertyKey: this.serialize(propertyKey)
        })
        return this.deserialize(result)
      },

      set: (_target, propertyKey, value, receiver) => {
        // Remote object accessed from local side
        const result = this.sendAction({
          type: 'set',
          target: this.serialize(obj),
          propertyKey: this.serialize(propertyKey),
          value: this.serialize(value),
          receiver: this.serialize(receiver)
        })
        return this.deserialize(result)
      },

      apply: (_target, thisArg, args) => {
        // Remote function called from local side
        const result = this.sendAction({
          type: 'apply',
          target: this.serialize(obj),
          thisArg: this.serialize(thisArg),
          args: args.map(arg => this.serialize(arg))
        })
        return this.deserialize(result)
      }
    })

    this.objectsByRemoteId.set(remoteId, obj)
    this.serializedByObject.set(obj, {
      type: 'dst-obj',
      objectType,
      id: remoteId
    })

    return obj;
  }
}