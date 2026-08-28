import assert from "node:assert/strict";
import test from "node:test";

import { readGatewayStream } from "./gateway-stream.js";

function streamedResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("gateway stream separates public reasoning from final content", async () => {
  const response = streamedResponse([
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先检查\"}}]}\n",
    "\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"约束。\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"最终回答\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
  ]);

  const result = await readGatewayStream(response);

  assert.equal(result.reasoningContent, "先检查约束。");
  assert.equal(result.assistant.content, "最终回答");
  assert.equal(result.finishReason, "stop");
});

test("gateway stream rebuilds frontend tool calls and continuation metadata", async () => {
  const response = streamedResponse([
    "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"summary\"}],",
    "\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",",
    "\"function\":{\"name\":\"imessage_\",\"arguments\":\"{\\\"reaction\\\":\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,",
    "\"function\":{\"name\":\"react_to_current_message\",\"arguments\":\"\\\"like\\\"}\"}}]}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
    "data: [DONE]\n\n",
  ]);

  const result = await readGatewayStream(response);

  assert.deepEqual(result.assistant.reasoning_details, [{ type: "summary" }]);
  assert.deepEqual(result.assistant.tool_calls, [{
    id: "call-1",
    type: "function",
    function: {
      name: "imessage_react_to_current_message",
      arguments: "{\"reaction\":\"like\"}",
    },
  }]);
});
