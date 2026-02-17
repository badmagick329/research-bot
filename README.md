# Research Bot

A research automation bot that aggregates financial news, market metrics, and SEC filings to generate investment research snapshots using local LLM inference.

## Overview

Research Bot uses **Clean Architecture** principles to create a maintainable, testable system for financial research automation. The system processes data through a multi-stage pipeline:

```
Ingest → Normalize → Embed → Synthesize
```

Each stage runs as an isolated queue job with configurable concurrency and automatic retry logic.

## Features

- **Multi-Source Data Aggregation**: Integrates Finnhub, Alpha Vantage, and SEC EDGAR APIs
- **Local LLM Inference**: Uses Ollama for chat and embeddings (privacy-first, no external API calls)
- **Queue-Based Pipeline**: BullMQ with Redis for resilient, scalable processing
- **Vector Search**: PostgreSQL with pgvector for semantic document retrieval
- **Comprehensive Testing**: Unit tests with mock providers for all external dependencies

## Prerequisites

- **Bun** runtime (latest version)
- **Docker** and Docker Compose (for infrastructure)
- **Ollama** (for local LLM inference)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd research-bot
bun install
```

### 2. Set Up Infrastructure

Start PostgreSQL and Redis:

```bash
docker-compose up -d
```

### 3. Run Database Migrations

```bash
bun run db:migrate
```

### 4. Configure Environment

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` and set your configuration:

```bash
# Symbols to track (comma-separated)
APP_SYMBOLS=AAPL,MSFT,NVDA

# News providers (comma-separated: finnhub,alphavantage,mock)
NEWS_PROVIDERS=finnhub,alphavantage

# API Keys
FINNHUB_API_KEY=your_key_here
ALPHA_VANTAGE_API_KEY=your_key_here

# Metrics and filings providers
METRICS_PROVIDER=alphavantage  # or 'mock'
FILINGS_PROVIDER=sec-edgar     # or 'mock'

# Ollama configuration
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b-instruct
OLLAMA_EMBED_MODEL=nomic-embed-text
```

### 5. Start Ollama

Ensure Ollama is running with the required models:

```bash
ollama pull qwen2.5:7b-instruct
ollama pull nomic-embed-text
```

### 6. Run the Application

**Option A: Continuous mode** (automatic scheduling):
```bash
bun run dev
```

**Option B: Manual mode** (enqueue jobs manually):
```bash
# In one terminal, start the worker:
bun run worker

# In another terminal, enqueue jobs:
bun run enqueue
```

### 7. Check Status

```bash
bun run status
```

### 8. View Research Snapshots

```bash
bun run snapshot
```

## Architecture

This project follows **Clean Architecture** with strict layer boundaries:

```
src/
├── core/              # Domain entities and port interfaces
│   ├── entities/      # Domain models (Document, Metric, Filing, etc.)
│   └── ports/         # Interfaces for adapters (providers, repositories)
├── application/       # Business logic and orchestration
│   ├── services/      # Use-case services (Ingestion, Synthesis, etc.)
│   └── bootstrap/     # Dependency injection and wiring
├── infra/             # Infrastructure adapters
│   ├── providers/     # External API adapters (Finnhub, Alpha Vantage, SEC)
│   ├── db/           # Database schema and repositories
│   ├── llm/          # Ollama integration
│   ├── queue/        # BullMQ queue implementation
│   └── system/       # Clock, ID generation, task factory
├── cli/              # Command-line interface
├── workers/          # Queue job processors
└── shared/           # Configuration and logging
```

### Key Principles

- **Core** layer has no external dependencies
- **Application** layer depends only on Core
- **Infrastructure** layer implements Core interfaces
- All external I/O is abstracted behind port interfaces
- Dependency injection via `runtimeFactory.ts`

## Available Commands

```bash
bun run dev          # Start continuous research loop
bun run enqueue      # Enqueue jobs for configured symbols
bun run worker       # Start queue worker process
bun run status       # Show queue status and job counts
bun run snapshot     # Display latest research snapshots
bun run db:migrate   # Run database migrations
bun run typecheck    # Run TypeScript type checking
bun run test         # Run all tests
```

## Testing

Run the test suite:

```bash
bun test
```

Tests are organized in `src/__tests__/` and mirror the source structure:

```
src/__tests__/
├── application/services/    # Service tests
└── infra/providers/         # Provider adapter tests
```

## Configuration

Key environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_SYMBOLS` | Stock symbols to track | `AAPL,MSFT,NVDA` |
| `APP_RESEARCH_INTERVAL_SECONDS` | Research cycle interval | `300` |
| `APP_LOOKBACK_DAYS` | Days of historical data | `7` |
| `NEWS_PROVIDERS` | News providers (comma-separated) | `mock` |
| `METRICS_PROVIDER` | Metrics provider | `mock` |
| `FILINGS_PROVIDER` | Filings provider | `mock` |
| `OLLAMA_CHAT_MODEL` | LLM model for synthesis | `qwen2.5:7b-instruct` |
| `OLLAMA_EMBED_MODEL` | Embedding model | `nomic-embed-text` |

See `.env.example` for complete configuration options.

## Provider Configuration

### News Providers

- **finnhub**: Requires `FINNHUB_API_KEY`
- **alphavantage**: Requires `ALPHA_VANTAGE_API_KEY`
- **mock**: No configuration needed (generates sample data)

### Metrics Provider

- **alphavantage**: Requires `ALPHA_VANTAGE_API_KEY`
- **mock**: No configuration needed

### Filings Provider

- **sec-edgar**: No API key required (uses public SEC API)
- **mock**: No configuration needed

## Development

### Type Checking

```bash
bun run typecheck
```

### Path Aliases

The project uses TypeScript path aliases for cleaner imports:

```typescript
import { DocumentEntity } from "@/core/entities/document";
import { IngestionService } from "@/application/services/ingestionService";
import { PostgresDocumentRepository } from "@/infra/db/repositories";
```

## Documentation

- **[ARCHITECTURE_AND_OPERATIONS.md](./ARCHITECTURE_AND_OPERATIONS.md)**: Detailed architecture documentation
- **[AGENTS.md](./AGENTS.md)**: Information about AI agents (if applicable)

## License

Private project - All rights reserved.
