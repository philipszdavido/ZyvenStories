#!/bin/sh
set -eu

# 1. Make sure the model is present (downloads only when missing or changed).
python scripts/fetch_model.py

# 2. Start the gateway on the public port. It launches the model server on
#    127.0.0.1:8001, records analytics and serves the dashboard at /analytics.
exec python gateway/server.py
