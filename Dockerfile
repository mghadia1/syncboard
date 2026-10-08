# One image: the server, serving the client it was built with.

FROM node:24-alpine AS build
WORKDIR /app
# Manifests first, so the dependency layer is reused until they change.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY shared shared
COPY server server
COPY client client
RUN npm run build


FROM node:24-alpine

ENV NODE_ENV=production \
    SYNCBOARD_CLIENT_DIR=/app/client/dist

WORKDIR /app

# Production dependencies only: ws, and the link to the shared package. The
# client's packages are all devDependencies, because they are bundled into
# client/dist; neither they nor TypeScript reach this image.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# The node image's unprivileged user.
USER node
EXPOSE 8000

# Liveness only (GET /healthz).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "server/dist/healthcheck.js"]

# Node directly, as PID 1: the server handles SIGTERM itself (see main.ts).
CMD ["node", "server/dist/main.js"]
