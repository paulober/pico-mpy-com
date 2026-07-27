import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FileHandle } from "fs/promises";
import {
  encodeStringToEscaped,
  encodeStringToEscapedBin,
  writeEncodedBufferToFile,
} from "./escapeCoder.js";

function fakeFileHandle(): { writes: Buffer[]; handle: FileHandle } {
  const writes: Buffer[] = [];
  const handle = {
    write(data: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }> {
      const buf = Buffer.from(data);
      writes.push(buf);

      return Promise.resolve({ bytesWritten: buf.length, buffer: buf });
    },
  } as unknown as FileHandle;

  return { writes, handle };
}

describe("encodeStringToEscapedBin", () => {
  test("leaves printable ASCII untouched", () => {
    assert.equal(encodeStringToEscapedBin(Buffer.from("Hello")), "Hello");
  });

  test("hex-escapes non-printable bytes", () => {
    assert.equal(
      encodeStringToEscapedBin(Buffer.from([0x00, 0x1f, 0x7f, 0xff])),
      "\\x00\\x1f\\x7f\\xff"
    );
  });

  test("escapes single quote and backslash", () => {
    assert.equal(
      encodeStringToEscapedBin(Buffer.from([0x27, 0x5c])),
      "\\'\\\\"
    );
  });

  test("honors the byte limit", () => {
    assert.equal(encodeStringToEscapedBin(Buffer.from("abcdef"), 3), "abc");
    assert.equal(encodeStringToEscapedBin(Buffer.from("abc"), 0), "");
  });
});

describe("encodeStringToEscaped", () => {
  test("leaves printable ASCII untouched", () => {
    assert.equal(encodeStringToEscaped("abc"), "abc");
  });

  test("encodes a newline as the two-char sequence backslash-n", () => {
    assert.equal(encodeStringToEscaped("a\nb"), "a\\nb");
  });

  test("hex-escapes multi-byte UTF-8 characters", () => {
    assert.equal(encodeStringToEscaped("€"), "\\xe2\\x82\\xac");
  });
});

describe("writeEncodedBufferToFile", () => {
  test("round-trips binary data through encode -> decode", async () => {
    const original = Buffer.from([
      0x00, 0x01, 0x41, 0x42, 0xff, 0x0d, 0x0a, 0x7e,
    ]);
    const encoded = encodeStringToEscapedBin(original);

    const { writes, handle } = fakeFileHandle();
    await writeEncodedBufferToFile(encoded, handle);

    assert.ok(
      Buffer.concat(writes).equals(original),
      `decoded bytes did not match original (got ${Buffer.concat(
        writes
      ).toString("hex")})`
    );
  });
});
