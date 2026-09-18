import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { InboundBatcher } from "./inbound-batcher.js";

test("each new message resets the 30 second window and sends one ordered batch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  const batcher = new InboundBatcher<string>(async (items) => { calls.push(items); }, (error) => assert.fail(String(error)));
  batcher.add("chat", "one", 30_000);
  t.mock.timers.tick(20_000);
  batcher.add("chat", "two", 30_000);
  t.mock.timers.tick(29_999);
  await setImmediate();
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(calls, [["one", "two"]]);
  await batcher.close();
});

test("messages received while responding form a subsequent batch without overlapping turns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  let release!: () => void;
  const busy = new Promise<void>((resolve) => { release = resolve; });
  const batcher = new InboundBatcher<string>(async (items) => {
    calls.push(items);
    if (calls.length === 1) await busy;
  }, (error) => assert.fail(String(error)));
  batcher.add("chat", "first", 0);
  await setImmediate();
  batcher.add("chat", "second", 30_000);
  t.mock.timers.tick(10_000);
  batcher.add("chat", "third", 30_000);
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.deepEqual(calls, [["first"]]);
  release();
  await setImmediate();
  assert.deepEqual(calls, [["first"], ["second", "third"]]);
  await batcher.close();
});

test("finishing a response does not flush a new batch before its quiet period", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  const batcher = new InboundBatcher<string>(async (items) => { calls.push(items); }, (error) => assert.fail(String(error)));
  batcher.add("chat", "first", 0);
  batcher.add("chat", "later", 30_000);
  await setImmediate();
  assert.deepEqual(calls, [["first"]]);
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.deepEqual(calls, [["first"], ["later"]]);
  await batcher.close();
});

test("conversations have independent timers and zero delay keeps messages separate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  const batcher = new InboundBatcher<string>(async (items) => { calls.push(items); }, (error) => assert.fail(String(error)));
  batcher.add("a", "a1", 30_000);
  batcher.add("b", "b1", 10_000);
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.deepEqual(calls, [["b1"]]);
  batcher.add("b", "b2", 0);
  batcher.add("b", "b3", 0);
  await setImmediate();
  assert.deepEqual(calls, [["b1"], ["b2"], ["b3"]]);
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.deepEqual(calls[3], ["a1"]);
  await batcher.close();
});

test("failed batches do not block following messages and shutdown flushes pending input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[][] = [];
  const errors: unknown[] = [];
  const failure = new Error("gateway down");
  const batcher = new InboundBatcher<string>(async (items) => {
    calls.push(items);
    if (items[0] === "fail") throw failure;
  }, (error) => { errors.push(error); });
  batcher.add("a", "fail", 0);
  batcher.add("a", "next", 30_000);
  await batcher.close();
  assert.deepEqual(calls, [["fail"], ["next"]]);
  assert.deepEqual(errors, [failure]);
  assert.throws(() => batcher.add("a", "too late", 0), /closed/);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls.length, 2);
});
