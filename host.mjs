import { Sandbox } from "./sandbox.mjs"
import fs from 'fs'
import assert from 'assert'
import path from 'path'

const globalThis = { console };

begin();
resume();

function begin() {
  const sandbox = new Sandbox({ globalThis });

  const appText = fs.readFileSync('app.js', 'utf-8');
  const { incr } = sandbox.evaluateCommonJsModule(appText);

  assert.equal(incr(), 1);
  assert.equal(incr(), 2);
  assert.equal(incr(), 3);

  console.log('Saving snapshot');
  const snapshot = sandbox.takeSnapshot({ incr });
  fs.writeFileSync('snapshot.bin', snapshot);
}

function resume() {
  console.log('Resuming from snapshot');

  const snapshot = fs.readFileSync('snapshot.bin');
  const { incr } = Sandbox.restoreFromSnapshot(snapshot, { globalThis });

  assert.equal(incr(), 4);
  assert.equal(incr(), 5);
  assert.equal(incr(), 6);
}
