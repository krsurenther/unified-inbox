import type { ThreadView } from './types';

/**
 * A thread "needs reply" when it's still open AND the last message is from the
 * customer (we haven't answered). Pure so the renderer and tests share one rule.
 */
export function needsReply(view: ThreadView): boolean {
  return !view.muted && view.thread.status === 'open' && view.lastMessageDirection === 'inbound';
}
