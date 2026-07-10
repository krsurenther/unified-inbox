export interface SendJob {
  threadId: string;
  channelId: string;
  body: string;
  approvedBy?: string;
}

export interface SendResultLite {
  channelMessageId?: string;
}

export type SendState = 'queued' | 'pacing' | 'sent' | 'failed';

export interface SendEvent {
  threadId: string;
  state: SendState;
  error?: string;
  channelMessageId?: string;
}

/**
 * Serializes approved sends PER CHANNEL (one in-flight per number, channels run in
 * parallel) and streams state events the renderer displays. Serialization closes the
 * anti-ban check/pace race — two rapid approvals on the same number can no longer both
 * pass the cap check before either audit row lands — and lets the UI ack instantly
 * instead of blocking the whole ~2.5–15s paced send. A failed job never blocks the
 * next job on its channel.
 */
export class SendQueue {
  private readonly queues = new Map<string, SendJob[]>();
  private readonly active = new Set<string>();

  constructor(
    private readonly run: (job: SendJob) => Promise<SendResultLite>,
    private readonly emit: (e: SendEvent) => void,
  ) {}

  enqueue(job: SendJob): void {
    this.emit({ threadId: job.threadId, state: 'queued' });
    const q = this.queues.get(job.channelId) ?? [];
    q.push(job);
    this.queues.set(job.channelId, q);
    void this.pump(job.channelId);
  }

  private async pump(channelId: string): Promise<void> {
    if (this.active.has(channelId)) return; // one send at a time per number
    const q = this.queues.get(channelId);
    if (!q || q.length === 0) return;
    this.active.add(channelId);
    const job = q.shift()!;
    try {
      this.emit({ threadId: job.threadId, state: 'pacing' });
      const res = await this.run(job);
      this.emit({ threadId: job.threadId, state: 'sent', channelMessageId: res.channelMessageId });
    } catch (e) {
      this.emit({ threadId: job.threadId, state: 'failed', error: (e as Error).message });
    } finally {
      this.active.delete(channelId);
      void this.pump(channelId); // next job on this channel
    }
  }
}
