import assert from "node:assert/strict";
import test from "node:test";
import { stream, type Space } from "@spectrum-ts/core";
import type { PollEvent } from "@photon-ai/advanced-imessage/grpc";
import { pollEventMessage, pollEventStream } from "./poll-events.js";
import { gatewayInboundForMessage } from "./inbound-message.js";

const options = [{ optionIdentifier: "a", text: "Rice" }, { optionIdentifier: "b", text: "Noodles" }];
const event: PollEvent = {
  type: "poll.changed", sequence: 1, chatGuid: "any;-;peer@example.com", pollMessageGuid: "poll-1",
  occurredAt: new Date("2026-09-18T12:00:00Z"), isFromMe: false,
  delta: { type: "created", title: "Dinner?", options },
};
const allowed = new Set(["peer@example.com"]);
function fixture() {
  const spaces: string[][] = [];
  const reads: string[] = [];
  const client = { polls: { async get(id: string) {
    reads.push(id);
    return { chatGuid: event.chatGuid, pollMessageGuid: event.pollMessageGuid, title: "Dinner?", options, votes: [] };
  } } } as unknown as Parameters<typeof pollEventMessage>[2];
  const getSpace = async (id: string, phone: string) => {
    spaces.push([id, phone]);
    return { id } as Space;
  };
  return { client, getSpace, spaces, reads };
}

test("a native created event reaches the gateway without a message.received event or prior vote", async () => {
  const { client, getSpace, spaces, reads } = fixture();
  const result = await pollEventMessage(event, "bridge-line", client, allowed, getSpace);
  assert.ok(result);
  const [, message] = result;
  assert.equal(message.id, "poll-1");
  assert.equal(message.sender?.id, "peer@example.com");
  const inbound = await gatewayInboundForMessage(message, undefined, undefined, false);
  assert.match(String(inbound?.content), /Dinner\?\n1\. Rice\n2\. Noodles/);
  assert.deepEqual(spaces, [[event.chatGuid, "bridge-line"]]);
  assert.deepEqual(reads, []);
});

test("actorless DM vote and unvote events reach the gateway with the actual choice", async () => {
  for (const type of ["voted", "unvoted"] as const) {
    const { client, getSpace, reads } = fixture();
    const result = await pollEventMessage({ ...event, sequence: 2, delta: { type, optionIdentifier: "b" } },
      "bridge-line", client, allowed, getSpace);
    assert.ok(result);
    const inbound = await gatewayInboundForMessage(result[1], undefined, undefined, false);
    assert.match(String(inbound?.content), type === "voted" ? /选择了「Noodles」/ : /撤回了「Noodles」/);
    assert.doesNotMatch(String(inbound?.content), /imessage_vote_current_poll/);
    assert.deepEqual(reads, ["poll-1"]);
  }
});

test("native events enforce DM, allowlist and self-event filtering before looking up any data", async () => {
  const { client, getSpace, spaces, reads } = fixture();
  for (const change of [
    { isFromMe: true }, { chatGuid: "any;+;group" }, { chatGuid: "invalid" },
    { chatGuid: "any;-;stranger@example.com" },
    { actor: { address: "stranger@example.com" } },
    { actor: { address: "bridge-line" } },
  ]) {
    assert.equal(await pollEventMessage({ ...event, ...change } as PollEvent, "bridge-line", client, allowed, getSpace), undefined);
  }
  assert.deepEqual(spaces, []);
  assert.deepEqual(reads, []);
});

test("option additions preserve the original poll identity and expose the new choices", async () => {
  const { client, getSpace } = fixture();
  const result = await pollEventMessage({ ...event, sequence: 3,
    delta: { type: "optionAdded", title: "Dinner?", options: [...options, { optionIdentifier: "c", text: "Soup" }] },
  }, "bridge-line", client, allowed, getSpace);
  assert.ok(result);
  assert.equal(result[1].id, "poll-1:poll:3");
  const inbound = await gatewayInboundForMessage(result[1], undefined, undefined, false);
  assert.match(String(inbound?.content), /3\. Soup/);
});

test("vote events reject unrelated provider results and unknown choices", async () => {
  const { client, getSpace, spaces } = fixture();
  const vote: PollEvent = { ...event, delta: { type: "voted", optionIdentifier: "missing" } };
  await assert.rejects(pollEventMessage(vote, "bridge-line", client, allowed, getSpace), /unknown option/);
  client.polls.get = async () => ({ chatGuid: "another-chat", pollMessageGuid: "poll-1", title: "Dinner?", options, votes: [] });
  await assert.rejects(pollEventMessage(vote, "bridge-line", client, allowed, getSpace), /does not match/);
  assert.deepEqual(spaces, []);
});

test("the native poll stream replays a missed event after reconnect without repeating a live duplicate", async () => {
  const { client, getSpace } = fixture();
  let subscriptions = 0;
  const cursors: number[] = [];
  const second: PollEvent = { ...event, sequence: 2, delta: { type: "voted", optionIdentifier: "a" } };
  const third: PollEvent = { ...event, sequence: 3, delta: { type: "unvoted", optionIdentifier: "a" } };
  client.polls.subscribeEvents = () => stream<PollEvent>((emit, end) => {
    const round = ++subscriptions;
    void (async () => {
      if (round === 1) { await emit(event); end(); }
      else { await emit(second); await emit(third); }
    })();
  }) as ReturnType<typeof client.polls.subscribeEvents>;
  Object.assign(client, { events: { catchUp(cursor?: number) {
    cursors.push(cursor!);
    return Object.assign((async function* () {
      yield second;
      yield { type: "catchup.complete" as const, headSequence: 2 };
    })(), { async close() {} });
  } } });
  const source = pollEventStream("bridge-line", client,
    (value) => pollEventMessage(value, "bridge-line", client, allowed, getSpace));
  const ids: string[] = [];
  try {
    for await (const [, message] of source) {
      ids.push(message.id);
      if (ids.length === 3) break;
    }
  } finally { await source.close(); }
  assert.deepEqual(ids, ["poll-1", "poll-1:poll:2", "poll-1:poll:3"]);
  assert.deepEqual(cursors, [1]);
});
