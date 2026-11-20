# ---------- builder: install deps, then bundle into self-contained JS ----------
FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY server ./server
RUN bun build server/index.js  --target node --outfile dist/mailbench.js && \
    bun build server/worker.js --target node --outfile dist/worker.js

# ---------- runtime: plain Node, NO node_modules ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Only the bundles + static assets. Dependencies are compiled into the JS.
COPY --from=builder /app/dist/mailbench.js ./server/mailbench.js
COPY --from=builder /app/dist/worker.js    ./server/worker.js
COPY public ./public

# Secrets come from the Render environment (or --env-file / -e locally):
# ACCESS_TOKEN, RESEND_API_KEY, EMAILJS_*, REDIS_URL, QUEUE_PREFIX, ...

USER node
EXPOSE 3000
CMD ["node", "server/mailbench.js"]
