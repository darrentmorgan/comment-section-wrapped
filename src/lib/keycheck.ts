export interface KeyCheckResult {
  ok: boolean;
  message: string;
}

type Provider = "YouTube" | "OpenRouter" | "ScaleDown";
interface CheckBody {
  error?: { errors?: { reason?: string }[]; details?: { reason?: string }[]; message?: string };
  data?: { limit?: number | null; usage?: number; limit_remaining?: number | null };
}

function describeResponse(provider: Provider, response: Response, body: CheckBody): KeyCheckResult {
  if (response.ok) {
    const data = body?.data;
    if (provider === "OpenRouter" && typeof data?.limit === "number" && Number.isFinite(data.limit)) {
      const remaining = typeof data.limit_remaining === "number" && Number.isFinite(data.limit_remaining)
        ? data.limit_remaining : data.limit - (typeof data.usage === "number" && Number.isFinite(data.usage) ? data.usage : 0);
      return { ok: true, message: `OpenRouter key works. $${Math.max(0, remaining).toFixed(2)} remaining of $${data.limit.toFixed(2)} limit.` };
    }
    return { ok: true, message: `${provider} key works.` };
  }
  if (provider === "YouTube") {
    const reasons = [...(body?.error?.errors ?? []), ...(body?.error?.details ?? [])].map((e) => e.reason ?? "");
    if (reasons.includes("keyInvalid") || reasons.includes("API_KEY_INVALID")) return { ok: false, message: "YouTube key is invalid. Check the pasted key." };
    if (reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED")) return { ok: false, message: "In Google Cloud, enable YouTube Data API v3 for this project." };
    if (reasons.some((r) => /quotaExceeded|dailyLimitExceeded|QUOTA_EXCEEDED/.test(r))) return { ok: false, message: "YouTube daily quota is used up. Try again after midnight Pacific." };
    if (reasons.some((r) => /referer|referrer/i.test(r)) || /referer|referrer/i.test(body?.error?.message ?? "")) return { ok: false, message: "YouTube blocked this site. Check the key’s website restrictions in Google Cloud." };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, message: `${provider} rejected the key` };
  if (response.status === 429) return { ok: false, message: `${provider} is rate limiting requests. Try again shortly.` };
  return { ok: false, message: `${provider} key check failed. Try again.` };
}

async function check(provider: Provider, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<KeyCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({})) as CheckBody;
    return describeResponse(provider, response, body);
  } catch {
    return { ok: false, message: controller.signal.aborted ? "Key check timed out. Try again." : `${provider} could not be reached. Check your connection and try again.` };
  } finally {
    clearTimeout(timer);
  }
}

export function checkYouTubeKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheckResult> {
  const query = new URLSearchParams({ part: "id", id: "dQw4w9WgXcQ", key: key.trim() });
  return check("YouTube", `https://www.googleapis.com/youtube/v3/videos?${query}`, { method: "GET" }, fetchImpl);
}

export function checkOpenRouterKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheckResult> {
  return check("OpenRouter", "https://openrouter.ai/api/v1/key", { method: "GET", headers: { Authorization: `Bearer ${key.trim()}` } }, fetchImpl);
}

export function checkScaleDownKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheckResult> {
  return check("ScaleDown", "https://api.scaledown.xyz/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key.trim() },
    body: JSON.stringify({ model: "classify", messages: [{ role: "user", content: "test" }] }),
  }, fetchImpl);
}
