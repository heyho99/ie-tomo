# サーバー（Cloud Run）。画面は Firebase Hosting で配るので入れない（README.md の「デプロイ」）
FROM node:24-slim
WORKDIR /app

# 依存を先に入れる（キャッシュを効かせる）。lock の整合のため client の package.json も置く
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci -w server --include-workspace-root

COPY server server

ENV NODE_ENV=production
# サーバーは開発と同じく tsx で TypeScript をそのまま動かす（PORT は Cloud Run が 8080 を渡す）
CMD ["npx", "tsx", "server/src/index.ts"]
