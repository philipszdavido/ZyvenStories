#!/usr/bin/env python3
"""Turn TinyStories-style text into chat conversations with VARIED requests, so a small story bot learns to follow
what it is asked: a subject, a character name, two subjects, required words, an ending, and a length.

    python scripts/stories_to_chat_varied.py data/pretrain --out data/chat-story --max-stories 100000

Every request is derived from the story itself (the name, subject or words really appear in it), so the reply always
matches the request. Stories that match nothing get a generic request. Output format is the same as
stories_to_chat.py: data/chat-story/train/*.jsonl and data/chat-story/val.jsonl.
"""
import argparse
import json
import os
import random
import re
import sys

SUBJECTS = [
    "boy", "girl", "dog", "cat", "rabbit", "bird", "fish", "bear", "duck", "mouse", "frog", "monkey", "lion",
    "elephant", "horse", "pig", "cow", "turtle", "butterfly", "princess", "king", "queen", "mom", "dad", "teacher",
    "robot", "dragon", "fairy", "toy", "ball", "doll", "car", "boat", "tree", "flower", "garden", "park", "beach",
    "farm", "school", "cake", "balloon", "kite", "bike", "spider", "owl", "squirrel", "fox", "wolf", "bee", "snail",
]
SUBJECT_RE = re.compile(r"\b(" + "|".join(SUBJECTS) + r")s?\b", re.I)
NAME_RE = re.compile(r"\b(?:named|called)\s+([A-Z][a-z]{2,})\b")
STOP = set("""that this with from have were they them then there their what when where which while would could should
about into over after before because again just very much some many also only like said says went came made make
one two three each other your you and the for was had her his she him its out all can not but are who how why day
time once upon little big""".split())
HAPPY = re.compile(r"\b(happy|smiled|laughed|fun|loved|hugged|friends)\b", re.I)
SAD = re.compile(r"\b(sad|cried|tears|lost|alone|never)\b", re.I)

T_SUBJECT = ["Tell me a story about a {s}.", "Tell me a short story about a {s}.", "Write a short story about a {s}.",
             "Can you tell me a story with a {s} in it?", "I want a story about a {s}.", "Please tell me a story about a {s}."]
T_NAME = ["Tell me a story about a character named {n}.", "Write a short story about {n}.",
          "Can you tell me a story about someone called {n}?", "I want a story where the main character is {n}."]
T_TWO = ["Tell me a story with a {a} and a {b}.", "Write a short story that has a {a} and a {b} in it.",
         "Can you tell me a story about a {a} and a {b}?"]
T_WORDS = ["Tell me a story that uses the words \"{a}\" and \"{b}\".", "Write a short story that includes \"{a}\" and \"{b}\".",
           "Make up a story with the words \"{a}\" and \"{b}\" in it."]
T_HAPPY = ["Tell me a story with a happy ending.", "Write a short story that ends happily."]
T_SAD = ["Tell me a story with a sad part.", "Write a short story that has a sad moment in it."]
T_SHORT = ["Tell me a very short story.", "Write a tiny story."]
T_LONG = ["Tell me a longer story.", "Write a story with a bit more detail."]
GENERIC = ["Tell me a story.", "Tell me a short story.", "Can you tell me a story?", "Write me a short story.",
           "I want to hear a story.", "Please tell me a story."]


def pick_request(story, rng):
    head = story[:300]
    candidates = []

    m = NAME_RE.search(story[:250])
    if m and story.count(m.group(1)) >= 2:
        candidates.append(("name", rng.choice(T_NAME).format(n=m.group(1))))

    subs = []
    for mm in SUBJECT_RE.finditer(head):
        s = mm.group(1).lower()
        if s not in subs:
            subs.append(s)
    if subs:
        candidates.append(("subject", rng.choice(T_SUBJECT).format(s=subs[0])))
    if len(subs) >= 2:
        candidates.append(("two", rng.choice(T_TWO).format(a=subs[0], b=subs[1])))

    words = []
    for w in re.findall(r"[A-Za-z]{5,}", story.lower()):
        if w not in STOP and w not in words:
            words.append(w)
    if len(words) >= 6:
        a, b = rng.sample(words[:40], 2)
        candidates.append(("words", rng.choice(T_WORDS).format(a=a, b=b)))

    tail = story[-160:]
    if HAPPY.search(tail) and not SAD.search(tail):
        candidates.append(("happy", rng.choice(T_HAPPY)))
    elif SAD.search(story) and HAPPY.search(tail):
        candidates.append(("sad", rng.choice(T_SAD)))

    if len(story) < 330:
        candidates.append(("short", rng.choice(T_SHORT)))
    elif len(story) > 560:
        candidates.append(("long", rng.choice(T_LONG)))

    if not candidates or rng.random() < 0.08:
        return "generic", rng.choice(GENERIC)

    return rng.choice(candidates)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-stories", type=int, default=100000)
    ap.add_argument("--max-chars", type=int, default=700)
    ap.add_argument("--min-chars", type=int, default=150)
    ap.add_argument("--val-fraction", type=float, default=0.02)
    ap.add_argument("--parts", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1234)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    os.makedirs(os.path.join(a.out, "train"), exist_ok=True)
    parts = [open(os.path.join(a.out, "train", f"part-{i:04d}.jsonl"), "w", encoding="utf-8") for i in range(a.parts)]
    val = open(os.path.join(a.out, "val.jsonl"), "w", encoding="utf-8")

    paths = []
    for p in a.inputs:
        if os.path.isdir(p):
            paths += [os.path.join(r, n) for r, _, ns in sorted(os.walk(p)) for n in sorted(ns) if n.endswith(".jsonl")]
        else:
            paths.append(p)

    kinds = {}
    n = {"train": 0, "val": 0, "long": 0, "short": 0}
    done = False
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    story = json.loads(line).get("text", "").strip()
                except (json.JSONDecodeError, AttributeError):
                    continue
                if len(story) < a.min_chars:
                    n["short"] += 1
                    continue
                if len(story) > a.max_chars:
                    n["long"] += 1
                    continue
                kind, prompt = pick_request(story, rng)
                kinds[kind] = kinds.get(kind, 0) + 1
                rec = json.dumps({"messages": [{"role": "user", "content": prompt},
                                               {"role": "assistant", "content": story}]}, ensure_ascii=False) + "\n"
                if rng.random() < a.val_fraction:
                    val.write(rec); n["val"] += 1
                else:
                    rng.choice(parts).write(rec); n["train"] += 1
                if n["train"] + n["val"] >= a.max_stories:
                    done = True
                    break
        if done:
            break

    for p in parts:
        p.close()
    val.close()
    print(f"train: {n['train']}  val: {n['val']}  too long: {n['long']}  too short: {n['short']}")
    print("request types:", ", ".join(f"{k}={v}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])))
    if n["train"] == 0:
        sys.exit("no stories written: check the input path and --max-chars")


if __name__ == "__main__":
    main()
