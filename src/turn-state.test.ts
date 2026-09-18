import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@spectrum-ts/core";
import { executeIMessageFrontendTool } from "./native-tools.js";
import { GatewayTurnState } from "./turn-state.js";

test("sending or voting on a poll allows the subsequent assistant text", async () => {
  const message = { space: { id: "chat", async send() {} } } as unknown as Message;
  for (const [name, args] of [
    ["imessage_send_poll", { title: "Dinner?", options: ["Rice", "Noodles"] }],
    ["imessage_vote_current_poll", { option_index: 1 }],
  ] as const) {
    const state = new GatewayTurnState();
    state.record(await executeIMessageFrontendTool({ id: "poll", function: { name, arguments: args } }, message, 3000, undefined,
      { title: "Dinner?", options: ["Rice", "Noodles"], async vote() {} }));
    assert.equal(state.sentReply, true, "empty continuation is valid after a visible action");
    assert.equal(state.suppressFinalText, false, "poll actions must not swallow follow-up text");
  }
});

test("a real threaded text reply still suppresses duplicate final text, even alongside a poll", async () => {
  const replies: unknown[] = [];
  const message = { space: { id: "chat", async send() {} }, async reply(value: unknown) { replies.push(value); } } as unknown as Message;
  const state = new GatewayTurnState();
  state.record(await executeIMessageFrontendTool({ id: "reply", function: {
    name: "imessage_reply_to_current_message", arguments: { text: "Hello" },
  } }, message, 3000));
  state.record(await executeIMessageFrontendTool({ id: "poll", function: {
    name: "imessage_send_poll", arguments: { title: "Dinner?", options: ["Rice", "Noodles"] },
  } }, message, 3000));
  assert.deepEqual(replies, ["Hello"]);
  assert.equal(state.suppressFinalText, true);
});
