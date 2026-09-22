FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --cache /app/.npm-cache
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# Python is used only by the separately mounted github_status_board collector.
# Webhooks, App signing, queues and the management API run entirely in Node.
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home sdbot \
    && mkdir -p /data && chown sdbot:sdbot /data
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY static ./static
COPY fixtures ./fixtures
USER sdbot
ENV SDBOT_DATA_DIR=/data \
    SDBOT_WEBHOOK_HOST=0.0.0.0 \
    SDBOT_WEBHOOK_PORT=8791 \
    SDBOT_ADMIN_HOST=0.0.0.0 \
    SDBOT_ADMIN_PORT=8792 \
    SDBOT_ALLOW_NON_LOOPBACK=1

EXPOSE 8791 8792
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:8791/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/node/server.js"]
