import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Queue } from "./queue.js";

describe("Queue", () => {
  test("is empty on creation", () => {
    const q = new Queue<number>();
    assert.equal(q.isEmpty(), true);
    assert.equal(q.size(), 0);
    assert.equal(q.dequeue(), undefined);
  });

  test("preserves FIFO order", () => {
    const q = new Queue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);

    assert.equal(q.size(), 3);
    assert.equal(q.isEmpty(), false);
    assert.equal(q.dequeue(), 1);
    assert.equal(q.dequeue(), 2);
    assert.equal(q.dequeue(), 3);
    assert.equal(q.dequeue(), undefined);
    assert.equal(q.isEmpty(), true);
  });
});
