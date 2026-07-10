import { describe, it, expect } from 'vitest';
import { SendQueue, type SendJob, type SendEvent } from '../src/main/SendQueue';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SendQueue', () => {
  it('serializes per channel, runs channels in parallel, isolates failures, emits states', async () => {
    const events: SendEvent[] = [];
    const started: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred<{ channelMessageId?: string }>>> = {};
    const run = (job: SendJob) => {
      started.push(job.threadId);
      const d = deferred<{ channelMessageId?: string }>();
      gates[job.threadId] = d;
      return d.promise;
    };
    const q = new SendQueue(run, (e) => events.push(e));

    q.enqueue({ threadId: 'A1', channelId: 'ch1', body: 'x' });
    q.enqueue({ threadId: 'A2', channelId: 'ch1', body: 'y' }); // same channel → waits behind A1
    q.enqueue({ threadId: 'B1', channelId: 'ch2', body: 'z' }); // other channel → runs in parallel
    await tick();
    expect(started).toEqual(['A1', 'B1']); // A2 not started yet

    gates['A1']!.resolve({ channelMessageId: 'm1' });
    await tick();
    expect(started).toEqual(['A1', 'B1', 'A2']); // A2 starts once A1 finished

    gates['B1']!.reject(new Error('Daily cap reached'));
    await tick();
    expect(events.find((e) => e.threadId === 'B1' && e.state === 'failed')?.error).toMatch(/cap/i);

    gates['A2']!.resolve({});
    await tick();
    expect(events.filter((e) => e.threadId === 'A1').map((e) => e.state)).toEqual(['queued', 'pacing', 'sent']);
    expect(events.filter((e) => e.threadId === 'B1').map((e) => e.state)).toEqual(['queued', 'pacing', 'failed']);
  });
});
