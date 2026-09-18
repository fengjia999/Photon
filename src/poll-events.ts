import { mergeStreams, type ManagedStream, type Message, type Space, type Spectrum } from "@spectrum-ts/core";
import { resumableOrderedStream, type CloseableAsyncIterable } from "@spectrum-ts/core/authoring";
import { imessage } from "@spectrum-ts/imessage";
import type { AdvancedIMessage, CatchUpEvent, PollEvent } from "@photon-ai/advanced-imessage/grpc";

type PollClient = Pick<AdvancedIMessage, "polls" | "events">;
type Inbound = [Space, Message];
const normalize = (value: string) => value.trim().toLowerCase();

// Spectrum 12.8 drops created/optionAdded events and requires an actor on votes.
// In a DM the peer can be recovered from the chat GUID when Photon omits actor.
export async function pollEventMessage(
  event: PollEvent,
  phone: string,
  client: PollClient,
  allowedUsers: ReadonlySet<string>,
  getSpace: (id: string, phone: string) => Promise<Space>,
): Promise<Inbound | undefined> {
  const peer = /^[^;]+;-;(.+)$/.exec(event.chatGuid)?.[1];
  if (!peer || event.isFromMe) return;
  const sender = normalize(event.actor?.address || peer);
  if (sender === normalize(phone) || !allowedUsers.has(sender)) return;
  const delta = event.delta;
  let content: Message["content"];
  if (delta.type === "created" || delta.type === "optionAdded") {
    content = { type: "poll", title: delta.title, options: delta.options.map(({ text }) => ({ title: text })) };
  } else {
    const poll = await client.polls.get(event.pollMessageGuid);
    if (poll.chatGuid !== event.chatGuid || poll.pollMessageGuid !== event.pollMessageGuid) {
      throw new Error("poll event does not match its conversation or message");
    }
    const choice = poll.options.find((option) => option.optionIdentifier === delta.optionIdentifier);
    if (!choice) throw new Error("poll event refers to an unknown option");
    content = {
      type: "poll_option", title: choice.text, option: { title: choice.text },
      selected: delta.type === "voted",
      poll: { type: "poll", title: poll.title, options: poll.options.map(({ text }) => ({ title: text })) },
    };
  }
  const space = await getSpace(event.chatGuid, phone);
  const message = {
    platform: "imessage", direction: "inbound", space,
    id: delta.type === "created" ? event.pollMessageGuid : `${event.pollMessageGuid}:poll:${event.sequence}`,
    parentId: event.pollMessageGuid,
    sender: { id: sender, address: sender }, timestamp: event.occurredAt, content,
    async reply() { throw new Error("polls do not support threaded replies"); },
    async react() { throw new Error("polls do not support Tapbacks"); },
  } as unknown as Message;
  console.log(`[poll] received event=${delta.type} sequence=${event.sequence} actor=${event.actor?.address ? "present" : "dm-peer"}`);
  return [space, message];
}

export function pollEventStream(
  phone: string,
  client: PollClient,
  map: (event: PollEvent) => Promise<Inbound | undefined>,
): ManagedStream<Inbound> {
  const process = async (event: PollEvent) => {
    const message = await map(event);
    return { cursor: String(event.sequence), id: `${phone}:${event.sequence}`, values: message ? [message] : [] };
  };
  return resumableOrderedStream<PollEvent, CatchUpEvent, Inbound>({
    label: "bridge.polls",
    subscribeLive(cursor) {
      const source = client.polls.subscribeEvents();
      const filtered: CloseableAsyncIterable<PollEvent> = {
        close: () => source.close(),
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of source) {
              if (cursor === undefined || event.sequence > Number(cursor)) yield event;
            }
          } finally { await source.close(); }
        },
      };
      return filtered;
    },
    async *fetchMissed(cursor) {
      const source = client.events.catchUp(Number(cursor));
      try {
        for await (const event of source) {
          if (event.type === "poll.changed" || event.type === "catchup.complete") yield event;
        }
      } finally { await source.close(); }
    },
    processLive: process,
    async processMissed(event) {
      if (event.type === "poll.changed") return process(event);
      return { cursor: event.type === "catchup.complete" ? String(event.headSequence) : undefined,
        id: "catchup.complete", values: [] };
    },
    isCursorRejectedError: (error) => (error as { code?: string })?.code === "invalidArgument",
  });
}

export function bridgeInboundMessages(
  app: Awaited<ReturnType<typeof Spectrum>>,
  allowedUsers: ReadonlySet<string>,
): ManagedStream<Inbound> {
  const clients = app.__internal.platforms.get("imessage")?.client;
  if (!Array.isArray(clients)) throw new Error("iMessage poll runtime unavailable");
  const streams: ManagedStream<Inbound>[] = clients.map((entry: { phone: string; client: PollClient }) => {
    if (typeof entry.client.polls?.subscribeEvents !== "function") throw new Error("iMessage poll event API unavailable");
    return pollEventStream(entry.phone, entry.client, (event) => pollEventMessage(event, entry.phone, entry.client,
      allowedUsers, (id, phone) => imessage(app).space.get(id, { phone })));
  });
  const source = app.messages;
  const iterator = source[Symbol.asyncIterator]();
  streams.push({
    async close() { await iterator.return?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const [space, message] = next.value;
        // The native subscription owns vote deltas, avoiding duplicate turns.
        if (message.platform === "imessage" && message.content.type === "poll_option") continue;
        yield [space, message];
      }
    },
  });
  return mergeStreams(streams);
}
