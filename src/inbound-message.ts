import type { Content, Message } from "@spectrum-ts/core";

export type GatewayInbound = {
  text: string;
  sourceMessage: Message;
};

function compact(value: string, maxCharacters = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxCharacters) return normalized;
  return `${characters.slice(0, maxCharacters).join("")}…`;
}

function summarizeContent(content: Content): string {
  switch (content.type) {
    case "text":
      return compact(content.text) || "[空消息]";
    case "markdown":
      return compact(content.markdown) || "[空消息]";
    case "attachment":
      return content.name ? `[附件：${compact(content.name, 80)}]` : "[附件]";
    case "voice":
      return "[语音消息]";
    case "contact":
      return "[联系人]";
    case "group":
      return "[组合消息]";
    default:
      return `[${content.type}]`;
  }
}

export function gatewayInboundForMessage(message: Message): GatewayInbound | null {
  if (message.content.type === "text") {
    return { text: message.content.text, sourceMessage: message };
  }
  if (message.content.type === "reaction") {
    const target = message.content.target;
    const emoji = compact(message.content.emoji, 16) || "Tapback";
    const targetSummary = summarizeContent(target.content);
    return {
      text: (
        `[iMessage Tapback]\n`
        + `用户对你之前的消息「${targetSummary}」添加了 ${emoji}。`
      ),
      sourceMessage: target,
    };
  }
  return null;
}

