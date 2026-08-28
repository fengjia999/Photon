import type { FrontendToolCall } from "./native-tools.js";

export type GatewayAssistantMessage = {
  role: "assistant";
  content: string;
  tool_calls?: FrontendToolCall[];
  reasoning_content?: string;
  reasoning_details?: unknown[];
};

export type GatewayStreamTurn = {
  assistant: GatewayAssistantMessage;
  finishReason: string;
  reasoningContent: string;
};

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dataFromEvent = (event: string): string => event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = dataFromEvent(event);
        if (data) yield data;
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) break;
    }
    const trailing = dataFromEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

export async function readGatewayStream(response: Response): Promise<GatewayStreamTurn> {
  if (!response.body) throw new Error("Memory Gateway returned an empty stream");

  let content = "";
  let reasoningContent = "";
  let finishReason = "";
  const reasoningDetails: unknown[] = [];
  const toolCalls = new Map<number, Required<FrontendToolCall>>();

  for await (const data of readSseData(response.body)) {
    if (data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (chunk.error) {
      const error = chunk.error as { message?: string };
      throw new Error(`Memory Gateway stream error: ${error.message || "unknown error"}`);
    }
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason != null) finishReason = String(choice.finish_reason);
    const delta = (choice.delta || {}) as Record<string, unknown>;
    if (typeof delta.content === "string") content += delta.content;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string") reasoningContent += reasoning;
    if (Array.isArray(delta.reasoning_details)) {
      reasoningDetails.push(...delta.reasoning_details);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as Record<string, unknown>;
        const index = Number.isInteger(call.index) ? Number(call.index) : toolCalls.size;
        const current = toolCalls.get(index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) current.id = String(call.id);
        if (call.type) current.type = String(call.type);
        const fn = (call.function || {}) as Record<string, unknown>;
        if (typeof fn.name === "string") current.function.name += fn.name;
        if (typeof fn.arguments === "string") current.function.arguments += fn.arguments;
        toolCalls.set(index, current);
      }
    }
  }

  const assistant: GatewayAssistantMessage = { role: "assistant", content };
  if (reasoningContent) assistant.reasoning_content = reasoningContent;
  if (reasoningDetails.length) assistant.reasoning_details = reasoningDetails;
  if (toolCalls.size) {
    assistant.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
  }
  return { assistant, finishReason, reasoningContent };
}
