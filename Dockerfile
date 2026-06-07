# ── ビルドステージ ────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# ── 実行ステージ ──────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# セキュリティ: rootで動かさない
RUN addgroup --system aibo && adduser --system --ingroup aibo aibo

COPY --from=builder /app/node_modules ./node_modules
COPY --chown=aibo:aibo . .

USER aibo

# Cloud Run はPORTを自動で設定する
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
