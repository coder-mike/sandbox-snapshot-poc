# Working demonstration of snapshotting in node.js by IO replay

This is a quick weekend project to demonstrate how you can implement something like Microvium snapshotting in node.js without native engine support for snapshotting. It works by running the app in a sandbox surrounded by a membrane and recording all IO to/from the sandbox, to replay at a later stage to reconstruct the exact state of the sandbox in a different running process.

## App

The file [app.js](#file-app-js) represents a JavaScript application whose process we want to be able to snapshot to a file and then later resume from the snapshot file to continue where it left off. It demonstrates access to IO (via the `console`) and statefulness (via the `counter` variable).

"Snapshotting" in this context means capturing the full state of the app in form that can be saved to file, like with [Microvium snapshots](https://coder-mike.com/blog/2020/05/15/snapshotting-vs-bundling/). It logically includes the full state of the JavaScript heap and all the variables, including those nested in function closures.

## Host

The file [host.mjs](#file-host-mjs) is the entry point to the demonstration and can be run using `node host.mjs`. It runs the app and produces the following console output:

```
Starting app
Incrementing counter from 0 to 1
Incrementing counter from 1 to 2
Incrementing counter from 2 to 3
Saving snapshot
Resuming from snapshot
Incrementing counter from 3 to 4
Incrementing counter from 4 to 5
Incrementing counter from 5 to 6
```

It consists of two parts, `begin` and `resume`.

`begin` starts the app and calls `incr` a few times to change the app's state. It then snapshots the app's state to file.

`resume` restores the app's state from a snapshot file. This does not need to be run in the same host process or machine as `begin`. To test this, you can comment out `begin` and see that the `resume` still works fine on its own, as long as `snapshot.bin` already exists.

## Sandbox

The sandbox API is simple:

  - `new Sandbox({ globalThis })` creates a new sandbox (isolated JS environment, like a new virtual machine) with a new set of global variables specified by `globalThis`. In the example, the only global variable is `console`.

  - `sandbox.evaluateCommonJsModule(sourceText)` evaluates the given CommonJs source text in the sandboxed environment, returning the exports object for use by the caller.

  - `snapshot = sandbox.takeSnapshot({ ...captures })` returns a `Buffer` of bytes representing the current state of the sandboxed app. The `captures` are a set of objects in the app that you're giving names to so that you can access them by name later when you restore the snapshot.

  - `captures = Sandbox.restoreFromSnapshot(snapshot, { globalThis })` takes a previously-created snapshot and restores the process state of the JS modules. Any captures provided to `takeSnapshot` are returned here so that you can access them by name. The globals in the new environment can be provided by `globalThis`.

## How it works

Node does not have any builtin capability to perform snapshotting. This entire experiment is to test out a completely novel way of achieving snapshotting of a JavaScript app without having engine support for it.

The essence of how it works is that it treats the app like a deterministic state machine. This is valid because JavaScript is single threaded. The state of any state machine is unambiguously determined by the initial state and all the inputs.

The sandbox records all inputs to the app (the initial state is just the empty sandbox) and saves these as the snapshot data. To restore the app state from the snapshot, it creates an empty sandbox and replays the saved inputs.

In slightly more detail, it works by setting up a [proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) layer (aka [membrane](https://github.com/salesforce/observable-membrane#what-is-a-membrane)) between the host and the app. All communication between the app and the host is exchanged between the two through a full-duplex POD communication channel. This includes:

 - All calls to the app (e.g. `incr`)
 - All calls to the host (e.g. `console.log()`)
 - All global variable access from the app (e.g. `console`)
 - All property accesses (e.g. `app.incr` or `console.log`)

The duplex communication channel is recorded continuosly. When the host asks to snapshot the app state, the recorded communication is simply dumped to a `Buffer`.

When resuming the app from a snapshot, an empty sandbox is created, and all the recorded communication is replayed against the sandbox to reconstruct the state of the app. During the replay, calls from the app to the host do not actually go to the host since they already went to the host before the snapshot was taken; they are just verified against the expected output from the app. You can see this in the fact that all the old `console.log` messages do not appear in the terminal again when the app is resumed. Similarly, the app would only see the pre-recorded responses from the original host during the replay, so even calls like `Math.random` will deterministically reproduce their original results during the replay.

More detail is in [internals.md](internals.md)

## WARNING - limitations

### Debugger use

Running a debugger on the app will cause the snapshot to be invalid. This is because the debugger may cause the app to make calls to the host or sandbox that were not recorded in the snapshot. This is just a limitation of this approach.

### Ephemerals

References to host objects other than the `globalThis` do not persist across snapshots, because there is no way to identify the equivalent object in the new host environment. This includes things like `console.log`. This is just a limitation of this approach.

The example app does not hit this limitation because the `console.log` statements are implicitly re-accessing the `console` property on `globalThis` each time. But if you captured either the `console` or `log` object/function in a variable before the snapshot, the variable would no longer be valid after the snapshot is restored. It would hold a reference to a [revoked proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/revocable).

### Arrays and prototypes

Currently the proxy system used by the membrane ignores object prototypes. This means that references to arrays, maps, etc., across the membrane will not work. This can be fixed in future but wasn't needed for the proof of concept.
