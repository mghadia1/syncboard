# The load generator (bench/load.ts), run on the servers' Compose network.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
# Dev dependencies too: tsx runs the TypeScript.
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
RUN npm run build -w shared
COPY bench/load.ts bench/
USER node
ENTRYPOINT ["node", "--import", "tsx", "bench/load.ts"]
