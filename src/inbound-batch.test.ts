import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@spectrum-ts/core";
import { combineInbound } from "./inbound-batch.js";

const first = { id: "first" } as Message;
const last = { id: "last" } as Message;

test("text batches preserve ordering, boundaries and the latest reply target", () => {
  const batch = combineInbound([{ content: "one", sourceMessage: first }, { content: "two", sourceMessage: last }]);
  assert.equal(batch.content, "[第 1 条消息]\none\n[第 2 条消息]\ntwo");
  assert.equal(batch.sourceMessage, last);
  const single = { content: "one", sourceMessage: first };
  assert.equal(combineInbound([single]), single);
});

test("mixed image and text batches retain all content and the latest votable poll", () => {
  const poll = { title: "Dinner?", options: ["Rice", "Noodles"], async vote() {} };
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,abc" } };
  const batch = combineInbound([
    { content: "poll choices", sourceMessage: first, currentPoll: poll },
    { content: [image], sourceMessage: first },
    { content: "Choose rice", sourceMessage: last },
  ]);
  assert.deepEqual(batch.content, [
    { type: "text", text: "本批投票工具 imessage_vote_current_poll 仅对应第 1 条消息的投票，请使用那条消息的选项编号。" },
    { type: "text", text: "[第 1 条消息]" }, { type: "text", text: "poll choices" },
    { type: "text", text: "[第 2 条消息]" }, image,
    { type: "text", text: "[第 3 条消息]" }, { type: "text", text: "Choose rice" },
  ]);
  assert.equal(batch.currentPoll, poll);
  assert.equal(batch.sourceMessage, last);
});

test("multiple polls explicitly identify which numbered message the voting tool targets", () => {
  const poll = { title: "First poll", options: ["A", "B"], async vote() {} };
  const latest = { ...poll, title: "Second poll" };
  const batch = combineInbound([
    { content: "First poll", sourceMessage: first, currentPoll: poll },
    { content: "Second poll", sourceMessage: last, currentPoll: latest },
    { content: "Choose A", sourceMessage: last },
  ]);
  assert.equal(batch.currentPoll, latest);
  assert.match(String(batch.content), /仅对应第 2 条消息的投票/);
});
