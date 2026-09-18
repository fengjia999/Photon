import type { FrontendToolResult } from "./native-tools.js";

export class GatewayTurnState {
  sentReply = false;
  suppressFinalText = false;

  record(outcome: FrontendToolResult): void {
    this.sentReply ||= outcome.sentReply;
    this.suppressFinalText ||= outcome.suppressFinalText ?? outcome.sentReply;
  }
}
