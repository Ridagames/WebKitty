/*
 * SilverHEN shared-memory bridge host adapter.
 *
 * Integrated into the opt-in Afterglow 14.02 SilverHEN path. The browser
 * retains this buffer, passes its address as the raw pthread argument, and
 * services bounded kernel requests until the native payload reports ready
 * or exits with an error.
 */

export const SILVERHEN_BRIDGE_MAGIC = 0x53484231;
export const SILVERHEN_BRIDGE_ABI = 1;
export const SILVERHEN_FIRMWARE_1402 = 0x00000e02;
export const SILVERHEN_BRIDGE_SIZE = 0x1040;
export const SILVERHEN_BRIDGE_DATA_MAX = 0x1000;

const OFF = {
  magic: 0x00,
  abi: 0x04,
  totalSize: 0x08,
  firmwareId: 0x0c,
  requestSequence: 0x10,
  responseSequence: 0x14,
  command: 0x18,
  status: 0x1c,
  length: 0x20,
  verifiedCapabilities: 0x24,
  address: 0x28,
  notificationFunction: 0x30,
  payloadStatus: 0x38,
  data: 0x40,
};

export function createSilverhenBridge(bufAddr, notificationFunction, firmwareId) {
  if (typeof bufAddr !== "function")
    throw new TypeError("SilverHEN bridge requires a buffer-address resolver");
  if (firmwareId !== SILVERHEN_FIRMWARE_1402)
    throw new TypeError("SilverHEN bridge only supports firmware 14.02");
  if (!notificationFunction || !Number.isInteger(notificationFunction.low) ||
      !Number.isInteger(notificationFunction.hi) ||
      (notificationFunction.low >>> 0) === 0 && (notificationFunction.hi >>> 0) === 0)
    throw new TypeError("SilverHEN requires a verified libkernel notification function");

  const buffer = new ArrayBuffer(SILVERHEN_BRIDGE_SIZE);
  const view = new DataView(buffer);
  view.setUint32(OFF.magic, SILVERHEN_BRIDGE_MAGIC, true);
  view.setUint32(OFF.abi, SILVERHEN_BRIDGE_ABI, true);
  view.setUint32(OFF.totalSize, SILVERHEN_BRIDGE_SIZE, true);
  view.setUint32(OFF.firmwareId, firmwareId, true);
  view.setUint32(OFF.notificationFunction, notificationFunction.low >>> 0, true);
  view.setUint32(OFF.notificationFunction + 4, notificationFunction.hi >>> 0, true);
  view.setUint32(OFF.verifiedCapabilities, 0, true);

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
function addInt64(base, delta, addressFromWords) {
  const baseLow = base.low >>> 0;
  const deltaLow = typeof delta === "number" ? delta >>> 0 : delta.low >>> 0;
  const deltaHigh = typeof delta === "number"
    ? Math.floor(delta / 0x100000000) >>> 0 : delta.hi >>> 0;
  const low = (baseLow + deltaLow) >>> 0;
  const carry = low < baseLow ? 1 : 0;
  const high = ((base.hi >>> 0) + deltaHigh + carry) >>> 0;
  return addressFromWords(low, high);
}

function verifyKernelCapabilities(bridge, kernelInterface,
                                  addressFromWords, writeProbeOffset) {
  let capabilities = 0;
  try {
    const probe = kernelInterface.read(kernelInterface.base, 1);
    if (probe && probe.length === 1) {
      capabilities |= 0x01;
      if (writeProbeOffset) {
        const scratch = addInt64(kernelInterface.base, writeProbeOffset,
                                 addressFromWords);
        const before = kernelInterface.read(scratch, 1);
        if (before && before.length === 1 && before[0] === 0 &&
            kernelInterface.write(scratch, before) === true) {
          const after = kernelInterface.read(scratch, 1);
          if (after && after.length === 1 && after[0] === before[0])
            capabilities |= 0x02;
        }
      }
    }
  } catch (_) {
    capabilities = 0;
  }
  bridge.view.setUint32(OFF.verifiedCapabilities, capabilities, true);
  return capabilities;
}

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
      /* PING rechecks the live kernel read and the zero-byte write probe. */
      if (!kernelInterface.base ||
          typeof kernelInterface.read !== "function") {
        status = -1;
      } else {
        const probe = kernelInterface.read(kernelInterface.base, 1);
        if (!probe || probe.length !== 1) status = -1;
      }
      const capabilities = v.getUint32(OFF.verifiedCapabilities, true);
      if (status === 0 && (capabilities & 0x02) !== 0) {
        const probeOffset = bridge.writeProbeOffset;
        const addressFromWords = bridge.addressFromWords;
        if (!probeOffset || !addressFromWords) {
          status = -6;
        } else {
          const probeAddress = addInt64(kernelInterface.base, probeOffset,
                                        addressFromWords);
          const before = kernelInterface.read(probeAddress, 1);
          if (!before || before.length !== 1 || before[0] !== 0 ||
              kernelInterface.write(probeAddress, before) !== true) {
            status = -7;
          } else {
            const after = kernelInterface.read(probeAddress, 1);
            if (!after || after.length !== 1 || after[0] !== before[0])
              status = -8;
          }
        }
      }
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

export function startSilverhenBridge(bridge, kernelInterface, addressFromWords, writeProbeOffset, intervalMs = 1) {
  if (!bridge || bridge.active) return false;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 50)
    return false;
  const capabilities = verifyKernelCapabilities(bridge, kernelInterface,
    addressFromWords, writeProbeOffset);
  if ((capabilities & 0x01) === 0) return false;
  bridge.addressFromWords = addressFromWords;
  bridge.writeProbeOffset = writeProbeOffset || null;
  bridge.active = true;
  bridge.timer = setInterval(() => {
    if (bridge.view.getInt32(OFF.payloadStatus, true) !== 0) {
      stopSilverhenBridge(bridge);
      return;
    }
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

export function decodeSilverhenBase64(bytes) {
  let encoded = "";
  for (let i = 0; i < bytes.length; ++i)
    encoded += String.fromCharCode(bytes[i]);
  encoded = encoded.replace(/\s+/g, "");
  const decoded = atob(encoded);
  const output = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; ++i)
    output[i] = decoded.charCodeAt(i);
  return output;
}
