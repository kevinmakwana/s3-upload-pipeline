# The large-object worker: one AWS Batch job processes one object (see infra/lib/upload-pipeline-stack.ts).
# Build context is the repository root.
FROM node:26-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/data/package.json packages/data/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY functions/package.json functions/
COPY infra/package.json infra/
RUN npm ci --workspace=@s3up/functions --include-workspace-root
COPY packages packages
COPY functions functions
RUN npm run build --workspace=@s3up/functions

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/functions/dist/large-worker.js ./large-worker.js
USER node
CMD ["node", "large-worker.js"]
