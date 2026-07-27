import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizePath,
  wrapWithSlash,
  removeLeadingSlash,
  removeTrailingSlash,
  removeTrailingAndLeadingSlash,
  ignoreHelper,
} from "./scanAndHash.js";

describe("path helpers", () => {
  test("sanitizePath normalizes backslashes and repeated slashes", () => {
    assert.equal(sanitizePath("a\\b\\c"), "a/b/c");
    assert.equal(sanitizePath("a//b///c"), "a/b/c");
    assert.equal(sanitizePath("a\\\\b//c"), "a/b/c");
  });

  test("wrapWithSlash ensures a single leading and trailing slash", () => {
    assert.equal(wrapWithSlash("foo"), "/foo/");
    assert.equal(wrapWithSlash("/foo"), "/foo/");
    assert.equal(wrapWithSlash("foo/"), "/foo/");
    assert.equal(wrapWithSlash("/foo/"), "/foo/");
  });

  test("slash trimming helpers", () => {
    assert.equal(removeLeadingSlash("/foo"), "foo");
    assert.equal(removeLeadingSlash("foo"), "foo");
    assert.equal(removeTrailingSlash("foo/"), "foo");
    assert.equal(removeTrailingSlash("foo"), "foo");
    assert.equal(removeTrailingAndLeadingSlash("/foo/"), "foo");
    assert.equal(removeTrailingAndLeadingSlash("foo"), "foo");
  });
});

describe("ignoreHelper (pyignore matching)", () => {
  // returns true when the path is NOT ignored, false when it is ignored
  test("keeps files when nothing is configured", () => {
    assert.equal(ignoreHelper([], [], "src/main.py"), true);
  });

  test("wildcard ignores by folder name anywhere in the path", () => {
    assert.equal(
      ignoreHelper(["**/node_modules"], [], "src/node_modules/x.py"),
      false
    );
    assert.equal(ignoreHelper(["**/node_modules"], [], "src/main.py"), true);
  });

  test("wildcard ignores by exact basename", () => {
    assert.equal(ignoreHelper(["**/secret.py"], [], "src/secret.py"), false);
    assert.equal(ignoreHelper(["**/secret.py"], [], "src/public.py"), true);
  });

  test("direct ignore matches an exact relative path", () => {
    assert.equal(ignoreHelper([], ["src/secret.py"], "src/secret.py"), false);
    assert.equal(ignoreHelper([], ["src/secret.py"], "src/other.py"), true);
  });

  test("direct ignore matches a whole folder prefix", () => {
    assert.equal(ignoreHelper([], ["build"], "build/out.py"), false);
    assert.equal(ignoreHelper([], ["build"], "builder/out.py"), true);
  });
});
