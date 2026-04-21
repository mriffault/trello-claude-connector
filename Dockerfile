# syntax=docker/dockerfile:1.7

# ---- Builder stage: full Node image with build tools for native modules ----
FROM node:20-bookworm AS builder

WORKDIR /app

# Copy manifests + sources together. Rationale: package.json declares a
# `prepare` script that runs `npm run build`, which requires src/ and
# tsconfig.json to be present *during* `npm install`. So we stage all of it
# before installing.
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src

# Installs deps AND runs `prepare` -> produces dist/.
RUN npm install --include=dev

# Drop dev deps so we ship a slim node_modules to runtime.
RUN npm prune --omit=dev

# ---- Runtime stage: slim image, non-root user ------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

# Node is PID 1 so it receives SIGTERM directly and can shut down gracefully.
CMD ["node", "dist/http-server.js"]
