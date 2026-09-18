import type { Content, Message } from "@spectrum-ts/core";
import sharp from "sharp";
import type { CurrentPoll } from "./polls.js";

export type GatewayUserContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

export type GatewayInbound = {
  content: GatewayUserContent;
  sourceMessage: Message;
};

const PASSTHROUGH_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const CONVERTIBLE_IMAGE_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/x-heic",
  "image/x-heif",
  "image/tiff",
]);
const MAX_IMAGES_PER_MESSAGE = 4;

const conversationTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  hourCycle: "h23",
});

function withConversationPrefix(content: GatewayUserContent, now: Date, timeEnabled: boolean): GatewayUserContent {
  const parts = Object.fromEntries(
    conversationTimeFormatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  const time = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.weekday}`;
  const prefix = timeEnabled
    ? `<conversation_path="iMessage" current_time="${time}" />`
    : '<conversation_path="iMessage" />';
  return typeof content === "string"
    ? `${prefix}\n${content}`
    : [{ type: "text", text: prefix }, ...content];
}

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

function normalizedMimeType(mimeType: string, name: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (normalized !== "application/octet-stream") return normalized;
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return normalized;
}

async function imageBlock(
  content: Extract<Content, { type: "attachment" }>,
  maxImageBytes: number,
): Promise<{ type: "image_url"; image_url: { url: string } } | null> {
  let mimeType = normalizedMimeType(content.mimeType, content.name);
  if (!PASSTHROUGH_IMAGE_MIMES.has(mimeType) && !CONVERTIBLE_IMAGE_MIMES.has(mimeType)) {
    return null;
  }
  if (content.size !== undefined && content.size > maxImageBytes) {
    throw new Error(`image exceeds ${maxImageBytes} bytes`);
  }

  let bytes = await content.read();
  if (bytes.length > maxImageBytes) throw new Error(`image exceeds ${maxImageBytes} bytes`);
  if (CONVERTIBLE_IMAGE_MIMES.has(mimeType)) {
    bytes = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    mimeType = "image/jpeg";
    if (bytes.length > maxImageBytes) {
      throw new Error(`converted image exceeds ${maxImageBytes} bytes`);
    }
  }

  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
  };
}

async function imageContentForMessage(
  message: Message,
  maxImageBytes: number,
): Promise<GatewayUserContent | null> {
  const messages = message.content.type === "group" ? message.content.items : [message];
  const blocks: Exclude<GatewayUserContent, string> = [];
  let imageCount = 0;

  for (const item of messages) {
    if (item.content.type === "text") {
      if (item.content.text.trim()) blocks.push({ type: "text", text: item.content.text });
      continue;
    }
    if (item.content.type !== "attachment" || imageCount >= MAX_IMAGES_PER_MESSAGE) continue;
    const image = await imageBlock(item.content, maxImageBytes);
    if (!image) continue;
    blocks.push(image);
    imageCount += 1;
  }

  if (!imageCount) return null;
  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: "用户从 iMessage 发来图片。" });
  }
  return blocks;
}

export async function gatewayInboundForMessage(
  message: Message,
  maxImageBytes = 5 * 1024 * 1024,
  now = new Date(),
  timeEnabled = true,
  currentPoll?: CurrentPoll,
): Promise<GatewayInbound | null> {
  if (currentPoll || message.content.type === "poll") {
    const title = currentPoll?.title ?? (message.content as Extract<Content, { type: "poll" }>).title;
    const options = currentPoll?.options ?? (message.content as Extract<Content, { type: "poll" }>).options.map((item) => item.title);
    const text = `[iMessage 投票]\n${title}\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`
      + (currentPoll ? "\n可调用 imessage_vote_current_poll，使用以上选项编号投票。" : "\n当前消息没有可用的原生投票接口，请用文字回答。")
      + "\n投票不支持 Tapback 或引用回复。";
    return { content: withConversationPrefix(text, now, timeEnabled), sourceMessage: message };
  }
  if (message.content.type === "poll_option") {
    const { poll, option, selected } = message.content;
    const text = `[iMessage 投票更新]\n用户在「${poll.title}」中${selected ? "选择了" : "撤回了"}「${option.title}」。\n这是选项变动事件，不代表完整投票结果；如需回应，请使用普通文字。`;
    return { content: withConversationPrefix(text, now, timeEnabled), sourceMessage: message };
  }
  if (message.content.type === "text") {
    return { content: withConversationPrefix(message.content.text, now, timeEnabled), sourceMessage: message };
  }
  if (message.content.type === "reaction") {
    const target = message.content.target;
    const emoji = compact(message.content.emoji, 16) || "Tapback";
    const targetSummary = summarizeContent(target.content);
    return {
      content: withConversationPrefix(
        `[iMessage Tapback]\n`
        + `用户对你之前的消息「${targetSummary}」添加了 ${emoji}。`,
        now,
        timeEnabled,
      ),
      sourceMessage: target,
    };
  }
  if (message.content.type === "attachment" || message.content.type === "group") {
    const content = await imageContentForMessage(message, maxImageBytes);
    return content ? { content: withConversationPrefix(content, now, timeEnabled), sourceMessage: message } : null;
  }
  return null;
}
