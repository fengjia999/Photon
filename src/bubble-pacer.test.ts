import assert from "node:assert/strict";
import test from "node:test";

import { BubblePacer } from "./bubble-pacer.js";

test("bubbles in one conversation are separated by the configured delay", async () => {
  let now = 100;
  const waits: number[] = [];
  const sentAt: number[] = [];
  const pacer = new BubblePacer(
    1000,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await pacer.send("chat-1", async () => sentAt.push(now));
  await pacer.send("chat-1", async () => sentAt.push(now));

  assert.deepEqual(waits, [1000]);
  assert.deepEqual(sentAt, [100, 1100]);
});

test("different conversations do not delay each other", async () => {
  let now = 100;
  const waits: number[] = [];
  const pacer = new BubblePacer(
    1000,
    () => now,
    async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  );

  await pacer.send("chat-1", async () => undefined);
  await pacer.send("chat-2", async () => undefined);

  assert.deepEqual(waits, []);
});

