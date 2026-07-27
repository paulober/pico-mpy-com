import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SerialPort } from "serialport";
import { readUntil, escapeForReplEval } from "./serialHelper.js";

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

  closed = false;

  get readable(): boolean {
    return !this.closed;
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

describe("escapeForReplEval", () => {
  test("keeps a bytes escape sequence intact (issue #282)", () => {
    // b'\xAA' must reach the board with its backslash preserved, otherwise
    // Python decodes \xAA to U+00AA and re-encodes it as two bytes.
    assert.equal(escapeForReplEval("b'\\xAA'"), "b'\\\\xAA'");
  });

  test("escapes double quotes", () => {
    assert.equal(escapeForReplEval('print("hi")'), 'print(\\"hi\\")');
  });

  test("escapes backslashes before quotes", () => {
    assert.equal(escapeForReplEval('\\"'), '\\\\\\"');
  });

  test("leaves plain code untouched", () => {
    assert.equal(escapeForReplEval("x = 1 + 2"), "x = 1 + 2");
  });
});

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

  test("stops waiting when the port disconnects, even with no timeout", async () => {
    const port = new FakePort(Buffer.from("partial", "utf-8"));
    // suffix never arrives and timeout is null (infinite); the read must still
    // return once the port reports it has closed, instead of hanging.
    const pending = readUntil(port as unknown as SerialPort, 1, ">>> ", null);
    setTimeout(() => {
      port.closed = true;
    }, 30);

    const result = await pending;
    assert.ok(result);
    assert.equal(result.toString("utf-8"), "partial");
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
