import type { GatewayInbound, GatewayUserContent } from "./inbound-message.js";
import type { CurrentPoll } from "./polls.js";

export function combineInbound(items: Array<GatewayInbound & { currentPoll?: CurrentPoll }>):
  GatewayInbound & { currentPoll?: CurrentPoll } {
  if (!items.length) throw new Error("cannot combine an empty inbound batch");
  if (items.length === 1) return items[0];
  const blocks: Exclude<GatewayUserContent, string> = [];
  let pollIndex = -1;
  items.forEach((item, index) => { if (item.currentPoll) pollIndex = index; });
  if (pollIndex >= 0) blocks.push({ type: "text",
    text: `本批投票工具 imessage_vote_current_poll 仅对应第 ${pollIndex + 1} 条消息的投票，请使用那条消息的选项编号。` });
  for (const [index, item] of items.entries()) {
    blocks.push({ type: "text", text: `[第 ${index + 1} 条消息]` });
    blocks.push(...(typeof item.content === "string" ? [{ type: "text" as const, text: item.content }] : item.content));
  }
  return {
    content: blocks.every((block) => block.type === "text")
      ? blocks.map((block) => (block as { text: string }).text).join("\n") : blocks,
    sourceMessage: items[items.length - 1].sourceMessage,
    currentPoll: items[pollIndex]?.currentPoll,
  };
}
