import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@spectrum-ts/core";
import { currentPoll, loadCurrentPoll, type NativePoll } from "./polls.js";
import { gatewayInboundForMessage } from "./inbound-message.js";
import { executeIMessageFrontendTool } from "./native-tools.js";

test("votes resolve numbered choices to native IDs and reject stale or cross-chat polls", async () => {
  const poll: NativePoll = { chatGuid: "chat-1", pollMessageGuid: "poll-1", title: "Dinner?", options: [
    { optionIdentifier: "rice-id", text: "Rice" }, { optionIdentifier: "noodle-id", text: "Noodles" },
  ] };
  let latest = poll;
  const votes: string[][] = [];
  const client = { async get() { return latest; }, async vote(id: string, option: string) { votes.push([id, option]); return latest; } };
  assert.throws(() => currentPoll(client, poll, "another-chat"), /another conversation/);
  const context = currentPoll(client, poll, "chat-1");
  await context.vote(2);
  assert.deepEqual(votes, [["poll-1", "noodle-id"]]);
  await assert.rejects(context.vote(0), /invalid/);
  latest = { ...poll, chatGuid: "another-chat" };
  await assert.rejects(context.vote(1), /poll changed/);
  latest = { ...poll, options: [{ optionIdentifier: "rice-id", text: "Changed choice" }] };
  await assert.rejects(context.vote(1), /poll changed/);
  assert.equal(votes.length, 1);
});

test("incoming poll hydration uses the matching iMessage line and native parent ID", async () => {
  const requested: string[] = [];
  const poll: NativePoll = { chatGuid: "chat-1", pollMessageGuid: "parent-poll", title: "", options: [
    { optionIdentifier: "a", text: "A" }, { optionIdentifier: "b", text: "B" },
  ] };
  let failure: Error | undefined;
  const client = { polls: { async get(id: string) { requested.push(id); if (failure) throw failure; return poll; }, async vote() { return poll; } } };
  const app = { __internal: { platforms: new Map([["imessage", { client: [
    { phone: "other-line", client: { polls: { get() { throw new Error("wrong account"); } } } },
    { phone: "our-line", client },
  ] }]]) } } as unknown as Parameters<typeof loadCurrentPoll>[0];
  const message = { platform: "imessage", sender: { id: "sender" }, id: "part-id", parentId: "parent-poll", content: { type: "custom", raw: {} },
    space: { __platform: "imessage", async send() {}, id: "chat-1", phone: "our-line" } } as unknown as Message;
  const context = await loadCurrentPoll(app, message);
  assert.deepEqual(requested, ["parent-poll"]);
  assert.equal(context?.title, "未命名投票");
  assert.deepEqual(context?.options, ["A", "B"]);
  failure = Object.assign(new Error("not a poll"), { code: "pollNotFound" });
  assert.equal(await loadCurrentPoll(app, message), undefined);
  failure = new Error("network failed");
  await assert.rejects(loadCurrentPoll(app, message), /network failed/);
  message.content = { type: "text", text: "ordinary message" };
  assert.equal(await loadCurrentPoll(app, message), undefined);
});

const definition: NativePoll = {
  chatGuid: "chat-1", pollMessageGuid: "poll-1", title: "Dinner?",
  options: [{ optionIdentifier: "rice", text: "Rice" }, { optionIdentifier: "noodles", text: "Noodles" }],
};

function hydrationFixture(clients?: unknown) {
  const requests: string[] = [];
  const votes: string[][] = [];
  const client = {
    async get(id: string) { requests.push(id); return definition; },
    async vote(id: string, option: string) { votes.push([id, option]); return definition; },
  };
  const app = { __internal: { platforms: new Map([["imessage", {
    client: clients ?? [{ phone: "our-line", client: { polls: client } }],
  }]]) } } as unknown as Parameters<typeof loadCurrentPoll>[0];
  const message = {
    platform: "imessage", sender: { id: "sender" }, id: "poll-1",
    content: { type: "custom", raw: {} },
    space: { __platform: "imessage", id: "chat-1", phone: "our-line", async send() {} },
  } as unknown as Message;
  return { app, message, requests, votes, client };
}

test("balloon metadata on vote events must not replace the vote/unvote delta with a votable card", async () => {
  for (const selected of [true, false]) {
    const { app, message, requests, votes } = hydrationFixture();
    message.content = {
      type: "poll_option", title: "Rice", option: { title: "Rice" }, selected,
      poll: { type: "poll", title: "Dinner?", options: [{ title: "Rice" }, { title: "Noodles" }] },
    };
    Object.assign(message, { balloonBundleId: "com.apple.messages.Polls", parentId: "poll-1" });
    const context = await loadCurrentPoll(app, message);
    assert.equal(context, undefined);
    const inbound = await gatewayInboundForMessage(message, undefined, undefined, false, context);
    assert.match(String(inbound?.content), selected ? /选择了「Rice」/ : /撤回了「Rice」/);
    assert.doesNotMatch(String(inbound?.content), /imessage_vote_current_poll/);
    assert.equal(inbound?.sourceMessage, message);
    assert.deepEqual(requests, []);
    assert.deepEqual(votes, []);
  }
});

test("hydration rejects a different poll in the same chat before offering voting", async () => {
  for (const parentId of [undefined, "parent-poll"]) {
    const { app, message, client, votes } = hydrationFixture();
    Object.assign(message, { parentId });
    client.get = async () => ({ ...definition, pollMessageGuid: "unrelated-poll" });
    await assert.rejects(loadCurrentPoll(app, message), /poll.*match.*message/);
    assert.deepEqual(votes, []);
  }
});

test("the choice shown to the gateway retains its native identity through the voting tool", async () => {
  const { app, message, client, votes } = hydrationFixture();
  const context = await loadCurrentPoll(app, message);
  const inbound = await gatewayInboundForMessage(message, undefined, undefined, false, context);
  assert.match(String(inbound?.content), /1\. Rice\n2\. Noodles/);
  client.get = async () => ({ ...definition, options: [...definition.options].reverse() });
  const call = { id: "vote", function: {
    name: "imessage_vote_current_poll", arguments: '{"option_index":2}',
  } };
  const result = await executeIMessageFrontendTool(call, message, 3000, undefined, context);
  assert.deepEqual(votes, [["poll-1", "noodles"]]);
  assert.equal(result.sentReply, true);
  assert.equal(JSON.parse(result.result).option, "Noodles");

  client.get = async () => ({ ...definition, options: [definition.options[0]] });
  await assert.rejects(executeIMessageFrontendTool(call, message, 3000, undefined, context), /poll changed/);
  assert.deepEqual(votes, [["poll-1", "noodles"]]);
});

test("hydration without a parent uses the message ID and its authenticated client for voting", async () => {
  const { app, message, requests, votes } = hydrationFixture();
  const context = await loadCurrentPoll(app, message);
  assert.ok(context);
  await context.vote(1);
  assert.deepEqual(requests, ["poll-1", "poll-1"]);
  assert.deepEqual(votes, [["poll-1", "rice"]]);
});

test("typed polls and balloon placeholders hydrate, ordinary messages do not access the runtime", async () => {
  const { app, message, requests } = hydrationFixture();
  message.content = { type: "poll", title: "placeholder", options: [{ title: "A" }, { title: "B" }] };
  assert.equal((await loadCurrentPoll(app, message))?.title, "Dinner?");
  message.content = { type: "text", text: "placeholder" };
  Object.assign(message, { balloonBundleId: "native-balloon" });
  assert.equal((await loadCurrentPoll(app, message))?.title, "Dinner?");
  assert.equal(requests.length, 2);
  delete (message as unknown as { balloonBundleId?: string }).balloonBundleId;
  app.__internal.platforms.clear();
  assert.equal(await loadCurrentPoll(app, message), undefined);
});

test("missing runtime, wrong line, and incomplete poll APIs fail without using another account", async () => {
  for (const clients of [{}, [], [{ phone: "other-line", client: { polls: {
    get() { assert.fail("must not access another line"); }, vote() { assert.fail("must not vote"); },
  } } }], [{ phone: "our-line", client: { polls: { async get() { return definition; } } } }]]) {
    const { app, message } = hydrationFixture(clients);
    await assert.rejects(loadCurrentPoll(app, message), /poll (runtime|API) unavailable/);
  }
  const { app, message } = hydrationFixture();
  app.__internal.platforms.clear();
  await assert.rejects(loadCurrentPoll(app, message), /runtime unavailable/);
});

test("hydration ignores only explicit not-found errors and rejects cross-chat definitions", async () => {
  const { app, message, client } = hydrationFixture();
  for (const code of ["notFound", "pollNotFound"]) {
    client.get = async () => { throw Object.assign(new Error("missing"), { code }); };
    assert.equal(await loadCurrentPoll(app, message), undefined);
  }
  const denied = Object.assign(new Error("denied"), { code: "permissionDenied" });
  client.get = async () => { throw denied; };
  await assert.rejects(loadCurrentPoll(app, message), (error) => error === denied);
  client.get = async () => ({ ...definition, chatGuid: "other-chat" });
  await assert.rejects(loadCurrentPoll(app, message), /another conversation/);
});

test("invalid indices never contact Photon; replaced or removed choices never cast a vote", async () => {
  const { client, requests, votes } = hydrationFixture();
  const context = currentPoll(client, definition, "chat-1");
  for (const index of [-1, 0, 3, 1.5, NaN, Infinity]) {
    await assert.rejects(context.vote(index), /invalid poll option index/);
  }
  assert.deepEqual(requests, []);
  for (const latest of [
    { ...definition, pollMessageGuid: "other-poll" },
    { ...definition, options: [definition.options[1]] },
    { ...definition, options: [{ optionIdentifier: "new-id", text: "Rice" }] },
  ]) {
    client.get = async () => latest;
    await assert.rejects(context.vote(1), /poll changed/);
  }
  assert.deepEqual(votes, []);
});

test("reordered choices preserve native identity and provider failures propagate", async () => {
  const { client, votes } = hydrationFixture();
  const context = currentPoll(client, definition, "chat-1");
  client.get = async () => ({ ...definition, options: [...definition.options].reverse() });
  await context.vote(1);
  assert.deepEqual(votes, [["poll-1", "rice"]]);
  const unavailable = new Error("Photon unavailable");
  client.get = async () => { throw unavailable; };
  await assert.rejects(context.vote(2), (error) => error === unavailable);
  assert.equal(votes.length, 1);
  client.get = async () => definition;
  client.vote = async () => { throw unavailable; };
  await assert.rejects(context.vote(2), (error) => error === unavailable);
});
