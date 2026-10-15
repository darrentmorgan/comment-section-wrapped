const VERIFIER_KEY = "comment-wrapped.openrouter.verifier";
const EXPIRED = "OpenRouter sign-in expired, try again";
const FAILED = "OpenRouter sign-in failed, try again";

export function clearPendingSignIn(): void {
  try { sessionStorage.removeItem(VERIFIER_KEY); } catch { /* Storage may have become unavailable. */ }
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const binary = Array.from(new Uint8Array(digest), (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startOpenRouterSignIn(callbackUrl: string): Promise<string> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  const challenge = await createCodeChallenge(verifier);
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    throw new Error("Allow session storage to sign in with OpenRouter, or paste a key instead.");
  }
  const params = new URLSearchParams({ callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: "S256" });
  return `https://openrouter.ai/auth?${params}`;
}

export async function completeOpenRouterSignIn(search: string, fetchImpl: typeof fetch = fetch): Promise<{ key: string } | null> {
  const code = new URLSearchParams(search).get("code");
  if (!code) return null;
  let verifier: string | null = null;
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY);
  } catch {
    throw new Error(EXPIRED);
  }
  if (!verifier) throw new Error(EXPIRED);
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (response.status === 403) throw new Error(EXPIRED);
    if (!response.ok) throw new Error(FAILED);
    const body = await response.json() as { key?: unknown };
    if (typeof body?.key !== "string" || !body.key.trim()) throw new Error(FAILED);
    return { key: body.key.trim() };
  } catch (error) {
    throw new Error(error instanceof Error && error.message === EXPIRED ? EXPIRED : FAILED);
  } finally {
    clearPendingSignIn();
  }
}

export function stripAuthParams(url: string): string {
  const clean = new URL(url);
  clean.searchParams.delete("code");
  return clean.toString();
}
