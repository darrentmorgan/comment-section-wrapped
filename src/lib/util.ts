export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `worker` over `items` with at most `concurrency` in flight. Rejects on first error and stops handing out new items. */
export async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const n = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (failed || i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(runners);
}

/** Small deterministic hash -> unsigned 32-bit int. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Default number of top comments fetched per video (live runs). Shared so the Reading screen can cap its progress maths the same way. */
export const DEFAULT_COMMENTS_PER_VIDEO = 1000;

/** Number of recent uploads included in a live run by default. */
export const DEFAULT_MAX_VIDEOS = 60;
