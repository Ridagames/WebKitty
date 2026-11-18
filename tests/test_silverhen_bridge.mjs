import assert from "node:assert/strict";
import {
  createSilverhenBridge,
  serviceSilverhenBridge,
  startSilverhenBridge,
  stopSilverhenBridge,
  decodeSilverhenBase64,
  waitForSilverhenPayload,
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
  findModule(processName, moduleName) {
    assert.equal(processName, "SceShellUI");
    assert.equal(moduleName, "libkernel_sys.sprx");
    return { pid: 42, base: { low: 0x200000, hi: 1 },
      size: { low: 0x40000, hi: 0 } };
  },
  processReadWrite(pid, address, dataAddress, length, write) {
    assert.equal(pid, 42);
    assert.equal(length, 6);
    assert.equal(dataAddress.low, (bridge.address.low + 0x40) >>> 0);
    assert.ok(
      (address.low === 0x21d100 || address.low === 0x21d460) &&
      address.hi === 1,
      "process memory operation must target one of the two allow-listed ShellUI gates"
    );
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

request(4, 0, 0, 0);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), 0);
request(6, 6, 0x21d100, 1);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), 0);
request(5, 6, 0x21d460, 1);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), 0);
request(6, 6, 0x21d460, 1);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), 0);
request(6, 6, 0x21d200, 1);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -15);
request(2, 0x1001);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -2);

/* A read request must be rejected if the host did not verify read access. */
bridge.view.setUint32(0x24, 0, true);
request(2, 4);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -9);

/* A write request must be rejected if write access was not verified. */
bridge.view.setUint32(0x24, 0x01, true);
request(3, 4);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), true);
assert.equal(bridge.view.getInt32(0x1c, true), -10);
assert.equal(writes, 1);

/* A mismatched firmware ID invalidates the bridge before servicing requests. */
bridge.view.setUint32(0x0c, 0x00000e00, true);
request(1, 0, 0, 0);
assert.equal(serviceSilverhenBridge(bridge, iface, fromWords), false);
assert.equal(bridge.view.getUint32(0x14, true), bridge.lastSequence);

/* Do not treat a started pthread as a successful HEN activation. */
const activationBridge = { view: new DataView(new ArrayBuffer(SILVERHEN_BRIDGE_SIZE)) };
activationBridge.view.setInt32(0x38, 1, true);
assert.deepEqual(await waitForSilverhenPayload(activationBridge, 20, 1),
  { state: "ready", status: 1 });
activationBridge.view.setInt32(0x38, -4, true);
assert.deepEqual(await waitForSilverhenPayload(activationBridge, 20, 1),
  { state: "error", status: -4 });
activationBridge.view.setInt32(0x38, 0, true);
assert.deepEqual(await waitForSilverhenPayload(activationBridge, 2, 1),
  { state: "timeout", status: 0 });

const decoded = decodeSilverhenBase64(new TextEncoder().encode("6ekA"));
assert.deepEqual([...decoded], [0xe9, 0xe9, 0x00]);
console.log("SilverHEN host bridge tests passed");
