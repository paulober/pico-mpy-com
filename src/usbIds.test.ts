import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PortInfo } from "@serialport/bindings-cpp";
import { toSerialPortDetails } from "./usbIds.js";

function port(info: Partial<PortInfo>): PortInfo {
  return {
    path: "/dev/test",
    manufacturer: undefined,
    serialNumber: undefined,
    pnpId: undefined,
    locationId: undefined,
    productId: undefined,
    vendorId: undefined,
    ...info,
  };
}

describe("toSerialPortDetails", () => {
  test("parses the hex USB IDs and marks supported boards", () => {
    const details = toSerialPortDetails(
      port({ vendorId: "2e8a", productId: "0005", manufacturer: "MicroPython" })
    );

    assert.equal(details.vendorId, 0x2e8a);
    assert.equal(details.productId, 0x0005);
    assert.equal(details.manufacturer, "MicroPython");
    assert.equal(details.supported, true);
  });

  test("keeps ports without USB IDs", () => {
    const details = toSerialPortDetails(port({ path: "/dev/tty.debug" }));

    assert.equal(details.path, "/dev/tty.debug");
    assert.equal(details.vendorId, undefined);
    assert.equal(details.productId, undefined);
    assert.equal(details.supported, false);
  });

  test("marks custom VID/PID pairs as supported", () => {
    const sparkfun = port({ vendorId: "1B4F", productId: "0026" });

    assert.equal(toSerialPortDetails(sparkfun).supported, false);
    assert.equal(
      toSerialPortDetails(sparkfun, [{ vid: 0x1b4f, pid: 0x0026 }]).supported,
      true
    );
  });
});
