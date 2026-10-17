#!/usr/bin/env python3
"""Ask a running PyTensorForge server a fixed set of questions and print the answers, so you can judge the model by
reading, not guessing.

    python cli.py serve exports/mygpt-general --name my-gpt          # in another terminal
    python scripts/probe_chat.py --url http://127.0.0.1:8000 --model my-gpt

Add --out answers.txt to keep the transcript and compare two checkpoints side by side.
"""
import argparse
import json
import sys
import urllib.request

PROMPTS = [
    ("fact", "What is the capital of France?"),
    ("fact", "Who wrote the play Romeo and Juliet?"),
    ("fact", "Why is the sky blue?"),
    ("fact", "What do plants need to grow?"),
    ("explain", "Explain what a computer is to a child."),
    ("reason", "If I have 3 apples and eat 1, how many are left?"),
    ("reason", "Tom is taller than Sam. Sam is taller than Max. Who is the tallest?"),
    ("code", "Write a Python function that adds two numbers."),
    ("code", "Write a Python loop that prints the numbers 1 to 5."),
    ("chat", "Hello! How are you today?"),
    ("chat", "Give me three tips for studying."),
    ("story", "Tell me a short story about a dog."),
]


def ask(url, model, prompt, a):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": a.max_tokens,
                       "temperature": a.temperature, "top_k": a.top_k, "top_p": a.top_p,
                       "repetition_penalty": a.repetition_penalty, "stream": False}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"].strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--model", default="my-gpt")
    ap.add_argument("--max-tokens", type=int, default=160)
    # Small models fall into loops at very low temperature with no repetition penalty, so these defaults are
    # deliberately not "greedy". Use --temperature 0 --repetition-penalty 1 to see the raw behaviour.
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--top-k", type=int, default=40)
    ap.add_argument("--top-p", type=float, default=0.9)
    ap.add_argument("--repetition-penalty", type=float, default=1.15)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    lines = []
    for kind, prompt in PROMPTS:
        try:
            answer = ask(a.url, a.model, prompt, a)
        except Exception as exc:
            sys.exit(f"request failed ({exc}). Is the server running at {a.url} with --name {a.model}?")
        block = f"[{kind}] {prompt}\n{answer}\n"
        print(block)
        lines.append(block)

    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print(f"saved to {a.out}")


if __name__ == "__main__":
    main()
