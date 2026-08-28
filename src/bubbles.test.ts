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

test("long lines split without breaking emoji graphemes", () => {
  assert.deepEqual(splitBubbles("👨‍👩‍👧‍👦AB", 2), ["👨‍👩‍👧‍👦A", "B"]);
});
