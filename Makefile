.PHONY: bench install check lint typecheck test test-redis build dev-server dev-client up down reset smoke up-replicas down-replicas smoke-replicas

# Node 24 (see .nvmrc; `nvm use` picks it up).

install:
	npm ci

check:
	npm run check

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

# The bus tests against a real Redis, in a throwaway container.
test-redis:
	./scripts/test-redis.sh

build:
	npm run build

# The server on :8000, restarting on changes (needs the client built for /).
dev-server:
	npm run dev:server

# The client on :5173, forwarding /healthz and /ws to :8000.
dev-client:
	npm run dev:client

up:
	docker compose up --build --detach --wait

down:
	docker compose down

# Also delete the boards (the data volume).
reset:
	docker compose down --volumes

# Check a fresh stack over HTTP and WebSockets from outside. It runs as its
# own Compose project on :8301, so it never touches the stack of `make up`.
SMOKE = COMPOSE_PROJECT_NAME=syncboard-smoke SYNCBOARD_PORT=8301

smoke:
	$(SMOKE) docker compose up --build --detach --wait
	$(SMOKE) ./scripts/smoke.sh || ($(SMOKE) docker compose logs; $(SMOKE) docker compose down --volumes; exit 1)
	$(SMOKE) docker compose down --volumes

# Two servers sharing boards (one data volume, Redis between them), on
# :8310 and :8311.
REPLICAS = docker compose -f compose.replicas.yaml

up-replicas:
	$(REPLICAS) up --build --detach --wait

down-replicas:
	$(REPLICAS) down

# The same checks for the two-server stack, as its own project on :8312
# and :8313, deleted afterwards.
SMOKE_REPLICAS = COMPOSE_PROJECT_NAME=syncboard-replicas-smoke SYNCBOARD_PORT_A=8312 SYNCBOARD_PORT_B=8313

smoke-replicas:
	$(SMOKE_REPLICAS) $(REPLICAS) up --build --detach --wait
	$(SMOKE_REPLICAS) ./scripts/smoke-replicas.sh || ($(SMOKE_REPLICAS) $(REPLICAS) logs; $(SMOKE_REPLICAS) $(REPLICAS) down --volumes; exit 1)
	$(SMOKE_REPLICAS) $(REPLICAS) down --volumes

# The benchmark (bench/run.ts): one and two servers under load, two passes,
# swap-checked; results in bench/results/<timestamp>/. About 10 minutes.
bench:
	node --import tsx bench/run.ts
