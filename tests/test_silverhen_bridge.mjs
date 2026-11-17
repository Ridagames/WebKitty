import assert from "node:assert/strict";
import {
  createSilverhenBridge,
  serviceSilverhenBridge,
  SILVERHEN_BRIDGE_MAGIC,
  SILVERHEN_BRIDGE_SIZE,
} from "../src/slopkit-afterglow/silverhen-bridge.js";

const bridge = createSilverhenBridge(() => ({ low: 0x1234, hi: 0 }));
assert.equal(bridge.buffer.byteLength, SILVERHEN_BRIDGE_SIZE);
assert.equal(bridge.view.getUint32(0, true), SILVERHEN_BRIDGE_MAGIC);
assert.deepEqual(bridge.address, { low: 0x1234, hi: 0 });

const memory = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
let writes = 0;
const iface = {
  read(address, length) {
    assert.deepEqual(address, { low: 0x1000, hi: 1 });
    return memory.slice(0, length);
  },
  write(address, bytes) {
    assert.deepEqual(address, { low: 0x1000, hi: 1 });
    memory.set(bytes);
    writes++;
    return true;
  },
};
const fromWords = (low, hi) => ({ low, hi });

function request(command, length, addressLow = 0x1000, addressHigh = 1) {
  bridge.view.setUint32(0x10, bridge.lastSequence + 1, true);
  bridge.view.setUint32(0x18, command, true);
  bridge.view.setUint32(0x20, length, true);
  bridge.view.setUint32(0x28, addressLow, true);
  bridge.view.setUint32(0x2c, addressHigh, true);
}

request(1, 0, 0, 0);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), 0);
assert.equal(bridge.view.getUint32(0x14, true), 1);

request(2, 4);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.deepEqual([...new Uint8Array(bridge.buffer, 0x30, 4)], [10, 20, 30, 40]);

request(3, 4);
new Uint8Array(bridge.buffer, 0x30, 4).set([1, 3, 5, 7]);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(writes, 1);
assert.deepEqual([...memory.slice(0, 4)], [1, 3, 5, 7]);

request(2, 0x1001);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -2);

console.log("SilverHEN host bridge tests passed");
