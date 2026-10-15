# ScaleDown API notes (verified live 2026-10-14 with our key)

- `POST https://api.scaledown.xyz/classify` returns **403 Forbidden** for our key (route exists, key not permitted).
- Use the OpenAI-compatible endpoint instead. Both of these work (header `x-api-key`):
  - **Classify (batched):** `POST /v1/chat/completions` with `{"model":"classify","messages":[{"role":"user","content":"<any text>"}],"labels":[{"name","rubric"}],"chunks":[{"id","text"}],"reasoning":false}`.
    Response: `choices[0].message.content` is a JSON *string*; parse it to get `{top_label, scores, labels, results:[{id, top_label, scores, matched_labels}]}`. Usage in top-level `usage.prompt_tokens`.
  - **Summarize:** `POST /v1/chat/completions` with `{"model":"summarize","max_tokens":<=1000,"messages":[{"role":"system","content":"<instructions>"},{"role":"user","content":"<text>"}]}`.
    `choices[0].message.content` is a JSON string with `summary`, `input_tokens`, `latency_ms`. It is abstractive/neutral, not witty. Gotcha: input like "Jan: ..." gets read as a person named Jan, so format timelines as "1. (Jan 2025) comment".
  - **Decisions (Jev-compatible):** `POST /v1/scaledown` works too (one item per request, `usage.cost` returned, ~220 input tokens per short comment => ~$0.000011).
- Pricing: $0.05 / M input tokens, output free.

# YouTube Data API notes (verified live 2026-10-14)

- `channels.list?part=snippet,contentDetails,statistics&forHandle=@mkbhd` works.
- `commentThreads.list?part=snippet&allThreadsRelatedToChannelId=<UC...>&maxResults=100&textFormat=plainText` still works: one paged call returns comments across the whole channel (1 quota unit per 100 comments).

# Route strategy (code)

- `classifyBatch` tries the documented `POST /classify` (no `model` field) first. On 403/404 it switches to the
  chat route above and caches the choice per process (`resetRouteCache()` in tests). 403 on the chat route is a
  run-fatal "key not permitted for classify" error. Set `route: "chat" | "native"` in `ScaledownConfig` to pin one.
- A response with no `results` array throws (never silently "all unclassified").
- Only 401, 402 and 403 are run-fatal. A batch that exhausts its retries is counted unclassified and the run
  continues (dies only after 5 failed batches in a row with nothing classified).
- Classify concurrency is AIMD: starts at 48, floor 16, ceiling 96. A 429/5xx/504/timeout multiplies it by 0.6 (at most once per 2s), +1 per success; a 429 also pauses every worker for the Retry-After (up to 60s). Per-call timeout 60s with retry. Measured: 8 conc ~25 comments/s, 32 ~84/s, 64 ~165/s.
- Rubrics + system prompt (sent as a `system` message on the chat route) were tuned on ~600 real MrBeast comments (300 top, 300 newest). Old wording over-assigned question and spam.
  Mix on 300 top comments, before -> after: supportive 183->225, funny 64->49, critical 33->21, question 13->3, spam 4->2, toxic 3->0.
  Mix on 300 newest comments, before -> after: supportive 153->249, question 79->18, spam 29->11, critical 19->14, funny 11->7, toxic 9->1.
  Lessons: "pick me / give me money" pleas and bare greetings are not questions; folding "request to be in the videos" into supportive and limiting spam to bot/promo/copy-pasted begging fixes most of it. Spam must not mention "giveaway" (it pulled in fan chatter about prizes).

# Persona tuning on the 60-video MrBeast run (2026-10-14)

- Arcs are ordered by VIDEO publish date (`buildPersonas(comments, { videos })`), not comment time. Arc minimum is 5 comments over 3+ videos spanning 14+ days; a half of two comments passes only if both are at least cool (<= -0.1) and the first/last comment agrees with the arc.
- Channel owner is excluded (`excludeAuthorIds: [channel.id]`): the "commented on 58 of 60 videos" account was the channel itself. The real most-loyal viewer is on 29 of 60.
- Hygiene: same text pasted under the same video counts once; accounts that are >= 40% spam or money-begging are never personas; reply guys need 5+ videos (or 20+ short comments over 15+ videos).
- one_bad_day now accepts one critical/toxic comment at -0.3 or lower in an otherwise warm history. Villain and redemption arcs: none exist in this data at honest thresholds (checked down to 4 comments by hand: the only candidates were anger at a contestant, not the channel).
- Summarize is abstractive and neutral. Even with a "witty, third person, 18 words" system message it often answers "They ..." / "You're ...", leaks the persona label, parrots a comment or invents a detail. So `sanitizeVerdict` only accepts a line that is <= 140 chars, handle-free, has no dates, labels or second person, is not a copy of a comment and reuses a distinctive word from the numbered timeline. About 1 in 4 survive; the rest fall back to video-title-aware templates.
- Timelines go to Summarize as `1. (Mar 2026, video "Title") comment`; "Mar: ..." is read as a person's name.
- Saved runs: `loadRun` overlays `result.json` onto the recorded final `result` event, so editing result.json (e.g. after re-tuning offline) changes what replays show. Backup of the original lives beside it as `result.orig.json`.
