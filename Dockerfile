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
    SYNCBOARD_CLIENT_DIR=/app/client/dist \
    SYNCBOARD_DATA_DIR=/data

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

# Boards live in /data (boards.sqlite), a volume. Made here and owned by
# the unprivileged user, because a new named volume copies the ownership of
# the directory it is mounted over.
RUN mkdir -p /data && chown node:node /data

# The node image's unprivileged user.
USER node
EXPOSE 8000

# GET /healthz: up and answering, and able to store boards (503 if not).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "server/dist/healthcheck.js"]

# Node directly, as PID 1: the server handles SIGTERM itself (see main.ts).
CMD ["node", "server/dist/main.js"]
