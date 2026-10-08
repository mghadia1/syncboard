.PHONY: install check lint typecheck test build dev-server dev-client up down reset smoke

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
