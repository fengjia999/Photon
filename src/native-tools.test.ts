import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@spectrum-ts/core";

import { executeIMessageFrontendTool } from "./native-tools.js";

function fakeMessage() {
  const reactions: string[] = [];
  const replies: unknown[] = [];
  const message = {
    async react(value: string) {
      reactions.push(value);
      return undefined;
    },
    async reply(value: unknown) {
      replies.push(value);
      return undefined;
    },
  } as unknown as Message;
  return { message, reactions, replies };
}

test("Tapback tool maps semantic reaction names to native glyphs", async () => {
  const { message, reactions } = fakeMessage();
  const outcome = await executeIMessageFrontendTool({
    id: "call-1",
    function: {
      name: "imessage_react_to_current_message",
      arguments: JSON.stringify({ reaction: "like" }),
    },
  }, message, 3000);

  assert.deepEqual(reactions, ["👍"]);
  assert.equal(outcome.sentReply, false);
});

test("native reply tool threads every non-empty bubble", async () => {
  const { message, replies } = fakeMessage();
  const outcome = await executeIMessageFrontendTool({
    id: "call-2",
    function: {
      name: "imessage_reply_to_current_message",
      arguments: { text: "one\n\ntwo", effect: "none" },
    },
  }, message, 3000);

  assert.deepEqual(replies, ["one", "two"]);
  assert.equal(outcome.sentReply, true);
  assert.match(outcome.result, /"bubbles":2/);
});

test("native reply applies an effect only to the first bubble", async () => {
  const { message, replies } = fakeMessage();
  await executeIMessageFrontendTool({
    id: "call-3",
    function: {
      name: "imessage_reply_to_current_message",
      arguments: { text: "one\ntwo", effect: "confetti" },
    },
  }, message, 3000);

  assert.equal(typeof replies[0], "object");
  assert.equal(replies[1], "two");
});
