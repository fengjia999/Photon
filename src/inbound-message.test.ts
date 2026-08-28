import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@spectrum-ts/core";
import sharp from "sharp";

import { gatewayInboundForMessage } from "./inbound-message.js";

function fakeMessage(content: Message["content"]): Message {
  return { content } as Message;
}

test("plain text remains a normal gateway prompt", async () => {
  const message = fakeMessage({ type: "text", text: "hello" });
  const inbound = await gatewayInboundForMessage(message);

  assert.equal(inbound?.content, "hello");
  assert.equal(inbound?.sourceMessage, message);
});

test("Tapback becomes a gateway event targeting the reacted-to message", async () => {
  const target = fakeMessage({ type: "text", text: "one\n two" });
  const reaction = fakeMessage({ type: "reaction", emoji: "❤️", target });
  const inbound = await gatewayInboundForMessage(reaction);

  assert.equal(
    inbound?.content,
    "[iMessage Tapback]\n用户对你之前的消息「one two」添加了 ❤️。",
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

  const inbound = await gatewayInboundForMessage(message);
  assert.deepEqual(inbound?.content, [
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

  assert.deepEqual((await gatewayInboundForMessage(message))?.content, [
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
