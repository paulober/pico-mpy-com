import type { PortInfo } from "@serialport/bindings-cpp";

export interface VidPidPair {
  vid: number;
  pid: number;
}

// TODO: exact matches of allowed VID/PID pairs
const supportedVids = [0x2e8a, 0x10c4, 0x1a86, 0x303a, 0xf055, 0x0403];
const supportedPids = [
  0x0005, 0xea60, 0x7523, 0x1001, 0x9802, 0x7002, 0x7003, 0x7006, 0x7007,
  0x1020, 0x101f, 0x1021, 0x1086, 0x4001, 0x105b, 0x10a3, 0x10a4, 0x10a5,
  0x1016, 0x1002, 0x1003, 0x55d3, 0x6010, 0x6011, 0x6014, 0x6015,
];

export function isUsbDeviceSupported(
  port: PortInfo,
  customVidPidPairs?: VidPidPair[]
): boolean {
  // port.vendorId?.toLowerCase() === "2e8a" && port.productId === "0005"
  const vid = Number(`0x${port.vendorId}`);
  const pid = Number(`0x${port.productId}`);

  const baseSupport =
    supportedVids.includes(vid) && supportedPids.includes(pid);
  if (baseSupport) {
    return true;
  }

  // Check custom VID/PID pairs
  if (customVidPidPairs && customVidPidPairs.length > 0) {
    return customVidPidPairs.some(pair => pair.vid === vid && pair.pid === pid);
  }

  return false;
}
