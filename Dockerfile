FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# pytensorforge brings numpy and pyyaml with it. aiohttp runs the analytics gateway.
RUN pip install --no-cache-dir "pytensorforge==0.2.0" "aiohttp==3.10.10"

COPY cli.py ./
COPY web/dist ./web/dist
COPY serve.yaml ./serve.yaml
COPY start.sh ./start.sh
COPY scripts/fetch_model.py ./scripts/fetch_model.py
COPY gateway ./gateway
RUN chmod +x start.sh

# Model weights are NOT baked into the image. start.sh downloads them into
# MODEL_DIR (a persistent disk mounted at /data) on first boot.
# Analytics are stored in /data/analytics.db on the same disk.
ENV MODEL_DIR=/data/model \
    ANALYTICS_DB=/data/analytics.db

RUN useradd --create-home --uid 10001 ptf \
 && mkdir -p /data && chown -R ptf:ptf /app /data
USER ptf

EXPOSE 8000
CMD ["./start.sh"]
