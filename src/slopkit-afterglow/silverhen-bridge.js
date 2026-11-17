/*
 * SilverHEN shared-memory bridge host adapter.
 *
 * This module is intended to be integrated into the Afterglow host after its
 * kernel interface (iface.read/iface.write) has been created. It is not yet
 * wired into WebKitty's loader; the pthread argument must be changed from
 * NULL to bridge.address and this service must remain alive while the payload
 * is running.
 */

export const SILVERHEN_BRIDGE_MAGIC = 0x53484231;
export const SILVERHEN_BRIDGE_ABI = 1;
export const SILVERHEN_BRIDGE_SIZE = 0x1030;
export const SILVERHEN_BRIDGE_DATA_MAX = 0x1000;

const OFF = {
  magic: 0x00,
  abi: 0x04,
  totalSize: 0x08,
  requestSequence: 0x10,
  responseSequence: 0x14,
  command: 0x18,
  status: 0x1c,
  length: 0x20,
  address: 0x28,
  data: 0x30,
};

export function createSilverhenBridge(bufAddr) {
  if (typeof bufAddr !== "function")
    throw new TypeError("SilverHEN bridge requires a buffer-address resolver");

  const buffer = new ArrayBuffer(SILVERHEN_BRIDGE_SIZE);
  const view = new DataView(buffer);
  view.setUint32(OFF.magic, SILVERHEN_BRIDGE_MAGIC, true);
  view.setUint32(OFF.abi, SILVERHEN_BRIDGE_ABI, true);
  view.setUint32(OFF.totalSize, SILVERHEN_BRIDGE_SIZE, true);

  return {
    buffer,
    view,
    address: bufAddr(buffer),
    active: false,
    timer: null,
    lastSequence: 0,
  };
}

/* Process at most one request per tick so the browser event loop stays live. */
export function serviceSilverhenBridge(bridge, kernelInterface, addressFromWords) {
  if (!bridge || !bridge.view || !kernelInterface ||
      typeof kernelInterface.read !== "function" ||
      typeof kernelInterface.write !== "function" ||
      typeof addressFromWords !== "function")
    return false;

  const v = bridge.view;
  if (v.getUint32(OFF.magic, true) !== SILVERHEN_BRIDGE_MAGIC ||
      v.getUint32(OFF.abi, true) !== SILVERHEN_BRIDGE_ABI ||
      v.getUint32(OFF.totalSize, true) < SILVERHEN_BRIDGE_SIZE)
    return false;

  const request = v.getUint32(OFF.requestSequence, true);
  const response = v.getUint32(OFF.responseSequence, true);
  if (request === response || request === bridge.lastSequence)
    return false;

  const command = v.getUint32(OFF.command, true);
  const length = v.getUint32(OFF.length, true);
  const addressLow = v.getUint32(OFF.address, true);
  const addressHigh = v.getUint32(OFF.address + 4, true);
  const address = addressFromWords(addressLow, addressHigh);
  let status = 0;

  try {
    if (command === 1) {
      /* PING: prove that the Afterglow kernel interface is still present. */
      if (!kernelInterface || typeof kernelInterface.read !== "function")
        status = -1;
    } else if (command === 2) {
      if (length === 0 || length > SILVERHEN_BRIDGE_DATA_MAX) {
        status = -2;
      } else {
        const bytes = kernelInterface.read(address, length);
        if (!bytes || bytes.length !== length) status = -3;
        else new Uint8Array(bridge.buffer, OFF.data, length).set(bytes);
      }
    } else if (command === 3) {
      if (length === 0 || length > SILVERHEN_BRIDGE_DATA_MAX) {
        status = -2;
      } else {
        const bytes = new Uint8Array(bridge.buffer, OFF.data, length);
        if (kernelInterface.write(address, bytes) !== true) status = -3;
      }
    } else {
      status = -4;
    }
  } catch (_) {
    status = -5;
  }

  /* Publish response only after status and optional data are fully written. */
  v.setInt32(OFF.status, status, true);
  v.setUint32(OFF.responseSequence, request, true);
  bridge.lastSequence = request;
  return true;
}

export function startSilverhenBridge(bridge, kernelInterface, addressFromWords, intervalMs = 1) {
  if (!bridge || bridge.active) return false;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 50)
    return false;
  bridge.active = true;
  bridge.timer = setInterval(() => {
    serviceSilverhenBridge(bridge, kernelInterface, addressFromWords);
  }, intervalMs);
  return true;
}

export function stopSilverhenBridge(bridge) {
  if (!bridge) return;
  if (bridge.timer !== null) clearInterval(bridge.timer);
  bridge.timer = null;
  bridge.active = false;
}
