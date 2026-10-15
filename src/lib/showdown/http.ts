// Retrying JSON POST used by every showdown adapter. Retry 429, 5xx, network/timeout, and the in-flight-budget flavour
// of 402 with Retry-After (else 1s doubling to a 30s cap). A 400 fails the item. 401/403 and other 402s are fatal.
import { sleep as defaultSleep } from "../util";

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public fatal = false,
    public attempts = 1,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface HttpCtx {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number; // default 60000
  maxAttempts?: number; // default 5
  /** shared by every worker of one lane so a 429 pauses all of them */
  throttle?: { until: number };
  onRateLimit?: () => void;
}

export interface HttpResult {
  json: Record<string, unknown>;
  attempts: number;
  /** wall time of the successful request only */
  ms: number;
  /** wall time from the first attempt to the answer, including retries and backoff */
  totalMs: number;
}

/** Remove anything that looks like a secret from a message before it is logged, stored or shown. */
export function scrubSecrets(msg: string, secrets: (string | undefined)[] = []): string {
  let out = msg
    .replace(/(authorization"?:?\s*bearer\s+)[\w.-]{6,}/gi, "$1***")
    .replace(/(bearer\s+)[\w.-]{12,}/gi, "$1***")
    .replace(/(x-api-key"?:?\s*)[\w-]{8,}/gi, "$1***")
    .replace(/sk-or-[\w-]{8,}/g, "***");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
  return out;
}

export const backoffMs = (attempt: number, random: () => number, retryAfterSec?: number): number => {
  const base = Math.min(30000, 1000 * 2 ** attempt) + Math.floor(random() * 250);
  return retryAfterSec && retryAfterSec > 0 ? Math.min(30000, Math.max(base, retryAfterSec * 1000)) : base;
};

const isRetryable402 = (text: string) => /in[- ]?flight|budget|concurren|too many/i.test(text);

export async function postJson(url: string, headers: Record<string, string>, body: unknown, ctx: HttpCtx = {}, secrets: string[] = []): Promise<HttpResult> {
  const f = ctx.fetchImpl ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const random = ctx.random ?? Math.random;
  const now = ctx.now ?? Date.now;
  const maxAttempts = ctx.maxAttempts ?? 5;
  const started = now();
  const payload = JSON.stringify(body);
  let last: ProviderError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("aborted", "AbortError");
    const wait = (ctx.throttle?.until ?? 0) - now();
    if (wait > 0) await sleep(wait);

    const t0 = now();
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(ctx.timeoutMs ?? 60000);
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: payload,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
      });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      last = new ProviderError(`network error: ${scrubSecrets(e instanceof Error ? e.message : String(e), secrets)}`, 0, false, attempt + 1);
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt, random));
      continue;
    }

    if (res.ok) {
      let json: Record<string, unknown>;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new ProviderError("response was not JSON", res.status, false, attempt + 1);
      }
      const t1 = now();
      return { json, attempts: attempt + 1, ms: t1 - t0, totalMs: t1 - started };
    }

    const text = scrubSecrets((await res.text().catch(() => "")).slice(0, 300), secrets);
    if (res.status === 401 || res.status === 403) throw new ProviderError(`rejected the key (${res.status})`, res.status, true, attempt + 1);
    if (res.status === 402 && !isRetryable402(text)) throw new ProviderError("out of credits (402)", 402, true, attempt + 1);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new ProviderError(`${res.status}: ${text}`, res.status, false, attempt + 1);

    const retryable = res.status === 429 || res.status === 402 || res.status >= 500;
    last = new ProviderError(`${res.status}: ${text}`, res.status, false, attempt + 1);
    if (!retryable) throw last;
    const ra = Number(res.headers.get("retry-after"));
    const delay = backoffMs(attempt, random, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    if (res.status === 429) {
      if (ctx.throttle) ctx.throttle.until = Math.max(ctx.throttle.until, now() + delay);
      ctx.onRateLimit?.();
    }
    if (attempt < maxAttempts - 1) await sleep(delay);
  }
  throw last ?? new ProviderError("failed", 0);
}
