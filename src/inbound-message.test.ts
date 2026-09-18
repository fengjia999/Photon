import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@spectrum-ts/core";
import sharp from "sharp";

import { gatewayInboundForMessage } from "./inbound-message.js";

const now = new Date("2026-09-18T04:47:05Z");
const prefix = '<conversation_path="iMessage" current_time="2026-09-18 12:47:05 星期五" />';

function fakeMessage(content: Message["content"]): Message {
  return { content } as Message;
}

test("disabling time keeps the conversation marker on text and Tapbacks", async () => {
  const message = fakeMessage({ type: "text", text: "hello" });
  const inbound = await gatewayInboundForMessage(message, undefined, now, false);
  assert.equal(inbound?.content, '<conversation_path="iMessage" />\nhello');
  const reaction = fakeMessage({ type: "reaction", emoji: "👍", target: message });
  const tapback = await gatewayInboundForMessage(reaction, undefined, now, false);
  assert.match(String(tapback?.content), /^<conversation_path="iMessage" \/>\n\[iMessage Tapback\]/);
  assert.doesNotMatch(String(tapback?.content), /current_time/);
});

test("plain text includes Shanghai time down to seconds and weekday", async () => {
  const message = fakeMessage({ type: "text", text: "hello" });
  const inbound = await gatewayInboundForMessage(message, undefined, now);

  assert.equal(inbound?.content, `${prefix}\nhello`);
  assert.equal(inbound?.sourceMessage, message);
});

test("Shanghai midnight rolls over both the date and weekday using hour 00", async () => {
  const message = fakeMessage({ type: "text", text: "午夜" });
  const inbound = await gatewayInboundForMessage(message, undefined, new Date("2026-09-18T16:00:09Z"));
  assert.equal(inbound?.content,
    '<conversation_path="iMessage" current_time="2026-09-19 00:00:09 星期六" />\n午夜');
});

test("Tapback becomes a gateway event targeting the reacted-to message", async () => {
  const target = fakeMessage({ type: "text", text: "one\n two" });
  const reaction = fakeMessage({ type: "reaction", emoji: "❤️", target });
  const inbound = await gatewayInboundForMessage(reaction, undefined, now);

  assert.equal(
    inbound?.content,
    `${prefix}\n[iMessage Tapback]\n用户对你之前的消息「one two」添加了 ❤️。`,
  );
  assert.equal(inbound?.sourceMessage, target);
});

test("Tapback describes an attachment without reading it", async () => {
  const target = fakeMessage({
    type: "attachment",
    id: "attachment-1",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    async read() {
      throw new Error("not used");
    },
    async stream() {
      throw new Error("not used");
    },
  });
  const reaction = fakeMessage({ type: "reaction", emoji: "👍", target });

  const inbound = await gatewayInboundForMessage(reaction);
  assert.match(String(inbound?.content || ""), /附件：photo\.jpg/);
});

test("image attachment becomes an OpenAI data URL block", async () => {
  const message = fakeMessage({
    type: "attachment",
    id: "attachment-2",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 3,
    async read() {
      return Buffer.from("abc");
    },
    async stream() {
      throw new Error("not used");
    },
  });

  const inbound = await gatewayInboundForMessage(message, undefined, now);
  assert.deepEqual(inbound?.content, [
    { type: "text", text: prefix },
    { type: "text", text: "用户从 iMessage 发来图片。" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } },
  ]);
});

test("caption and image in a group stay in the same gateway turn", async () => {
  const caption = fakeMessage({ type: "text", text: "看看这个" });
  const image = fakeMessage({
    type: "attachment",
    id: "attachment-3",
    name: "shot.png",
    mimeType: "image/png",
    async read() {
      return Buffer.from("png");
    },
    async stream() {
      throw new Error("not used");
    },
  });
  const message = fakeMessage({ type: "group", items: [caption, image] });

  assert.deepEqual((await gatewayInboundForMessage(message, undefined, now))?.content, [
    { type: "text", text: prefix },
    { type: "text", text: "看看这个" },
    { type: "image_url", image_url: { url: "data:image/png;base64,cG5n" } },
  ]);
});

test("HEIC-like image input is converted to a JPEG data URL", async () => {
  const source = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#ff00aa" },
  }).png().toBuffer();
  const message = fakeMessage({
    type: "attachment",
    id: "attachment-4",
    name: "photo.heic",
    mimeType: "image/heic",
    size: source.length,
    async read() {
      return source;
    },
    async stream() {
      throw new Error("not used");
    },
  });

  const inbound = await gatewayInboundForMessage(message);
  assert.match(JSON.stringify(inbound?.content), /data:image\/jpeg;base64,/);
});
