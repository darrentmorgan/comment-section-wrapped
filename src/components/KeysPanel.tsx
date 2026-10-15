"use client";

import { useId, useRef, useState } from "react";
import { clearKeys, type Keys } from "@/lib/keystore";
import { checkOpenRouterKey, checkScaleDownKey, checkYouTubeKey, type KeyCheckResult } from "@/lib/keycheck";
import { startOpenRouterSignIn } from "@/lib/openrouterAuth";

export interface KeysPanelProps {
  keys: Keys;
  onChange: (keys: Keys) => void;
  remember: boolean;
  onRemember: (remember: boolean) => void;
  callbackError?: string;
}

const inputClass = "min-w-0 w-full border-b border-bone/40 bg-transparent px-3 py-3 text-base text-bone outline-none focus:border-bone";
const buttonClass = "border border-bone/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-bone transition-colors hover:border-bone disabled:opacity-50";
const linkClass = "text-bone underline underline-offset-4 hover:text-mute";

export function KeysPanel({ keys, onChange, remember, onRemember, callbackError }: KeysPanelProps) {
  const id = useId();
  const [showScaleDown, setShowScaleDown] = useState(false);
  const [results, setResults] = useState<Partial<Record<keyof Keys, KeyCheckResult>>>({});
  const [testing, setTesting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState("");
  const checkGeneration = useRef(0);
  const scaledownId = `scaledown-key${id}`;
  const youtubeId = `youtube-key${id}`;
  const openrouterId = `openrouter-key${id}`;

  const change = (name: keyof Keys, value: string) => {
    checkGeneration.current++;
    setResults({});
    setTesting(false);
    onChange({ ...keys, [name]: value });
  };

  const signIn = async () => {
    setSigningIn(true);
    setAuthError("");
    try {
      const url = await startOpenRouterSignIn(window.location.origin + window.location.pathname);
      window.location.assign(url);
    } catch {
      setAuthError("Could not start OpenRouter sign-in. Allow session storage, or paste a key instead.");
      setSigningIn(false);
    }
  };

  const testKeys = async () => {
    const generation = ++checkGeneration.current;
    setTesting(true);
    setResults({});
    const checks: [keyof Keys, (key: string) => Promise<KeyCheckResult>][] = [
      ["scaledown", checkScaleDownKey], ["openrouter", checkOpenRouterKey], ["youtube", checkYouTubeKey],
    ];
    await Promise.all(checks.map(async ([name, check]) => {
      const key = keys[name]?.trim();
      if (!key) return;
      const result = await check(key);
      if (checkGeneration.current === generation) setResults((current) => ({ ...current, [name]: result }));
    }));
    if (checkGeneration.current === generation) setTesting(false);
  };

  const forget = () => {
    checkGeneration.current++;
    clearKeys();
    setResults({});
    setTesting(false);
    setShowScaleDown(false);
    onChange({});
    onRemember(false);
  };

  const result = (name: keyof Keys) => results[name] && (
    <p className={`mt-2 text-sm ${results[name].ok ? "text-supportive" : "text-bone"}`} role="status">{results[name].message}</p>
  );

  return (
    <section aria-label="Your API keys" className="w-full min-w-0 max-w-[760px] space-y-7 border border-line bg-ink p-5 text-bone sm:p-7">
      <div>
        <h2 className="display-soft text-3xl">Bring your own keys</h2>
        <p className="mt-3 text-sm leading-relaxed text-mute">Keys go straight from your browser to ScaleDown, OpenRouter and Google. This site has no server.</p>
      </div>

      <section aria-labelledby={`scaledown-title${id}`} className="min-w-0 border-t border-line pt-5">
        <h3 id={`scaledown-title${id}`} className="display-soft text-2xl">ScaleDown key</h3>
        <label htmlFor={scaledownId} className="sr-only">ScaleDown key</label>
        <div className="mt-3 flex min-w-0 items-center gap-2">
          <input id={scaledownId} type={showScaleDown ? "text" : "password"} value={keys.scaledown ?? ""} onChange={(e) => change("scaledown", e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} className={inputClass} />
          <button type="button" aria-label={showScaleDown ? "Hide ScaleDown key" : "Show ScaleDown key"} aria-pressed={showScaleDown} onClick={() => setShowScaleDown(!showScaleDown)} className="shrink-0 px-2 py-3 text-sm text-mute hover:text-bone">{showScaleDown ? "Hide" : "Show"}</button>
        </div>
        <p className="mt-3 text-sm"><a href="https://scaledown.xyz" target="_blank" rel="noopener noreferrer" className={linkClass}>Get a free key</a></p>
        {result("scaledown")}
      </section>

      <section aria-labelledby={`openrouter-title${id}`} className="min-w-0 border-t border-line pt-5">
        <h3 id={`openrouter-title${id}`} className="display-soft text-2xl">OpenRouter</h3>
        {keys.openrouter?.trim() ? (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <span className="text-sm text-supportive">Connected</span>
            <button type="button" onClick={() => change("openrouter", "")} className={buttonClass}>Disconnect</button>
          </div>
        ) : (
          <>
            <button type="button" onClick={signIn} disabled={signingIn} className={`mt-3 ${buttonClass}`}>{signingIn ? "Opening OpenRouter…" : "Sign in with OpenRouter"}</button>
            <label htmlFor={openrouterId} className="mt-4 block text-sm text-mute">Or paste an OpenRouter key instead</label>
            <input id={openrouterId} type="password" value={keys.openrouter ?? ""} onChange={(e) => change("openrouter", e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} className={inputClass} />
          </>
        )}
        {(callbackError || authError) && <p role="alert" className="mt-3 text-sm">{callbackError || authError}</p>}
        {result("openrouter")}
      </section>

      <section aria-labelledby={`youtube-title${id}`} className="min-w-0 border-t border-line pt-5">
        <h3 id={`youtube-title${id}`} className="display-soft text-2xl">YouTube Data API key</h3>
        <label htmlFor={youtubeId} className="sr-only">YouTube Data API key</label>
        <input id={youtubeId} type="password" value={keys.youtube ?? ""} onChange={(e) => change("youtube", e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} className={`mt-3 ${inputClass}`} />
        <p className="mt-3 text-sm text-mute">Free, about 2 minutes, no billing needed.</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer" className={linkClass}>Create a project</a></li>
          <li><a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer" className={linkClass}>Enable YouTube Data API v3</a></li>
          <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className={linkClass}>Create an API key</a></li>
        </ol>
        <p className="mt-3 text-sm leading-relaxed text-mute">Tip: restrict the key to this site under Application restrictions: Websites, and restrict API access to the YouTube Data API v3.</p>
        {result("youtube")}
      </section>

      <div className="space-y-4 border-t border-line pt-5">
        <button type="button" onClick={testKeys} disabled={testing || !Object.values(keys).some((key) => key?.trim())} className={buttonClass}>{testing ? "Testing keys…" : "Test my keys"}</button>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => onRemember(e.target.checked)} className="mt-0.5 shrink-0 accent-bone" />
          <span>Remember on this device<span className="mt-1 block leading-relaxed text-mute">Otherwise, keys vanish when the tab closes.</span></span>
        </label>
        <button type="button" onClick={forget} className={buttonClass}>Forget keys</button>
      </div>
    </section>
  );
}
