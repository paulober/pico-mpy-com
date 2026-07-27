import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SerialPort } from "serialport";
import { readUntil } from "./serialHelper.js";

/**
 * Minimal pull-based fake of the parts of SerialPort that readUntil touches:
 * `read(n)`, `readable` and `readableLength`. Backed by a byte buffer that
 * drains as it is read.
 */
class FakePort {
  private data: Buffer;

  constructor(data: Buffer) {
    this.data = data;
  }

  get readable(): boolean {
    return true;
  }

  get readableLength(): number {
    return this.data.length;
  }

  read(size?: number): Buffer | null {
    if (this.data.length === 0) {
      return null;
    }
    const n =
      size === undefined ? this.data.length : Math.min(size, this.data.length);
    const chunk = this.data.subarray(0, n);
    this.data = this.data.subarray(n);

    return chunk;
  }
}

function fakePort(data: Buffer): SerialPort {
  return new FakePort(data) as unknown as SerialPort;
}

describe("readUntil", () => {
  test("reads to a multi-byte suffix, byte-accurate UTF-8", async () => {
    const payload = Buffer.from("café>>> ", "utf-8");
    const result = await readUntil(fakePort(payload), 1, ">>> ", 1);

    assert.ok(result);
    assert.ok(result.equals(payload));
    assert.equal(result.toString("utf-8"), "café>>> ");
  });

  test("returns accumulated buffer when suffix never arrives", async () => {
    const payload = Buffer.from("partial output", "utf-8");
    const result = await readUntil(fakePort(payload), 1, ">>> ", 0.1);

    assert.ok(result);
    assert.equal(result.toString("utf-8"), "partial output");
  });

  test("receiver mode streams bytes and returns the last byte", async () => {
    const chunks: Buffer[] = [];
    const payload = Buffer.from("hi\n", "utf-8");
    const result = await readUntil(fakePort(payload), 1, "\n", 1, data =>
      chunks.push(Buffer.from(data))
    );

    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(Buffer.concat(chunks).toString("utf-8"), "hi\n");
  });
});
