import assert from "node:assert/strict";
import {
  createSilverhenBridge,
  serviceSilverhenBridge,
  startSilverhenBridge,
  stopSilverhenBridge,
  decodeSilverhenBase64,
  SILVERHEN_BRIDGE_MAGIC,
  SILVERHEN_BRIDGE_SIZE,
  SILVERHEN_FIRMWARE_1402,
} from "../src/slopkit-afterglow/silverhen-bridge.mjs";

const bridge = createSilverhenBridge(() => ({ low: 0x1234, hi: 0 }),
  { low: 0x5678, hi: 0x8 }, SILVERHEN_FIRMWARE_1402);
assert.equal(bridge.buffer.byteLength, SILVERHEN_BRIDGE_SIZE);
assert.equal(bridge.view.getUint32(0, true), SILVERHEN_BRIDGE_MAGIC);
assert.equal(bridge.view.getUint32(0x0c, true), SILVERHEN_FIRMWARE_1402);
assert.equal(bridge.view.getUint32(0x30, true), 0x5678);
assert.equal(bridge.view.getUint32(0x34, true), 0x8);
assert.deepEqual(bridge.address, { low: 0x1234, hi: 0 });

const memory = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
let writes = 0;
let probeWrites = 0;
const iface = {
  base: { low: 0x1000, hi: 1 },
  read(address, length) {
    if (address.low === 0x1000 && address.hi === 1)
      return memory.slice(0, length);
    if (address.low === 0x1010 && address.hi === 1)
      return new Uint8Array([0]).slice(0, length);
    throw new Error("unexpected test read address");
  },
  write(address, bytes) {
    if (address.low === 0x1010 && address.hi === 1) {
      assert.equal(bytes[0], 0);
      probeWrites++;
      return true;
    }
    assert.deepEqual(address, { low: 0x1000, hi: 1 });
    memory.set(bytes);
    writes++;
    return true;
  },
};
const fromWords = (low, hi) => ({ low, hi });
const probeOffset = { low: 0x10, hi: 0 };

assert.equal(startSilverhenBridge(bridge, iface, fromWords, probeOffset, 50), true);
assert.equal(bridge.view.getUint32(0x24, true), 0x03);
assert.equal(probeWrites, 1);
stopSilverhenBridge(bridge);

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
assert.equal(probeWrites, 2);

request(2, 4);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.deepEqual([...new Uint8Array(bridge.buffer, 0x40, 4)], [10, 20, 30, 40]);

request(3, 4);
new Uint8Array(bridge.buffer, 0x40, 4).set([1, 3, 5, 7]);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(writes, 1);
assert.deepEqual([...memory.slice(0, 4)], [1, 3, 5, 7]);

request(2, 0x1001);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -2);

const decoded = decodeSilverhenBase64(new TextEncoder().encode("6ekA"));
assert.deepEqual([...decoded], [0xe9, 0xe9, 0x00]);
console.log("SilverHEN host bridge tests passed");
