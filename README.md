# Comment Section Wrapped

A browser-only experiment in how AI models read a YouTube comment section. It labels moods, groups recurring commenters and plays the result as a Wrapped-style story. The recorded model showdown compares readers' cost, latency and agreement, with caveats; agreement is not accuracy. No vendor sponsors or endorses this project.

[Try the recorded MrBeast run](https://YOUR-PAGES-SITE.pages.dev/?replay=latest) (deployment URL placeholder). No keys needed: the demo includes a small sample of public comments with names and comment ids masked.

## Bring your own keys

Choose **Run it on any channel**. Supply a [free ScaleDown key](https://scaledown.xyz), or use **Sign in with OpenRouter** (you can also paste an [OpenRouter key](https://openrouter.ai/keys)). You also need a YouTube Data API key:

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate).
2. [Enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. [Create an API key](https://console.cloud.google.com/apis/credentials). Restrict it to your site under Websites and to YouTube Data API v3.

Select the provider and limits before running. The preview estimates model cost and YouTube quota; actual totals depend on available comments. Default: 60 videos, 300 top comments per video. Runs spend your own provider credits and quota.

Keys stay in this tab unless you opt into **Remember on this device**. **Forget keys** clears browser storage. There is no server, account system, analytics or cookies. Comments are fetched from YouTube by your browser and sent directly to the selected classifier; the site does not receive or archive them.

## Local development

Requires Node 22 and pnpm:

```bash
pnpm i && pnpm dev
```

Open the URL Next prints. No environment variables are needed for the site. `?replay=latest` plays the recorded run; `?mock=1` enables the synthetic dev stream. `&pace=fast` shortens story slides; `&debug=1` shows the replay id.

## Deploy to Cloudflare Pages

Connect the repository, set the build command to `pnpm build` and the output directory to `out`. Environment variables: none needed. The build embeds Cloudflare's commit SHA (or GitHub's, or the current git commit) for the footer. The export includes `/privacy/`, `/demo/` and `_headers`.

To verify where keys go, open the DevTools **Network** tab and test or run with your keys. Requests go straight to `api.scaledown.xyz`, `openrouter.ai` or `www.googleapis.com`. On Cloudflare Pages, the CSP in `public/_headers` blocks connections to any other destination. Local Next dev does not apply Cloudflare's headers. Fonts are self-hosted by `next/font`.

## Responsible use

Streamer mode is on by default: keep it on when sharing results, mask names, and don't target individuals. Model labels are uncertain interpretations. The recorded demo permanently masks commenter names. See [Privacy](src/app/privacy/page.tsx).

## How it works

1. `src/lib/youtube.ts` resolves a channel, lists uploads and fetches top comments using your key.
2. `src/lib/scaledown.ts` or `src/lib/openrouter.ts` classifies comment text directly through your chosen provider.
3. `src/lib/personas.ts` groups results and detects recurring patterns in the browser.
4. `src/lib/pipeline.ts` emits progress events directly to the UI; no API routes are deployed.
5. Static `/demo/<id>/events.json` and `showdown.json` power the recorded story.

Deeper notes: [ScaleDown notes](docs/SCALEDOWN_NOTES.md) and [showdown notes](docs/SHOWDOWN_NOTES.md).

## Local recordings and CLI keys

The showdown CLI is local-only: `pnpm showdown --help` shows usage. It uses provider keys from `.env.local`; copy `.env.example` and fill only the keys you need. Never commit real keys. The browser site does not read these keys or write `.runs`.

`src/lib/runs.ts` remains available for local Node tooling. A local recording in `.runs/<id>/` contains `events.jsonl`, `result.json` and `comments.jsonl`, with raw commenter data; keep it private. Export a recording with `scripts/export-demo.ts` to make a masked static demo, never publish the raw archive.

## Model Showdown

A seeded, stratified sample (default 1,000 comments, oversampling rare vibes plus long, non-English, emoji, short and low-confidence ones) is read by every reader. Each per-comment reader answers the same two questions: which vibe, and is it genuinely hateful.

| Reader | Via | Notes |
| --- | --- | --- |
| ScaleDown classify-1 | `POST /v1/scaledown` | Decisions API, one comment per request, returns probabilities |
| Jev 1.13 | OpenRouter `alpha/decisions` | Same request shape and questions as above |
| Claude Haiku 5.5, Gemma 4 26B, GPT-5.6 Luna | OpenRouter chat, JSON output | One hard label, no probabilities |
| ScaleDown batch classify | chat route, 50 per request | **Different job**: vibe only, the app's own tuned prompt. Reported but never ranked against the rest |
| Always supportive, keyword rules | local | Free baselines, the bar to beat |
| Claude Opus 5.5 and Sonnet 5.5 | OpenRouter | **Referees**, run on a 25% subset only |

How to read the numbers:

- Cost is as reported by each API (`usage.cost`), weighted to the channel's natural mix of comments, per 1,000 comments. Retries that were billed but failed are not counted.
- Latency is ranked on a **one-request-at-a-time probe** over a random slice of the sample. The race runs every per-comment reader at the same concurrency (16 requests in flight) and also reports under-load p50 and p95. Batch lanes report time per 50-comment request.
- "Agreement" is agreement with a referee model, **not accuracy**. A reader that fails to answer counts as disagreeing. The referees are Claude models, so a Claude reader may be favoured; compare with how the two referees agree with each other.
- Two readers are called tied only if a paired test on the same comments cannot separate them.
- The sample was partly chosen using the original ScaleDown batch labels and the rubric was tuned on that output, so it leans toward that classifier's view. The Dashboard and the verdict slide print the full caveat list.

Run it locally against an existing Node recording in `.runs/<id>/` (the browser site does not save runs):

```bash
pnpm showdown --run <runId>                 # all readers whose key is set; lanes without a key are skipped, never fatal
pnpm showdown --run <runId> --only scaledown,scaledown-batch,always-supportive,rules   # ScaleDown + free baselines only
pnpm showdown --run <runId> --fresh         # ignore saved results and start over
```

Options: `--n 1000` sample size, `--referee-n 250`, `--extra 20` (extra referee passes for the funniest disagreements), `--probe 60`, `--seed N`, `--only a,b`, `--skip a,b`. Reader ids: `scaledown`, `scaledown-batch`, `jev`, `haiku`, `gemma`, `luna`, `always-supportive`, `rules`, `referee-sonnet`, `referee-opus`.

A full run with every key costs roughly $0.70 and takes a few minutes (referees are most of it). It writes `<runs dir>/<runId>/showdown.json` (gitignored) and is resumable: a lane is reused only when its fingerprint (questions, seed, model, price, concurrency, threshold, base URL) is unchanged. Without `OPENROUTER_API_KEY` nothing breaks; the story simply shows fewer lanes, and the missing ones light up on the next run once the key exists. The site reads only exported demo showdown assets. Live browser runs have no showdown; `?mock=1` uses a clearly labelled static SIMULATED fixture.

## Recording tips

Use a recorded static run (`?replay=latest`) and keep Streamer mode on. Tap or Space/Right advances, Left goes back, hold pauses, Esc skips to the dashboard. Reduced motion is supported.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm showdown --help
```

`pnpm build` produces the static `out/` directory. Preview it with a static file server; `next start` is not used for exported sites.

## Troubleshooting

- **Key rejected:** check the keys panel, provider credits, YouTube API enablement and website restrictions.
- **YouTube quota exhausted:** reduce the limits or wait for the next daily quota reset. Each page of up to 100 comments costs one unit, plus lookups.
- **Provider network error:** check your connection and retry. The providers must allow browser requests through CORS.
- **Recording missing:** check `/demo/index.json` and the exported demo id. Private `.runs` files are not available to the site.
