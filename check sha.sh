curl -L -o check.tar.gz "https://huggingface.co/chidumend/mygpt/blob/main/my-gpt.tar.gz"
ls -l check.tar.gz
file check.tar.gz
shasum -a 256 check.tar.gz
tar tzf check.tar.gz | head
shasum -a 256 my-gpt.tar.gz      # your local archive