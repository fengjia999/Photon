import assert from "node:assert/strict";
import test from "node:test";

import { splitBubbles } from "./bubbles.js";

test("each non-empty line becomes one bubble", () => {
  assert.deepEqual(splitBubbles("第一行\n第二行\n\n第四行"), [
    "第一行",
    "第二行",
    "第四行",
  ]);
});

test("CRLF and CR are normalized", () => {
  assert.deepEqual(splitBubbles("one\r\ntwo\rthree"), ["one", "two", "three"]);
});

test("Chinese commas and periods each end a bubble", () => {
  assert.deepEqual(splitBubbles("你好，今天很可爱。真的"), [
    "你好，",
    "今天很可爱。",
    "真的",
  ]);
});

test("English commas and periods split at word boundaries", () => {
  assert.deepEqual(splitBubbles("Hello, world. Done"), ["Hello,", "world.", "Done"]);
});

test("periods inside URLs and decimals do not break them", () => {
  assert.deepEqual(splitBubbles("打开 https://example.com 看，数值 3.14。"), [
    "打开 https://example.com 看，",
    "数值 3.14。",
  ]);
});

test("consecutive punctuation stays on the same bubble", () => {
  assert.deepEqual(splitBubbles("嗯...好吧。"), ["嗯...", "好吧。"]);
});

test("long lines split without breaking emoji graphemes", () => {
  assert.deepEqual(splitBubbles("👨‍👩‍👧‍👦AB", 2), ["👨‍👩‍👧‍👦A", "B"]);
});
