# Build context is the repository root (see infra/lib/upload-pipeline-stack.ts).
FROM node:26-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/data/package.json packages/data/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY functions/package.json functions/
COPY infra/package.json infra/
RUN npm ci --workspace=@s3up/api --include-workspace-root
COPY packages packages
COPY apps/api apps/api
RUN npm run build --workspace=@s3up/api

FROM node:26-slim
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build /repo/apps/api/dist/main.js ./main.js
USER node
EXPOSE 3001
CMD ["node", "main.js"]
