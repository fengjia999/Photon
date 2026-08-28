import type { Content, Message } from "@spectrum-ts/core";
import sharp from "sharp";

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
): Promise<GatewayInbound | null> {
  if (message.content.type === "text") {
    return { content: message.content.text, sourceMessage: message };
  }
  if (message.content.type === "reaction") {
    const target = message.content.target;
    const emoji = compact(message.content.emoji, 16) || "Tapback";
    const targetSummary = summarizeContent(target.content);
    return {
      content: (
        `[iMessage Tapback]\n`
        + `用户对你之前的消息「${targetSummary}」添加了 ${emoji}。`
      ),
      sourceMessage: target,
    };
  }
  if (message.content.type === "attachment" || message.content.type === "group") {
    const content = await imageContentForMessage(message, maxImageBytes);
    return content ? { content, sourceMessage: message } : null;
  }
  return null;
}
