# sciencediscovery_bot: webhook receiver and optional GitHub App publisher.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./
COPY sdbot ./sdbot
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY static ./static

# Unprivileged user; /data holds events.jsonl + payloads (a named volume in compose).
RUN useradd --system --uid 10001 --create-home sdbot \
    && mkdir -p /data && chown sdbot:sdbot /data
USER sdbot

# Inside the container both listeners bind all interfaces; compose publishes the admin
# port to 127.0.0.1 only and the tunnel is told about the webhook port only.
ENV PYTHONUNBUFFERED=1 \
    SDBOT_DATA_DIR=/data \
    SDBOT_WEBHOOK_HOST=0.0.0.0 \
    SDBOT_WEBHOOK_PORT=8791 \
    SDBOT_ADMIN_HOST=0.0.0.0 \
    SDBOT_ADMIN_PORT=8792 \
    SDBOT_ALLOW_NON_LOOPBACK=1

EXPOSE 8791 8792
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/healthz', timeout=3)" || exit 1

CMD ["python3", "server.py"]
