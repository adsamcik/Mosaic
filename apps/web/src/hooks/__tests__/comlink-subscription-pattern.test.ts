/**
 * Regression test for v1.0.x `comlink-subscription-pattern`.
 *
 * Subscription objects returned across the Comlink boundary must be retained
 * whole. Destructuring `unsubscribe` off the proxy breaks the proxy chain
 * and yields the cryptic `rawValue.apply is not a function` failure in the
 * worker — observed 34+ times during v1.0.x validation-1 runs.
 *
 * Affected callsites fixed alongside this test:
 *   - apps/web/src/hooks/useJobThumbnails.ts
 *   - apps/web/src/hooks/useDownloadManager.ts
 *   - apps/web/src/hooks/coordinator-download-runner.ts
 */
import { describe, expect, it } from 'vitest';

/**
 * Simulate a Comlink Remote where `subscription.unsubscribe` is a "proxy
 * method": calling it through the parent object succeeds, but destructuring
 * loses the `this` / proxy traps and breaks with `rawValue.apply is not a
 * function` — the exact production failure mode.
 */
function makeSubscriptionLike(): {
  subscription: { unsubscribe: () => Promise<void> };
  unsubscribed: { count: number };
} {
  const unsubscribed = { count: 0 };
  const subscription = Object.create(null) as { unsubscribe: () => Promise<void> };
  Object.defineProperty(subscription, 'unsubscribe', {
    value: async function unsubscribe(this: unknown): Promise<void> {
      if (this !== subscription) {
        throw new TypeError('rawValue.apply is not a function');
      }
      unsubscribed.count += 1;
    },
    enumerable: true,
  });
  return { subscription, unsubscribed };
}

describe('comlink-subscription-pattern — retain full proxy chain', () => {
  it('reproduces the production failure when unsubscribe is destructured', async () => {
    const { subscription } = makeSubscriptionLike();
    // ❌ Anti-pattern (what we fixed): tear unsubscribe off the proxy.
    const detached = subscription.unsubscribe;
    await expect(detached()).rejects.toThrow('rawValue.apply is not a function');
  });

  it('succeeds when the subscription object is retained and called through', async () => {
    const { subscription, unsubscribed } = makeSubscriptionLike();
    // ✅ Correct pattern: retain the proxy, call through it.
    await subscription.unsubscribe();
    expect(unsubscribed.count).toBe(1);
  });
});
