# A general-purpose chat GPT, trained from scratch with PyTensorForge on your Mac

Honest expectations first. This is a ~27M-parameter model trained on ~0.5 billion tokens. Expect: readable English,
a chat-shaped answer to almost any question, a few very common facts right, and many wrong answers stated confidently.
Arithmetic, multi-step reasoning and code will be weak (toy snippets at best). That is the size of the model, not a bug.
For answers you can rely on, use a pretrained model with MLX LM (see the chat reply).

## 0. Keep your story bot safe
Copy `exports/mygpt`, `tokenizer.json`, `checkpoints-story` somewhere. This pipeline uses new names (`*-general`) so it
will not overwrite them, but back up anyway.

## 1. Data (internet needed; about 2-3 GB on disk)
    pip install datasets
    python scripts/download_datasets.py fineweb-edu-dedup --max-docs 300000 --out data/general-pretrain
    python scripts/download_datasets.py cosmopedia-v2     --max-docs 200000 --out data/general-pretrain
Check each dataset's licence on its Hugging Face page. Do NOT put TinyStories in this folder.

## 2. Tokenizer (16,384 tokens, trained on the new data)
    python cli.py tokenize data/general-pretrain --output tokenizer-general.json --vocab-size 16384 \
        --special-token "<|system|>" --special-token "<|user|>" --special-token "<|assistant|>" --special-token "<|end|>"

## 3. Time it before you commit (20 steps)
    python cli.py train configs/pretrain-general.yaml --device mps
Watch Memory Pressure and the tok/s line, Ctrl-C after ~20 steps, then `rm -rf checkpoints-general`.
Planning number: 490M tokens / your tok/s. At about 4,000 tok/s that is ~34 hours (my estimate, not measured).
If it is far slower, lower `d_model`/`n_layers` or `total_steps`.

## 4. Pretrain (long; resumable)
    caffeinate -i python cli.py train configs/pretrain-general.yaml --device mps --duty-cycle 0.7
Stop any time with Ctrl-C; continue with:
    caffeinate -i python cli.py resume checkpoints-general/checkpoint_latest.ptf --config configs/pretrain-general.yaml --device mps --duty-cycle 0.7
Loss starts near 9.7 (ln 16384). Read the `eval` lines: they should keep falling. I expect it to settle somewhere around
3.5-4.5 (a guess), which is a fluent-but-shallow model.

## 5. Chat data
    python scripts/download_datasets.py smoltalk   --max-docs 200000 --out data/chat-raw
    python scripts/download_datasets.py no_robots  --out data/chat-raw
    python scripts/download_datasets.py dolly      --out data/chat-raw
    python scripts/prepare_chat_data.py data/chat-raw --out data/chat-general --max-chars 1800
`--max-chars 1800` DROPS long conversations so everything fits in 512 tokens and nothing is cut off mid-answer. (Your
first attempt used the 8000 default with 256-token windows, which chopped answers and taught the model to ramble.)

## 6. Chat fine-tune, export, serve
    python cli.py train configs/chat-general.yaml --device mps
    python cli.py export checkpoints-chat-general/checkpoint_latest.ptf --output exports/mygpt-general \
        --tokenizer tokenizer-general.json --dtype float16
    python cli.py serve exports/mygpt-general --name my-gpt --port 8001

## 7. Judge it by reading
    python scripts/probe_chat.py --url http://127.0.0.1:8001 --model my-gpt --out answers-v1.txt
Twelve fixed questions (facts, easy reasoning, tiny code, chat). Re-run after any change and compare the files.
