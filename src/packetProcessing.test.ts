import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseListContentsPacket,
  prependParentDirectories,
  hasFile,
  getHashFromResponses,
  rp2DatetimeToDate,
  dateToRp2Datetime,
  sanitizeRemote,
  standardizePath,
  type HashResponse,
} from "./packetProcessing.js";

describe("parseListContentsPacket", () => {
  test("parses size and path, flags directories by trailing slash", () => {
    assert.deepEqual(parseListContentsPacket("5 /a.py\n0 /lib/\n"), [
      { path: "/a.py", isDir: false, size: 5 },
      { path: "/lib/", isDir: true, size: 0 },
    ]);
  });

  test("strips carriage returns and skips empty/malformed lines", () => {
    assert.deepEqual(parseListContentsPacket("5 /a.py\r\n\r\n123\n"), [
      { path: "/a.py", isDir: false, size: 5 },
    ]);
  });

  test("keeps spaces inside a path", () => {
    assert.deepEqual(parseListContentsPacket("7 /my file.py"), [
      { path: "/my file.py", isDir: false, size: 7 },
    ]);
  });
});

describe("prependParentDirectories", () => {
  test("expands a nested path into sorted ancestors", () => {
    assert.deepEqual(prependParentDirectories(["/a/b/c"]), [
      "/a",
      "/a/b",
      "/a/b/c",
    ]);
  });

  test("deduplicates shared parents across folders", () => {
    assert.deepEqual(prependParentDirectories(["/a/b", "/a/c"]), [
      "/a",
      "/a/b",
      "/a/c",
    ]);
  });
});

describe("hash response helpers", () => {
  const responses: HashResponse[] = [
    { file: "/a.py", hash: "aaa" },
    { file: "/b.py", error: "missing" },
  ];

  test("hasFile detects presence", () => {
    assert.equal(hasFile(responses, "/a.py"), true);
    assert.equal(hasFile(responses, "/x.py"), false);
  });

  test("getHashFromResponses returns hash or undefined", () => {
    assert.equal(getHashFromResponses(responses, "/a.py"), "aaa");
    assert.equal(getHashFromResponses(responses, "/b.py"), undefined);
    assert.equal(getHashFromResponses(responses, "/x.py"), undefined);
  });
});

describe("rp2 datetime conversion", () => {
  test("parses a valid rp2 datetime tuple", () => {
    const d = rp2DatetimeToDate("(2024, 3, 11, 0, 14, 30, 45, 0)");
    assert.deepEqual(d, new Date(2024, 2, 11, 14, 30, 45));
  });

  test("rejects malformed or out-of-range tuples", () => {
    assert.equal(rp2DatetimeToDate("(2024, 3, 11)"), null);
    assert.equal(rp2DatetimeToDate("(2024, 13, 11, 0, 0, 0, 0, 0)"), null);
    assert.equal(rp2DatetimeToDate("not a tuple"), null);
  });

  test("round-trips a Date through encode and decode", () => {
    const original = new Date(2024, 2, 11, 14, 30, 45);
    const back = rp2DatetimeToDate(dateToRp2Datetime(original));
    assert.deepEqual(back, original);
  });
});

describe("sanitizeRemote", () => {
  test("maps undefined to root", () => {
    assert.equal(sanitizeRemote(undefined), "/");
  });

  test("strips a single leading colon", () => {
    assert.equal(sanitizeRemote(":dir/file.py"), "dir/file.py");
  });

  test("leaves a plain path untouched", () => {
    assert.equal(sanitizeRemote("dir/file.py"), "dir/file.py");
  });
});

describe("standardizePath", () => {
  test("normalizes slashes and sorts by depth", () => {
    assert.deepEqual(standardizePath("/base", ["/base/a/b.py", "/base/c.py"]), [
      ["/base/c.py", "/c.py"],
      ["/base/a/b.py", "/a/b.py"],
    ]);
  });
});
