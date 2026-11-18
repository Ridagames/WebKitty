/*
 * SilverHEN shared-memory bridge host adapter.
 *
 * Integrated into the opt-in Afterglow 14.02 SilverHEN path. The browser
 * retains this buffer, passes its address as the raw pthread argument, and
 * services bounded kernel requests until the native payload reports ready
 * or exits with an error.
 */

export const SILVERHEN_BRIDGE_MAGIC = 0x53484231;
export const SILVERHEN_BRIDGE_ABI = 2;
export const SILVERHEN_FIRMWARE_1402 = 0x00000e02;
export const SILVERHEN_BRIDGE_SIZE = 0x1040;
export const SILVERHEN_BRIDGE_DATA_MAX = 0x1000;

const SHELLUI_PATCH_SIZE = 6;
const SHELLUI_PATCH_OFFSETS = [0x1d100, 0x1d460];

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
  targetPid: 0x3c,
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
    shellUiModule: null,
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
      v.getUint32(OFF.totalSize, true) < SILVERHEN_BRIDGE_SIZE ||
      v.getUint32(OFF.firmwareId, true) !== SILVERHEN_FIRMWARE_1402)
    return false;

  const request = v.getUint32(OFF.requestSequence, true);
  const response = v.getUint32(OFF.responseSequence, true);
  if (request === response || request === bridge.lastSequence)
    return false;

  const command = v.getUint32(OFF.command, true);
  const length = v.getUint32(OFF.length, true);
  const capabilities = v.getUint32(OFF.verifiedCapabilities, true);
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
      if ((capabilities & 0x01) === 0) {
        status = -9;
      } else if (length === 0 || length > SILVERHEN_BRIDGE_DATA_MAX) {
        status = -2;
      } else {
        const bytes = kernelInterface.read(address, length);
        if (!bytes || bytes.length !== length) status = -3;
        else new Uint8Array(bridge.buffer, OFF.data, length).set(bytes);
      }
    } else if (command === 3) {
      /* Enforce the verified write capability again at the host boundary. */
      if ((capabilities & 0x02) === 0) {
        status = -10;
      } else if (length === 0 || length > SILVERHEN_BRIDGE_DATA_MAX) {
        status = -2;
      } else {
        const bytes = new Uint8Array(bridge.buffer, OFF.data, length);
        if (kernelInterface.write(address, bytes) !== true) status = -3;
      }
    } else if (command === 4) {
      if (typeof kernelInterface.findModule !== "function") {
        status = -11;
      } else {
        const module = kernelInterface.findModule("SceShellUI", "libkernel_sys.sprx");
        if (!module || !module.pid || !module.base || !module.size ||
            !Number.isInteger(module.base.low) || !Number.isInteger(module.base.hi) ||
            !Number.isInteger(module.size.low) || !Number.isInteger(module.size.hi) ||
            (module.size.hi >>> 0) === 0 &&
              (module.size.low >>> 0) < SHELLUI_PATCH_OFFSETS[1] + SHELLUI_PATCH_SIZE) {
          status = -12;
        } else {
          bridge.shellUiModule = {
            pid: module.pid >>> 0,
            base: { low: module.base.low >>> 0, hi: module.base.hi >>> 0 },
            size: { low: module.size.low >>> 0, hi: module.size.hi >>> 0 },
            patchAddresses: SHELLUI_PATCH_OFFSETS.map(offset =>
              addInt64(module.base, offset, addressFromWords)),
          };
          v.setUint32(OFF.targetPid, module.pid >>> 0, true);
          v.setUint32(OFF.data, module.pid >>> 0, true);
          v.setUint32(OFF.data + 4, module.base.low >>> 0, true);
          v.setUint32(OFF.data + 8, module.base.hi >>> 0, true);
          v.setUint32(OFF.data + 12, module.size.low >>> 0, true);
          v.setUint32(OFF.data + 16, module.size.hi >>> 0, true);
          v.setUint32(OFF.length, 20, true);
        }
      }
    } else if (command === 5 || command === 6) {
      const pid = v.getUint32(OFF.targetPid, true);
      const module = bridge.shellUiModule;
      const allowedTarget = module && pid === module.pid &&
        length === SHELLUI_PATCH_SIZE &&
        module.patchAddresses.some(target =>
          (target.low >>> 0) === (address.low >>> 0) &&
          (target.hi >>> 0) === (address.hi >>> 0));
      if (!pid || typeof kernelInterface.processReadWrite !== "function") {
        status = -13;
      } else if (length === 0 || length > SILVERHEN_BRIDGE_DATA_MAX) {
        status = -2;
      } else if (!allowedTarget) {
        status = -15;
      } else if (command === 5 && (capabilities & 0x01) === 0) {
        status = -9;
      } else if (command === 6 && (capabilities & 0x02) === 0) {
        status = -10;
      } else {
        const dataAddress = addInt64(bridge.address, OFF.data, addressFromWords);
        const ok = kernelInterface.processReadWrite(
          pid, address, dataAddress, length, command === 6);
        if (ok !== true) status = -14;
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

/* Wait for the native payload's explicit activation result. A thread being
   created is not proof that SilverHEN initialized or that its notification
   API call succeeded. */
export async function waitForSilverhenPayload(bridge, timeoutMs = 15000, intervalMs = 10) {
  if (!bridge || !bridge.view || typeof bridge.view.getInt32 !== "function")
    throw new TypeError("SilverHEN activation wait requires a live bridge");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(intervalMs) || intervalMs < 1)
    throw new RangeError("Invalid SilverHEN activation wait limits");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = bridge.view.getInt32(OFF.payloadStatus, true);
    if (status === 1) return { state: "ready", status };
    if (status !== 0) return { state: "error", status };
    if (Date.now() >= deadline) return { state: "timeout", status };
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
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
