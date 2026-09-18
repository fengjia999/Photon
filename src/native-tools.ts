import { poll, type Message } from "@spectrum-ts/core";
import type { CurrentPoll } from "./polls.js";
import { effect, imessage } from "@spectrum-ts/imessage";

import { splitBubbles } from "./bubbles.js";

export type PaceBubble = (
  conversationId: string,
  send: () => Promise<unknown>,
) => Promise<void>;

const sendImmediately: PaceBubble = async (_conversationId, send) => {
  await send();
};

export type EffectName =
  | "none"
  | "loud"
  | "slam"
  | "gentle"
  | "invisible"
  | "confetti"
  | "fireworks"
  | "balloons"
  | "heart"
  | "lasers"
  | "celebration"
  | "sparkles"
  | "spotlight"
  | "echo";

type TapbackName =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export type FrontendToolCall = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

export type FrontendToolResult = {
  result: string;
  sentReply: boolean;
};

export const messageEffects = {
  loud: imessage.effect.message.loud,
  slam: imessage.effect.message.slam,
  gentle: imessage.effect.message.gentle,
  invisible: imessage.effect.message.invisible,
  confetti: imessage.effect.message.confetti,
  fireworks: imessage.effect.message.fireworks,
  balloons: imessage.effect.message.balloons,
  heart: imessage.effect.message.heart,
  lasers: imessage.effect.message.lasers,
  celebration: imessage.effect.message.celebration,
  sparkles: imessage.effect.message.sparkles,
  spotlight: imessage.effect.message.spotlight,
  echo: imessage.effect.message.echo,
} as const;

const tapbacks: Record<TapbackName, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

const effectNames = ["none", ...Object.keys(messageEffects)] as const;

export const imessageFrontendTools = [
  {
    type: "function",
    function: {
      name: "imessage_send_poll",
      description: "Send a native poll in the current conversation. Supply a question and 2–10 distinct options. After success the poll is already visible; do not repeat it in ordinary text.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          options: { type: "array", minItems: 2, maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
        },
        required: ["title", "options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "imessage_vote_current_poll",
      description: "Cast the bridge account's native vote on the poll attached to the current incoming message. Use its numbered options (1-based). Cannot vote on arbitrary historical polls. After success the vote is visible; ordinary final text is not sent.",
      parameters: {
        type: "object",
        properties: { option_index: { type: "integer", minimum: 1 } },
        required: ["option_index"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "imessage_react_to_current_message",
      description: (
        "Add one native iMessage Tapback to the user's current message. " +
        "Use sparingly when a lightweight acknowledgement adds meaning. " +
        "A normal text answer may still follow."
      ),
      parameters: {
        type: "object",
        properties: {
          reaction: {
            type: "string",
            enum: Object.keys(tapbacks),
            description: "Native Tapback: love, like, dislike, laugh, emphasize, or question.",
          },
        },
        required: ["reaction"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "imessage_reply_to_current_message",
      description: (
        "Send the complete user-visible answer as native threaded iMessage replies " +
        "to the user's current message, optionally with an iMessage effect. Use this " +
        "only when threading or an effect is genuinely useful. After it succeeds, " +
        "do not repeat the answer in ordinary assistant text."
      ),
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The complete user-visible reply text.",
          },
          effect: {
            type: "string",
            enum: effectNames,
            description: "Optional native iMessage effect; default none.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
] as const;

function parseArguments(call: FrontendToolCall): Record<string, unknown> {
  const raw = call.function?.arguments ?? {};
  const parsed = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return parsed;
}

export async function executeIMessageFrontendTool(
  call: FrontendToolCall,
  message: Message,
  maxBubbleCharacters: number,
  paceBubble: PaceBubble = sendImmediately,
  currentPoll?: CurrentPoll,
): Promise<FrontendToolResult> {
  const name = String(call.function?.name || "");
  const input = parseArguments(call);

  if (name === "imessage_send_poll") {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const options = Array.isArray(input.options)
      ? input.options.map((value) => typeof value === "string" ? value.trim() : "") : [];
    if (!title || title.length > 200 || options.length < 2 || options.length > 10
      || options.some((value) => !value || value.length > 100) || new Set(options).size !== options.length) {
      throw new Error("poll requires a title (1–200 characters) and 2–10 distinct options (1–100 characters each)");
    }
    await paceBubble(message.space.id, () => message.space.send(poll(title, options)));
    return { result: JSON.stringify({ ok: true, action: "poll", title, options }), sentReply: true };
  }

  if (name === "imessage_vote_current_poll") {
    if (!currentPoll) throw new Error("no votable poll attached to the current message");
    const index = input.option_index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > currentPoll.options.length) {
      throw new Error("invalid poll option index");
    }
    await paceBubble(message.space.id, () => currentPoll.vote(index));
    return {
      result: JSON.stringify({ ok: true, action: "poll_vote", title: currentPoll.title, option_index: index, option: currentPoll.options[index - 1] }),
      sentReply: true,
    };
  }

  if (name === "imessage_react_to_current_message") {
    if (currentPoll || message.content?.type === "poll" || message.content?.type === "poll_option") {
      throw new Error("iMessage polls do not support Tapbacks; use voting or a plain text response");
    }
    const reaction = String(input.reaction || "") as TapbackName;
    const tapback = tapbacks[reaction];
    if (!tapback) throw new Error("unsupported Tapback");
    await message.react(tapback);
    return {
      result: JSON.stringify({
        ok: true,
        action: "tapback",
        reaction,
        glyph: tapback,
      }),
      sentReply: false,
    };
  }

  if (name === "imessage_reply_to_current_message") {
    if (currentPoll || message.content?.type === "poll" || message.content?.type === "poll_option") {
      throw new Error("iMessage polls do not support threaded replies; use a plain text response");
    }
    const text = String(input.text || "").trim();
    if (!text) throw new Error("reply text is required");
    if (text.length > 12000) throw new Error("reply text exceeds 12000 characters");
    const effectName = String(input.effect || "none") as EffectName;
    if (effectName !== "none" && !(effectName in messageEffects)) {
      throw new Error("unsupported iMessage effect");
    }
    const bubbles = splitBubbles(text, maxBubbleCharacters);
    for (let index = 0; index < bubbles.length; index += 1) {
      const bubble = bubbles[index];
      if (effectName === "none" || index > 0) {
        await paceBubble(message.space.id, () => message.reply(bubble));
      } else {
        await paceBubble(
          message.space.id,
          () => message.reply(effect(bubble, messageEffects[effectName])),
        );
      }
    }
    return {
      // Keep the result self-contained. The gateway persists it, so later turns
      // and proactive heartbeats can tell exactly what the user received.
      result: JSON.stringify({
        ok: true,
        action: "reply",
        text,
        bubbles: bubbles.length,
        effect: effectName,
      }),
      sentReply: true,
    };
  }

  throw new Error(`unsupported frontend tool: ${name || "<missing>"}`);
}
