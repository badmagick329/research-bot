# research-bot

TypeScript + Bun CLI for company research workflow orchestration.

## v0 scope

- Clean architecture boundaries
- BullMQ staged workers (`ingest -> normalize -> embed -> synthesize`)
- Postgres + pgvector persistence
- Ollama integration for summarize/synthesize + embeddings
- Mock data-provider adapters only (no real news/market/filings APIs yet)

## Architecture

- `src/core`: entities + ports/interfaces
- `src/application`: use-case orchestration services (service suffix)
- `src/infra`: adapter implementations (db, queue, providers, llm)
- `src/workers`: BullMQ workers by stage
- `src/cli`: CLI commands (`run`, `enqueue`, `status`, `snapshot`)

## Setup

1. Copy env file:

```bash
cp .env.example .env
```

2. Install deps:

```bash
bun install
```

3. Start infra and processes via Docker Compose:

```bash
docker compose up --build
```

Notes:

- Ollama is expected on host machine.
- Containers use `OLLAMA_BASE_URL=http://host.docker.internal:11434`.

## Local commands

```bash
bun run src/index.ts run
bun run src/index.ts enqueue --symbol AAPL
bun run src/index.ts snapshot --symbol AAPL
bun run src/index.ts status
bun run src/workers/main.ts
```

## Validation

```bash
bun run typecheck
bun run db:migrate
```

## Provider readiness

Mock adapters in `src/infra/providers/mocks` follow normalized DTOs aligned to expected real-world payload shape:

- News: provider IDs, publication metadata, symbols/topics, raw payload retention
- Metrics: metric name/value/unit, period typing, confidence, raw payload
- Filings: filing metadata, sections, extracted facts, raw payload

Swap-in path later: implement core inbound ports in `src/core/ports/inboundPorts.ts` with real providers and register in runtime factory.
