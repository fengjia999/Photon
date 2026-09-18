import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { Spectrum, type Message, type Space } from "@spectrum-ts/core";
import { effect, imessage } from "@spectrum-ts/imessage";

import { splitBubbles } from "./bubbles.js";
import { BubblePacer } from "./bubble-pacer.js";
import { readGatewayStream } from "./gateway-stream.js";
import { gatewayInboundForMessage, type GatewayInbound } from "./inbound-message.js";
import { SettingsStore, type BridgeSettings } from "./settings.js";
import { adminHtml } from "./admin.js";
import { loadCurrentPoll, type CurrentPoll } from "./polls.js";
import { GatewayTurnState } from "./turn-state.js";
import { bridgeInboundMessages } from "./poll-events.js";
import { InboundBatcher } from "./inbound-batcher.js";
import { combineInbound } from "./inbound-batch.js";
import {
  executeIMessageFrontendTool,
  imessageFrontendTools,
  messageEffects,
  type EffectName,
  type FrontendToolResult,
  type PaceBubble,
} from "./native-tools.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

function maskHandle(value: string): string {
  const normalized = normalizeHandle(value);
  return normalized ? `***${normalized.slice(-4)}` : "(unknown)";
}

const projectId = requiredEnv("SPECTRUM_PROJECT_ID");
const projectSecret = requiredEnv("SPECTRUM_PROJECT_SECRET");
const homeUser = requiredEnv("PHOTON_HOME_USER");
const gatewayUrl = requiredEnv("MEMORY_GATEWAY_URL").replace(/\/+$/, "");
const gatewaySecret = requiredEnv("MEMORY_GATEWAY_SECRET");
const bridgeSecret = requiredEnv("BRIDGE_SECRET");
const settings = await SettingsStore.open(process.env.BRIDGE_SETTINGS_PATH || "data/settings.json", {
  model: process.env.MEMORY_GATEWAY_MODEL?.trim() || "",
  timeEnabled: true,
});
const configuredPort = Number.parseInt(process.env.PORT || "8080", 10);
const port = Number.isFinite(configuredPort) && configuredPort > 0
  ? configuredPort
  : 8080;
const configuredMaxBubbleCharacters = Number.parseInt(
  process.env.MAX_BUBBLE_CHARACTERS || "3000",
  10,
);
const maxBubbleCharacters =
  Number.isFinite(configuredMaxBubbleCharacters) && configuredMaxBubbleCharacters > 0
    ? configuredMaxBubbleCharacters
    : 3000;
const configuredBubbleDelayMs = Number.parseInt(process.env.BUBBLE_DELAY_MS || "2000", 10);
const bubbleDelayMs = Number.isFinite(configuredBubbleDelayMs)
  ? Math.max(2000, configuredBubbleDelayMs)
  : 2000;
const bubblePacer = new BubblePacer(bubbleDelayMs);
const paceBubble: PaceBubble = async (conversationId, send) => {
  await bubblePacer.send(conversationId, send);
};
const configuredMaxImageBytes = Number.parseInt(
  process.env.MAX_IMAGE_BYTES || String(5 * 1024 * 1024),
  10,
);
const maxImageBytes =
  Number.isFinite(configuredMaxImageBytes) && configuredMaxImageBytes > 0
    ? configuredMaxImageBytes
    : 5 * 1024 * 1024;
const allowedUsers = new Set(
  (process.env.PHOTON_ALLOWED_USERS || homeUser)
    .split(",")
    .map(normalizeHandle)
    .filter(Boolean),
);

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;
let app: SpectrumApp | null = null;
let shuttingDown = false;
let inboundMessages: ReturnType<typeof bridgeInboundMessages> | undefined;

function isAuthorized(request: IncomingMessage): boolean {
  const actual = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${bridgeSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required");
  }
  return parsed as Record<string, unknown>;
}

async function sendReasoningBubbles(
  sourceMessage: Parameters<typeof executeIMessageFrontendTool>[1],
  reasoning: string,
  isPoll = false,
): Promise<void> {
  const bubble = reasoning.trim();
  if (!bubble) return;
  await paceBubble(sourceMessage.space.id, () => isPoll
    ? sourceMessage.space.send(`（${bubble}）`)
    : sourceMessage.reply(`（${bubble}）`));
}

async function askGateway(
  userContent: string | Array<Record<string, unknown>>,
  sourceMessage: Parameters<typeof executeIMessageFrontendTool>[1],
  state: GatewayTurnState,
  gatewayModel: string,
  currentPoll?: CurrentPoll,
): Promise<string> {
  let messages: Array<Record<string, unknown>> = [{ role: "user", content: userContent }];
  const completedCalls = new Map<string, FrontendToolResult>();

  for (let round = 0; round < 8; round += 1) {
    const body: Record<string, unknown> = {
      stream: true,
      messages,
      tools: imessageFrontendTools,
    };
    if (gatewayModel) body.model = gatewayModel;

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewaySecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!response.ok) throw new Error(`Memory Gateway returned HTTP ${response.status}`);
    const streamed = await readGatewayStream(response);
    const assistant = streamed.assistant;
    if (streamed.reasoningContent.trim()) {
      await sendReasoningBubbles(sourceMessage, streamed.reasoningContent,
        Boolean(currentPoll) || sourceMessage.content.type === "poll" || sourceMessage.content.type === "poll_option");
    }
    const toolCalls = assistant.tool_calls || [];
    if (!toolCalls.length) {
      const answer = String(assistant.content || "").trim();
      if (!answer && !state.sentReply) {
        throw new Error("Memory Gateway returned no assistant text");
      }
      return answer;
    }

    const toolResults: Array<Record<string, unknown>> = [];
    for (const call of toolCalls) {
      const callId = String(call.id || "");
      let outcome = completedCalls.get(callId);
      if (!outcome) {
        try {
          outcome = await executeIMessageFrontendTool(
            call,
            sourceMessage,
            maxBubbleCharacters,
            paceBubble,
            currentPoll,
          );
        } catch (error) {
          outcome = {
            result: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
            sentReply: false,
          };
        }
        if (callId) completedCalls.set(callId, outcome);
      }
      state.record(outcome);
      toolResults.push({
        role: "tool",
        tool_call_id: callId,
        content: outcome.result,
      });
    }
    messages = [assistant as unknown as Record<string, unknown>, ...toolResults];
  }
  throw new Error("Memory Gateway frontend tool loop exceeded 8 rounds");
}

async function sendNotification(text: string, effectName: EffectName): Promise<number> {
  if (!app) throw new Error("Photon is still connecting");
  const im = imessage(app);
  const user = await im.user(homeUser);
  const space = await im.space.create(user);
  const bubbles = splitBubbles(text, maxBubbleCharacters);
  if (!bubbles.length) throw new Error("notification text is empty");

  for (let index = 0; index < bubbles.length; index += 1) {
    const bubble = bubbles[index];
    if (effectName === "none" || index > 0) {
      await paceBubble(space.id, () => space.send(bubble));
    } else {
      await paceBubble(space.id, () => space.send(effect(bubble, messageEffects[effectName])));
    }
  }
  return bubbles.length;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && (request.url === "/" || request.url === "/admin")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      response.end(adminHtml);
      return;
    }
    if (request.url === "/api/settings") {
      response.setHeader("cache-control", "no-store");
      if (!isAuthorized(request)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "PUT") await settings.save(await readJson(request));
      else if (request.method !== "GET") {
        response.setHeader("allow", "GET, PUT");
        json(response, 405, { error: "method_not_allowed" });
        return;
      }
      json(response, 200, settings.get());
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { status: app ? "ok" : "starting" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/notify") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (!isAuthorized(request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }

    const body = await readJson(request);
    const text = String(body.text || "").trim();
    const requestedEffect = String(body.effect || "none") as EffectName;
    if (requestedEffect !== "none" && !(requestedEffect in messageEffects)) {
      throw new Error("unsupported iMessage effect");
    }
    const effectName: EffectName = requestedEffect;
    const bubbles = await sendNotification(text, effectName);
    json(response, 200, { ok: true, bubbles });
  } catch (error) {
    console.error("[http] request failed", error);
    json(response, 400, { error: "request_failed" });
  }
});
server.listen(port, "0.0.0.0", () => {
  console.log(`[http] listening on :${port}`);
});

const seenMessageIds = new Map<string, true>();
function isDuplicate(messageId: string): boolean {
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, true);
  if (seenMessageIds.size > 2048) {
    const oldest = seenMessageIds.keys().next().value;
    if (oldest) seenMessageIds.delete(oldest);
  }
  return false;
}

type PendingMessage = { app: SpectrumApp; space: Space; message: Message; receivedAt: Date; settings: BridgeSettings };
const inboundBatcher = new InboundBatcher<PendingMessage>(async (items) => {
  const last = items[items.length - 1];
  const prepared: Array<GatewayInbound & { currentPoll?: CurrentPoll }> = [];
  for (const item of items) {
    try {
      const currentPoll = await loadCurrentPoll(item.app, item.message);
      const inbound = await gatewayInboundForMessage(item.message, maxImageBytes, item.receivedAt, item.settings.timeEnabled, currentPoll);
      if (!inbound) continue;
      const eventKind = currentPoll || item.message.content.type === "poll" ? "poll" : "message";
      const key = `${imessage(item.space).phone}:${item.space.id}:${item.message.id}:${eventKind}`;
      if (!isDuplicate(key)) prepared.push({ ...inbound, currentPoll });
    } catch (error) {
      // One unavailable attachment/poll must not discard the rest of the batch.
      console.error("[inbound] message preparation failed", error);
      prepared.push({ sourceMessage: item.message,
        content: "[iMessage 消息读取失败：这条消息的内容暂时无法获取，请勿猜测。]" });
    }
  }
  if (!prepared.length) return;
  const inbound = combineInbound(prepared);
  const turnState = new GatewayTurnState();
  console.log(`[inbound] sending batch count=${prepared.length}`);
  try {
    await last.space.responding(async () => {
      const answer = await askGateway(inbound.content, inbound.sourceMessage, turnState, last.settings.model, inbound.currentPoll);
      if (!turnState.suppressFinalText) {
        for (const bubble of splitBubbles(answer, maxBubbleCharacters)) {
          await paceBubble(last.space.id, () => last.space.send(bubble));
        }
      }
    });
  } catch (error) {
    console.error("[inbound] batch turn failed", error);
    if (!turnState.sentReply) {
      await paceBubble(last.space.id, () => last.space.send("⚠️ 记忆网关暂时没有响应。"));
    }
  }
}, (error) => console.error("[inbound] batch failed", error));

async function runInbound(spectrumApp: SpectrumApp): Promise<void> {
  console.log("[inbound] waiting for messages");
  inboundMessages = bridgeInboundMessages(spectrumApp, allowedUsers);
  for await (const [space, message] of inboundMessages) {
    if (shuttingDown) break;
    console.log(
      `[inbound] received platform=${message.platform} direction=${message.direction}`
      + ` type=${message.content.type} sender=${maskHandle(message.sender?.id || "")}`,
    );
    if (message.platform !== "imessage" || message.direction === "outbound") continue;
    if (
      message.content.type !== "text"
      && message.content.type !== "reaction"
      && message.content.type !== "attachment"
      && message.content.type !== "group"
      && message.content.type !== "poll"
      && message.content.type !== "poll_option"
      && message.content.type !== "custom"
    ) continue;
    const imSpace = imessage(space);
    const imMessage = imessage(message);
    const sender = normalizeHandle(imMessage.sender?.address || message.sender?.id || "");
    if (imSpace.type !== "dm") {
      console.log("[inbound] ignored non-DM message");
      continue;
    }
    if (!allowedUsers.has(sender)) {
      console.warn(`[inbound] ignored unauthorized sender=${maskHandle(sender)}`);
      continue;
    }
    console.log(`[inbound] accepted sender=${maskHandle(sender)}`);
    const turnSettings = settings.get();
    inboundBatcher.add(`${imSpace.phone}:${space.id}`, {
      app: spectrumApp, space, message, receivedAt: new Date(), settings: turnSettings,
    }, turnSettings.debounceSeconds * 1000);
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal}`);
  shuttingDown = true;
  server.close();
  await inboundBatcher.close();
  if (app) await app.stop();
  await inboundMessages?.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function startSpectrum(): Promise<void> {
  try {
    console.log("[spectrum] connecting");
    app = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
    });
    console.log("[spectrum] connected");
    console.log(
      `[config] home=${maskHandle(homeUser)}`
      + ` allowed=${Array.from(allowedUsers, maskHandle).join(",")}`,
    );
    await runInbound(app);
    if (!shuttingDown) throw new Error("Photon message stream ended");
  } catch (error) {
    if (shuttingDown) return;
    console.error("[spectrum] startup failed", error);
    await inboundBatcher.close();
    if (app) await app.stop().catch(() => undefined);
    await inboundMessages?.close().catch(() => undefined);
    app = null;
    server.close();
    process.exitCode = 1;
  }
}

void startSpectrum();
