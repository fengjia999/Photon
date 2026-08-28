import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@spectrum-ts/core";

import { gatewayInboundForMessage } from "./inbound-message.js";

function fakeMessage(content: Message["content"]): Message {
  return { content } as Message;
}

test("plain text remains a normal gateway prompt", () => {
  const message = fakeMessage({ type: "text", text: "hello" });
  const inbound = gatewayInboundForMessage(message);

  assert.equal(inbound?.text, "hello");
  assert.equal(inbound?.sourceMessage, message);
});

test("Tapback becomes a gateway event targeting the reacted-to message", () => {
  const target = fakeMessage({ type: "text", text: "one\n two" });
  const reaction = fakeMessage({ type: "reaction", emoji: "❤️", target });
  const inbound = gatewayInboundForMessage(reaction);

  assert.equal(
    inbound?.text,
    "[iMessage Tapback]\n用户对你之前的消息「one two」添加了 ❤️。",
  );
  assert.equal(inbound?.sourceMessage, target);
});

test("Tapback describes an attachment without reading it", () => {
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

  assert.match(gatewayInboundForMessage(reaction)?.text || "", /附件：photo\.jpg/);
});

