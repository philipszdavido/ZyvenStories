# Upgrade path

## Track 1: your own bigger story bot (PyTensorForge)
1. `python scripts/stories_to_chat_varied.py data/pretrain --out data/chat-story --max-stories 100000`
2. Time 20 steps: `python cli.py train configs/pretrain-medium.yaml --device mps`  (Ctrl-C, then delete checkpoints-medium)
3. Full stage 1 (hours): `caffeinate -i python cli.py train configs/pretrain-medium.yaml --device mps --duty-cycle 0.7`
4. Stage 2: `python cli.py train configs/chat-story-medium.yaml`
5. Export: `python cli.py export checkpoints-story-medium/checkpoint_latest.ptf --output exports/mygpt-medium --tokenizer tokenizer.json --dtype float16`
6. Serve: `python cli.py serve exports/mygpt-medium --name my-gpt`

## Track 2: a genuinely capable assistant (facts, reasoning, code)
Use an existing open model through Apple's MLX. See the chat reply for commands.
