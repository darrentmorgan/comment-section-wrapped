import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import config from "../../../next.config";
import { streamAnalysis } from "../useAnalyze";
import { loadShowdown } from "../useShowdown";
import { Hero } from "../Hero";
import { SiteFooter } from "../SiteFooter";
import { SHOWDOWN_FIXTURE } from "../showdownFixture";
import { KeysPanel } from "../KeysPanel";
import { DEFAULT_MAX_VIDEOS } from "@/lib/util";
import type { ProgressEvent } from "@/lib/types";

const read = (path: string) => readFileSync(path, "utf8");

describe("browser integration", () => {
  it("exports static pages with build identity", () => {
    expect(config).toMatchObject({ output: "export", trailingSlash: true, images: { unoptimized: true } });
    expect(config.env?.NEXT_PUBLIC_COMMIT_SHA).toBeTruthy();
    expect(config.env?.NEXT_PUBLIC_REPO_URL).toBe("https://github.com/darrentmorgan/comment-section-wrapped");
    expect(existsSync("src/app/api")).toBe(false);
    expect(existsSync("src/lib/guard.ts")).toBe(false);
    expect(DEFAULT_MAX_VIDEOS).toBe(60);
    expect(read("src/lib/estimate.ts")).not.toContain('from "./pipeline"');
  });
  it("queues synchronous and delayed emissions in order and passes browser credentials and limits", async () => {
    const ac = new AbortController();
    const events: ProgressEvent[] = [{ type: "status", stage: "resolving", message: "first" }, { type: "fetched", total: 3 }];
    const runner = vi.fn(async (_req, emit) => { emit(events[0]); await Promise.resolve(); emit(events[1]); });
    const req = { channel: "@test", provider: "openrouter" as const, maxVideos: 5, maxCommentsPerVideo: 300 };
    const received = [];
    for await (const event of streamAnalysis(req, { youtube: "yt-test", openrouter: "sk-test" }, ac.signal, runner)) received.push(event);
    expect(received).toEqual(events);
    expect(runner).toHaveBeenCalledWith(req, expect.any(Function), { env: { YOUTUBE_API_KEY: "yt-test", OPENROUTER_API_KEY: "sk-test", SCALEDOWN_API_KEY: undefined }, signal: ac.signal });
  });
  it("wakes an idle consumer on abort even if the producer never settles", async () => {
    const ac = new AbortController();
    const stream = streamAnalysis({ channel: "@test" }, {}, ac.signal, async () => new Promise(() => {}));
    const next = stream.next();
    ac.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });
  it("propagates producer failures", async () => {
    const stream = streamAnalysis({ channel: "@test" }, {}, new AbortController().signal, async () => { throw new Error("provider offline"); });
    await expect(stream.next()).rejects.toThrow("provider offline");
  });
  it("has no showdown for live runs and uses only the static mock fixture", async () => {
    const fetcher = vi.fn();
    expect(await loadShowdown(null, false, new AbortController().signal, fetcher)).toBeNull();
    expect((await loadShowdown(null, true, new AbortController().signal, fetcher))?.simulated).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads a recorded showdown through the static index", async () => {
    const fetcher = vi.fn(async (url) => new Response(JSON.stringify(url === "/demo/index.json" ? { runs: [{ id: "mrbeast-test" }] } : {})));
    await loadShowdown("latest", false, new AbortController().signal, fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/demo/index.json", "/demo/mrbeast-test/showdown.json"]);
    expect(SHOWDOWN_FIXTURE.simulated).toBe(true);
  });
  it("enables keyed runs with provider choice and 300-comment default", () => {
    const html = renderToStaticMarkup(createElement(Hero, { onRun: vi.fn(), streamer: true, keys: { youtube: "yt-test", scaledown: "sk-test", openrouter: "sk-test" }, onKeysChange: vi.fn(), remember: false, onRemember: vi.fn(), keysOpen: true }));
    expect(html).toContain('aria-label="Provider"');
    expect(html).toContain('<option value="300" selected="">');
    expect(html).toContain('<option value="60" selected="">');
    expect(html).not.toMatch(/disabled=""[^>]*>Run/);
    const panel = renderToStaticMarkup(createElement(KeysPanel, { keys: {}, onChange: vi.fn(), remember: false, onRemember: vi.fn(), callbackError: "Sign-in expired" }));
    expect(panel).toContain('role="alert"');
    expect(panel).toContain("Sign-in expired");
  });
  it("documents browser setup and local-only CLI keys", () => {
    const readme = read("README.md");
    for (const text of ["pnpm i && pnpm dev", "Cloudflare Pages", "out", "DevTools", "local-only", "Streamer mode"]) expect(readme).toContain(text);
    // internal production notes stay out of the public repo, so the README must not link them
    for (const text of ["docs/RECORDING.md", "docs/BUILD_LOG.md"]) expect(readme).not.toContain(text);
    expect(read(".env.example")).toContain("only for the local showdown CLI");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 Darren Morgan");
  });
  it("leads with the recorded run and gates live controls", () => {
    const html = renderToStaticMarkup(createElement(Hero, { onRun: vi.fn(), onReplay: vi.fn(), streamer: true, keys: {}, onKeysChange: vi.fn(), remember: false, onRemember: vi.fn(), keysOpen: true }));
    for (const text of ["Watch the MrBeast run", "Run it on any channel", "Bring your own keys", "About", "10,000 daily YouTube units", "Privacy", "Source"]) expect(html).toContain(text);
    expect(html).toMatch(/disabled=""[^>]*>Run/);
    expect(html).not.toContain("Run demo");
  });
  it("renders linked commit identity or dev build", () => {
    expect(renderToStaticMarkup(createElement(SiteFooter, { sha: "abcdef123456", repo: "https://example.com/repo" }))).toContain('href="https://example.com/repo/commit/abcdef123456"');
    expect(renderToStaticMarkup(createElement(SiteFooter, { sha: "dev" }))).toContain("dev build");
  });
  it("restricts connections to exactly the provider origins", () => {
    const headers = read("public/_headers");
    const csp = headers.match(/Content-Security-Policy: (.+)/)![1];
    const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src"))!.trim().split(/\s+/).slice(1);
    expect(connect).toEqual(["'self'", "https://api.scaledown.xyz", "https://openrouter.ai", "https://www.googleapis.com"]);
    for (const text of ["frame-ancestors 'none'", "Referrer-Policy: strict-origin-when-cross-origin", "X-Content-Type-Options: nosniff", "Permissions-Policy: camera=(), microphone=(), geolocation=()"]) expect(headers).toContain(text);
  });
  it("prints CLI help before loading local keys", () => {
    const cli = read("scripts/showdown.ts");
    expect(cli.indexOf('process.argv.includes("--help")')).toBeGreaterThanOrEqual(0);
    expect(cli.indexOf('process.argv.includes("--help")')).toBeLessThan(cli.indexOf("process.loadEnvFile"));
  });
  it("wires callback completion and privacy disclosures", () => {
    const page = read("src/app/page.tsx");
    for (const name of ["completeOpenRouterSignIn", "stripAuthParams", "saveKeys", "authError"]) expect(page).toContain(name);
    const privacy = read("src/app/privacy/page.tsx");
    for (const text of ["no analytics", "no cookies", "Remember on this device", "https://www.youtube.com/t/terms", "https://policies.google.com/privacy", "https://security.google.com/settings/security/permissions", "masked"]) expect(privacy).toContain(text);
    for (const path of ["src/components/useAnalyze.ts", "src/components/useShowdown.ts", "src/components/Hero.tsx"]) expect(read(path)).not.toContain("/api/");
  });
});
