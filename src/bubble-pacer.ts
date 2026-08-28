export type BubbleSend = () => Promise<unknown>;

type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = async (milliseconds) => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

export class BubblePacer {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly delayMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  async send(conversationId: string, send: BubbleSend): Promise<void> {
    const previous = this.tails.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const lastSentAt = this.lastSentAt.get(conversationId);
      if (lastSentAt !== undefined) {
        const remaining = this.delayMs - (this.now() - lastSentAt);
        if (remaining > 0) await this.sleep(remaining);
      }
      await send();
      this.lastSentAt.set(conversationId, this.now());
    });
    this.tails.set(conversationId, current);
    try {
      await current;
    } finally {
      if (this.tails.get(conversationId) === current) this.tails.delete(conversationId);
    }
  }
}

