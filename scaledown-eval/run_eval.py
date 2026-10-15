"""Reproducible eval for the ScaleDown vibe classifier (slm-agent optimize method, classify playbook).

Ground truth = Claude Opus referee labels from the model showdown (samples.jsonl, gitignored: real comment text).
Endpoint = the one the app uses in production: POST /v1/chat/completions, model "classify", batched chunks
(the documented POST /classify answers 403/502 for our key, see docs/SCALEDOWN_NOTES.md).

Prompt file: {"system": "<system prompt>", "labels": [{"name", "rubric"}, ...]}

    set -a; . ./.env.local; set +a
    python3 scaledown-eval/run_eval.py --prompt scaledown-eval/prompt_v1.json --split tune --json-out m.json
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BATCH = 20


def post(base, key, body, timeout=60):
    req = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "content-type": "application/json"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (401, 402, 403):
                sys.exit(f"ScaleDown rejected the key ({e.code})")
            if attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def classify(rows, prompt, base, key):
    body = {
        "model": "classify",
        "messages": [{"role": "system", "content": prompt["system"]}, {"role": "user", "content": "Label each comment."}],
        "labels": prompt["labels"],
        "chunks": [{"id": r["id"], "text": r["input_text"][:600]} for r in rows],
        "reasoning": False,
    }
    res = post(base, key, body)
    content = json.loads(res["choices"][0]["message"]["content"])
    out = {x["id"]: x.get("top_label") for x in content.get("results", [])}
    return out, res.get("usage", {}).get("prompt_tokens", 0)


def metrics(rows, pred):
    labels = sorted({r["baseline_output"] for r in rows} | {p for p in pred.values() if p})
    conf = {g: Counter() for g in labels}
    for r in rows:
        conf[r["baseline_output"]][pred.get(r["id"]) or "none"] += 1
    per = {}
    for c in labels:
        tp = conf.get(c, Counter())[c]
        fp = sum(conf[g][c] for g in labels if g != c)
        fn = sum(conf.get(c, Counter()).values()) - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        per[c] = {"precision": round(p, 3), "recall": round(rc, 3), "f1": round(2 * p * rc / (p + rc), 3) if p + rc else 0.0, "support": tp + fn}
    present = [c for c in labels if per[c]["support"]]
    acc = sum(pred.get(r["id"]) == r["baseline_output"] for r in rows) / len(rows)
    return {
        "n": len(rows),
        "accuracy": round(acc, 3),
        "macro_f1": round(sum(per[c]["f1"] for c in present) / len(present), 3),
        "per_class": per,
        "confusion": {g: dict(conf[g]) for g in labels},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--split", choices=["tune", "holdout", "all"], default="tune")
    ap.add_argument("--ids", help="comma list or file of ids (subset run)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--json-out")
    ap.add_argument("--tag", default="")
    a = ap.parse_args()

    key = os.environ.get("SCALEDOWN_API_KEY", "").strip()
    if not key:
        sys.exit("Set SCALEDOWN_API_KEY in the environment")
    base = os.environ.get("SCALEDOWN_BASE_URL", "https://api.scaledown.xyz").rstrip("/")
    prompt = json.load(open(a.prompt))
    rows = [json.loads(l) for l in open(os.path.join(HERE, "samples.jsonl"))]
    if a.split != "all":
        rows = [r for r in rows if r["split"] == a.split]
    subset = None
    if a.ids:
        ids = set(open(a.ids).read().split() if os.path.exists(a.ids) else a.ids.split(","))
        rows = [r for r in rows if r["id"] in ids]
        subset = {"ids": a.ids, "n": len(rows)}
    if a.limit:
        rows = rows[: a.limit]

    pred, tokens = {}, 0
    batches = [rows[i : i + BATCH] for i in range(0, len(rows), BATCH)]
    with ThreadPoolExecutor(a.concurrency) as ex:
        for (out, t), b in zip(ex.map(lambda b: classify(b, prompt, base, key), batches), batches):
            pred.update(out)
            tokens += t
            for r in b:
                ok = "ok  " if out.get(r["id"]) == r["baseline_output"] else "MISS"
                print(f"{ok} {r['id'][:10]} want={r['baseline_output']:<10} got={out.get(r['id'])}", flush=True)

    m = metrics(rows, pred)
    m.update({"prompt": a.prompt, "split": a.split, "tag": a.tag, "subset": subset, "input_tokens": tokens, "usd": round(tokens * 0.05 / 1e6, 5)})
    m["predictions"] = pred
    print(json.dumps({k: m[k] for k in ("tag", "split", "n", "accuracy", "macro_f1", "usd")}))
    if a.json_out:
        json.dump(m, open(a.json_out, "w"), indent=1)


if __name__ == "__main__":
    main()
