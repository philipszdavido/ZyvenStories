from pytensorforge.tokenization.registry import load_tokenizer
from pytensorforge.training.checkpoint_manager import CheckpointManager

tokenizer = load_tokenizer("tokenizer.json")
checkpoint = CheckpointManager("checkpoints").load("checkpoint_latest.ptf")

print("Current tokenizer:")
print(tokenizer.identity)

print("\nCheckpoint tokenizer:")
print(checkpoint["tokenizer_identity"])