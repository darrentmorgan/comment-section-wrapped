# Model showdown: server notes (verified live 2026-10-14)

Run: `pnpm showdown --run <runId> [--n 1000] [--referee-n 250] [--extra 20] [--only a,b] [--skip a,b] [--fresh]`.
Reads `.runs/<id>/comments.jsonl`, writes `.runs/<id>/showdown.json` (gitignored). Resumable: finished items are kept in
`showdown.partial.jsonl`, and a finished showdown with the same seed and questions is reused, so growing `--referee-n` or
adding a newly keyed lane only pays for what is new. API: `GET /api/runs/<id>/showdown` (summary + disagreements),
`?stream=1` (SSE replay of the race), `?mock=1` (SIMULATED), `POST` (live run, localhost only).

Readers: ScaleDown classify-1 (per comment), ScaleDown batch classify, Jev 1.13, Haiku 5.5, Gemma 4 26B, GPT-5.6 Luna,
two free baselines (always supportive, keyword rules), the saved labels, and Opus 5.5 / Sonnet 5.5 as referees on a subset.
A lane with no key is marked "waiting for <KEY>" and lights up on the next run.

Findings that shaped the code:
- Jev's `noul` question needs `instructions` plus `criteria: {true, false}`. ScaleDown accepts the same shape, so both get identical questions.
- OpenRouter `provider.require_parameters: true` returns 404 "No endpoints found" for Anthropic and OpenAI models. Not sent.
- Haiku, Luna and Gemma accept `reasoning: {effort: "none"}`. Sonnet and Opus refuse it ("Reasoning is mandatory"), so referees use effort `low` and a 2000 token budget. A 400 that mentions reasoning steps down the ladder none, low, omitted.
- Measured cost per 1,000 comments (API-reported `usage.cost`): ScaleDown batch $0.013, Gemma $0.017, Jev $0.020, ScaleDown classify-1 $0.030, Haiku $0.060, Luna $0.064, Sonnet referee $1.20, Opus referee $2.49.
- "Agreement with the referee" is the only accuracy-like number. The referee is a model, and the sample leans on the original ScaleDown batch labels, so say so wherever it is shown.
- Only about 1 comment in a 125-comment referee set is judged hateful, so the toxic comparison is anecdotal.
