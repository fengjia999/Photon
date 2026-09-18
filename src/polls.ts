import type { Message, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

export type NativePoll = {
  chatGuid: string;
  pollMessageGuid: string;
  title: string;
  options: readonly { optionIdentifier: string; text: string }[];
};
type PollClient = {
  get(id: string): Promise<NativePoll>;
  vote(id: string, optionId: string): Promise<NativePoll>;
};
export type CurrentPoll = {
  title: string;
  options: string[];
  vote(optionIndex: number): Promise<void>;
};

export function currentPoll(client: PollClient, poll: NativePoll, chatId: string): CurrentPoll {
  if (poll.chatGuid !== chatId) throw new Error("poll belongs to another conversation");
  return {
    title: poll.title || "未命名投票",
    options: poll.options.map((option) => option.text),
    async vote(optionIndex) {
      if (!Number.isInteger(optionIndex) || optionIndex < 1 || optionIndex > poll.options.length) {
        throw new Error("invalid poll option index");
      }
      const option = poll.options[optionIndex - 1];
      const latest = await client.get(poll.pollMessageGuid);
      if (latest.chatGuid !== chatId || latest.pollMessageGuid !== poll.pollMessageGuid
        || !latest.options.some((item) => item.optionIdentifier === option.optionIdentifier && item.text === option.text)) {
        throw new Error("poll changed; cannot safely vote for this option");
      }
      await client.vote(poll.pollMessageGuid, option.optionIdentifier);
    },
  };
}

// Spectrum 12.8 exposes sending polls but not voting or inbound poll definitions.
// Keep the version-specific runtime access here and reuse its authenticated clients.
export async function loadCurrentPoll(
  app: Awaited<ReturnType<typeof Spectrum>>,
  message: Message,
): Promise<CurrentPoll | undefined> {
  // Vote changes are deltas, even when they carry the poll's balloon metadata.
  if (message.content.type === "poll_option") return;
  const native = imessage(message);
  if (message.content.type !== "custom" && !native.balloonBundleId && message.content.type !== "poll") return;
  const runtime = app.__internal.platforms.get("imessage");
  const clients = runtime?.client;
  if (!Array.isArray(clients)) throw new Error("iMessage poll runtime unavailable");
  const entry = clients.find((item) => item.phone === imessage(message.space).phone);
  const client = entry?.client?.polls as PollClient | undefined;
  if (!client || typeof client.get !== "function" || typeof client.vote !== "function") {
    throw new Error("iMessage poll API unavailable");
  }
  const pollId = native.parentId || message.id;
  let poll: NativePoll;
  try {
    poll = await client.get(pollId);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "pollNotFound" || code === "notFound") return;
    throw error;
  }
  if (poll.pollMessageGuid !== pollId) throw new Error("poll does not match the current message");
  return currentPoll(client, poll, message.space.id);
}
