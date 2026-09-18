import assert from "node:assert/strict";
import test from "node:test";

import type { ContentBuilder, Message } from "@spectrum-ts/core";

import { executeIMessageFrontendTool } from "./native-tools.js";

function fakeMessage() {
  const reactions: string[] = [];
  const replies: unknown[] = [];
  const sends: unknown[] = [];
  const message = {
    space: { id: "chat-1", async send(value: unknown) { sends.push(value); } },
    async react(value: string) {
      reactions.push(value);
      return undefined;
    },
    async reply(value: unknown) {
      replies.push(value);
      return undefined;
    },
  } as unknown as Message;
  return { message, reactions, replies, sends };
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
  assert.deepEqual(JSON.parse(outcome.result), {
    ok: true,
    action: "tapback",
    reaction: "like",
    glyph: "👍",
  });
});

test("poll tool sends one native card in the current chat and records its content", async () => {
  const { message, sends, replies } = fakeMessage();
  const outcome = await executeIMessageFrontendTool({ id: "poll", function: {
    name: "imessage_send_poll", arguments: { title: " Dinner? ", options: [" Rice ", "Noodles"] },
  } }, message, 3000);
  assert.equal(sends.length, 1);
  assert.equal(replies.length, 0);
  assert.deepEqual(await (sends[0] as ContentBuilder).build(), {
    type: "poll", title: "Dinner?", options: [{ title: "Rice" }, { title: "Noodles" }],
  });
  assert.equal(outcome.sentReply, true);
  assert.deepEqual(JSON.parse(outcome.result).options, ["Rice", "Noodles"]);
});

test("invalid poll inputs send nothing", async () => {
  const { message, sends } = fakeMessage();
  for (const options of [["one"], ["one", " one "], ["", "two"], [1, "two"], Array.from({ length: 11 }, (_, i) => String(i))]) {
    await assert.rejects(executeIMessageFrontendTool({ id: "invalid", function: {
      name: "imessage_send_poll", arguments: { title: "Question", options },
    } }, message, 3000));
  }
  assert.equal(sends.length, 0);
});

test("voting requires the current poll and records the actual selected choice", async () => {
  const { message } = fakeMessage();
  const votes: number[] = [];
  const context = { title: "Dinner?", options: ["Rice", "Noodles"], async vote(index: number) { votes.push(index); } };
  const call = { id: "vote", function: { name: "imessage_vote_current_poll", arguments: { option_index: 2 } } };
  await assert.rejects(executeIMessageFrontendTool(call, message, 3000), /no votable poll/);
  for (const index of [0, 3, 1.5, "2"]) {
    await assert.rejects(executeIMessageFrontendTool({ ...call, function: { ...call.function, arguments: { option_index: index } } }, message, 3000, undefined, context));
  }
  const outcome = await executeIMessageFrontendTool(call, message, 3000, undefined, context);
  assert.deepEqual(votes, [2]);
  assert.equal(outcome.sentReply, true);
  assert.equal(JSON.parse(outcome.result).option, "Noodles");
  await assert.rejects(executeIMessageFrontendTool(call, message, 3000, undefined, {
    ...context, async vote() { throw new Error("provider failed"); },
  }), /provider failed/);
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
  assert.deepEqual(JSON.parse(outcome.result), {
    ok: true,
    action: "reply",
    text: "one\n\ntwo",
    bubbles: 2,
    effect: "none",
  });
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

test("poll validation covers missing, malformed, blank, and overlong fields before pacing", async () => {
  const { message, sends } = fakeMessage();
  const invalid = [
    {}, { title: 1, options: ["A", "B"] }, { title: "  ", options: ["A", "B"] },
    { title: "x".repeat(201), options: ["A", "B"] },
    { title: "Question", options: "A,B" }, { title: "Question", options: null },
    { title: "Question", options: ["A", "x".repeat(101)] },
    { title: "Question", options: ["A", " \n "] },
  ];
  for (const input of invalid) {
    await assert.rejects(executeIMessageFrontendTool({ id: "poll-regression", function: {
      name: "imessage_send_poll", arguments: JSON.stringify(input),
    } }, message, 3000, async () => { assert.fail("invalid input must not be paced"); }), /poll requires/);
  }
  assert.deepEqual(sends, []);
});

test("maximum-sized poll is sent through pacing and reports the exact visible content", async () => {
  const { message, sends } = fakeMessage();
  const title = "Q".repeat(200);
  const options = Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(99)}`);
  const paced: string[] = [];
  const outcome = await executeIMessageFrontendTool({ id: "poll-regression", function: {
    name: "imessage_send_poll", arguments: JSON.stringify({ title, options }),
  } }, message, 3000, async (id, send) => {
    assert.equal(sends.length, 0);
    paced.push(id);
    await send();
  });
  assert.deepEqual(paced, ["chat-1"]);
  assert.equal(sends.length, 1);
  assert.deepEqual(JSON.parse(outcome.result), { ok: true, action: "poll", title, options });
  assert.equal(outcome.sentReply, true);
});

test("poll send failures propagate without a successful visible-reply result", async () => {
  const { message } = fakeMessage();
  const failure = new Error("send failed");
  message.space.send = async () => { throw failure; };
  await assert.rejects(executeIMessageFrontendTool({ id: "poll-regression", function: {
    name: "imessage_send_poll", arguments: { title: "Dinner?", options: ["Rice", "Noodles"] },
  } }, message, 3000), (error) => error === failure);
});

test("voting is paced in the current conversation and reports all selected-choice fields", async () => {
  const { message } = fakeMessage();
  const events: string[] = [];
  const outcome = await executeIMessageFrontendTool({ id: "poll-regression", function: {
    name: "imessage_vote_current_poll", arguments: '{"option_index":1}',
  } }, message, 3000, async (id, send) => {
    events.push(`pace:${id}`);
    await send();
  }, { title: "Dinner?", options: ["Rice", "Noodles"], async vote(index) { events.push(`vote:${index}`); } });
  assert.deepEqual(events, ["pace:chat-1", "vote:1"]);
  assert.deepEqual(JSON.parse(outcome.result), {
    ok: true, action: "poll_vote", title: "Dinner?", option_index: 1, option: "Rice",
  });
  assert.equal(outcome.sentReply, true);
});

test("poll cards, vote events, and hydrated custom cards reject Tapbacks and threaded replies", async () => {
  const poll = { type: "poll" as const, title: "Dinner?", options: [{ title: "Rice" }, { title: "Noodles" }] };
  for (const content of [poll, {
    type: "poll_option" as const, title: "Rice", option: poll.options[0], poll, selected: true,
  }, { type: "custom" as const, raw: {} }]) {
    const { message, reactions, replies, sends } = fakeMessage();
    message.content = content;
    const context = content.type === "custom"
      ? { title: "Dinner?", options: ["Rice", "Noodles"], async vote() {} } : undefined;
    for (const [name, args, error] of [
      ["imessage_react_to_current_message", { reaction: "like" }, /do not support Tapbacks/],
      ["imessage_reply_to_current_message", { text: "Rice please" }, /do not support threaded replies/],
    ] as const) {
      await assert.rejects(executeIMessageFrontendTool({ id: "poll-regression", function: { name, arguments: args } },
        message, 3000, undefined, context), error);
    }
    assert.deepEqual([reactions, replies, sends], [[], [], []]);
  }
});
