type Bucket<T> = {
  pending: T[];
  queued: T[][];
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
};

// Collect without blocking reception; each conversation drains in order.
export class InboundBatcher<T> {
  private readonly buckets = new Map<string, Bucket<T>>();
  private closed = false;

  constructor(
    private readonly handle: (items: T[]) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  add(key: string, item: T, delayMs: number): void {
    if (this.closed) throw new Error("inbound batcher is closed");
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { pending: [], queued: [] };
      this.buckets.set(key, bucket);
    }
    bucket.pending.push(item);
    clearTimeout(bucket.timer);
    if (delayMs === 0) this.flush(key, bucket);
    else bucket.timer = setTimeout(() => this.flush(key, bucket!), delayMs);
  }

  private flush(key: string, bucket: Bucket<T>): void {
    clearTimeout(bucket.timer);
    bucket.timer = undefined;
    if (bucket.pending.length) bucket.queued.push(bucket.pending.splice(0));
    this.drain(key, bucket);
  }

  private drain(key: string, bucket: Bucket<T>): void {
    if (bucket.running || !bucket.queued.length) return;
    bucket.running = Promise.resolve().then(async () => {
      while (bucket.queued.length) {
        try { await this.handle(bucket.queued.shift()!); }
        catch (error) { this.onError(error); }
      }
    }).finally(() => {
      bucket.running = undefined;
      if (bucket.queued.length) this.drain(key, bucket);
      else if (!bucket.pending.length) this.buckets.delete(key);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, bucket] of this.buckets) this.flush(key, bucket);
    await Promise.all([...this.buckets.values()].map((bucket) => bucket.running));
  }
}
