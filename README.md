# Payment Processing System

> Full-cycle marketplace payment platform with escrow and seller payouts

**Tech Stack:** NestJS, Prisma, PostgreSQL, Stripe, Redis, BullMQ, Docker

## Architecture

- Double-entry ledger for financial accuracy
- Idempotent payment processing via Redis
- Async payout scheduling with BullMQ + retries
- Reconciliation with Stripe (hourly + daily deep scan)
- Rate limiting (global + per-endpoint)
- Health checks (DB + Redis connectivity)

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### Local Development

```bash
# 1. Start infrastructure (PostgreSQL + Redis)
npm run docker:dev

# 2. Copy environment config
cp .env.example .env
# Edit .env with your Stripe keys

# 3. Install dependencies & generate Prisma client
npm install
npx prisma generate

# 4. Run migrations & seed
npx prisma migrate deploy
npx prisma db seed

# 5. Start dev server
npm run start:dev
```

App runs at http://localhost:3000, Swagger at http://localhost:3000/api

### Full Stack (Docker)

```bash
# Start everything (app + postgres + redis + migrations)
npm run docker:up

# Check health
curl localhost:3000/health

# Stop
npm run docker:down
```

### Available Scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Dev server with hot reload |
| `npm run build` | TypeScript build |
| `npm run start:prod` | Run production build |
| `npm run typecheck` | Type check without emit |
| `npm test` | Run tests |
| `npm run docker:dev` | Start infra only (postgres + redis) |
| `npm run docker:dev:down` | Stop infra |
| `npm run docker:up` | Full stack in Docker |
| `npm run docker:down` | Stop full stack |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Run migrations |
| `npm run prisma:seed` | Seed database |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (DB + Redis) |
| `POST` | `/payments` | Create payment (Stripe PaymentIntent) |
| `POST` | `/webhooks/stripe` | Stripe webhook handler |
| `POST` | `/payouts/release` | Release payout from escrow |
| `POST` | `/queue/payout` | Add payout job to queue |
| `GET` | `/ledger/accounts` | List all accounts with balances |
| `GET` | `/ledger/balance/:id` | Get account balance |
| `GET` | `/ledger/transactions/:id` | Get account transaction history |
| `POST` | `/reconciliation/recent` | Reconcile recent transactions (24h) |
| `POST` | `/reconciliation/all` | Deep reconciliation (all transactions) |
| `POST` | `/reconciliation/transaction/:id` | Reconcile single transaction |

## Infrastructure

### Docker

- **Multi-stage Dockerfile**: deps → build → production (~250MB image)
- **docker-compose.yml**: Full stack with health checks and dependency ordering
- **docker-compose.dev.yml**: Infra only for local development
- **Non-root user** in production container

### CI/CD (GitHub Actions)

Pipeline runs on push/PR to `main`:

1. **Lint** — `tsc --noEmit` type checking
2. **Test** — Jest with PostgreSQL + Redis service containers
3. **Docker** — Build image (push disabled, enable when ready to deploy)

### Environment Variables

See `.env.example` for all required variables.

## Features

- [x] Payment intake via Stripe PaymentIntents
- [x] Escrow holding with double-entry ledger
- [x] Seller payouts with platform fee calculation
- [x] Async payout queue (BullMQ)
- [x] Daily scheduled payouts (cron)
- [x] Reconciliation jobs (hourly + daily)
- [x] Stripe webhook handling with signature verification
- [x] Idempotency (Redis-based)
- [x] Rate limiting (global + per-endpoint)
- [x] Health checks (DB + Redis)
- [x] Docker infrastructure + CI/CD
- [ ] Seller payouts via Stripe Connect
- [ ] Authentication & authorization
- [ ] Observability (logging, metrics, tracing)

## Production Considerations

- Replace autoincrement IDs with UUIDs for security
- Add authentication layer (JWT / API keys)
- Use NestJS ConfigModule instead of raw `process.env`
- Centralize Redis connection into shared module
- Add structured logging (Pino / Winston)
- Environment-specific seed data

## Development Log

Building in public — tracking progress below.

### Jan 29, 2025
- Designed ledger schema (accounts, transactions, entries)
- Set up Prisma with PostgreSQL
- Implemented double-entry bookkeeping foundation

### Jan 31, 2026
- Initial project setup with NestJS, Prisma, PostgreSQL
- Designed double-entry ledger database schema (accounts, transactions, entries)
- Implemented LedgerService with transaction validation
- Added unit tests for ledger balance validation
- Set up Jest with TypeScript support

### Feb 1, 2026
- Integrated Stripe Payment Intent API
- Implemented webhook handler for payment completion
- Added Swagger documentation
- Created seed data for testing

### Feb 2, 2026
- Implemented payout service with platform fee calculation (5% default)
- Added idempotency support using Redis to prevent duplicate payments
- Integrated BullMQ for async job processing
- Created PayoutQueue and Worker for background payout processing
- Added scheduled daily payouts with cron jobs
- Built full payment cycle: buyer → escrow → seller with automated fee deduction

### Feb 3, 2026
- Added account balance check endpoint (GET /ledger/balance/:id)
- Implemented insufficient funds validation for debits
- Added transaction history endpoint (GET /ledger/transactions/:id)
- Added accounts overview with real-time balances (GET /ledger/accounts)

### Feb 4, 2026
- Implemented reconciliation service to sync transaction status with Stripe
- Added hourly reconciliation for recent pending transactions (last 24h)
- Added daily deep reconciliation for all payment transactions (3 AM)
- Created manual reconciliation endpoints for admin operations
- Fixed 3 stale PENDING transactions that were actually FAILED in Stripe

### Feb 5, 2026
- Implemented API rate limiting with @nestjs/throttler
- Configured global limit: 100 requests/minute
- Added stricter limits for sensitive endpoints (payments: 10/min, webhooks: 50/min)
- Rate limiting uses IP-based tracking to prevent abuse

### Feb 6, 2026
- Started Docker infrastructure setup
- Created multi-stage Dockerfile for production builds
- Configured docker-compose with health checks for PostgreSQL and Redis
- Debugged DNS resolution issues with Mullvad VPN in Docker Desktop

### Feb 7, 2026
- Fixed Prisma OpenSSL compatibility for ARM64 Docker builds (node:20-slim → node:20-bookworm)
- Resolved Prisma CLI version mismatch in Docker (npx pulling v7 instead of v5.22)
- Added .dockerignore (reduced build context from 247MB to 3KB)
- Configured GitHub Actions CI pipeline (typecheck → test → docker build)

### Feb 8, 2026
- Added Docker infrastructure (multi-stage Dockerfile, docker-compose)
- Configured GitHub Actions CI pipeline (typecheck → test → docker build)
- Added health check endpoint (GET /health) with DB + Redis monitoring
- Fixed Prisma OpenSSL compatibility for ARM64 Docker builds
- Cleaned up .gitignore, .dockerignore, environment config

### Feb 10, 2026
- Centralized Redis connection into shared RedisModule (was duplicated in 4 places)
- IdempotencyService, PayoutQueue, PayoutProcessor, HealthController now use DI-injected RedisService
- Single connection config, single place to change Redis host/port/password

### Feb 11, 2026
- Added Payout model with state machine (PENDING → ELIGIBLE → PROCESSING → PAID/FAILED)
- Added Seller model for Stripe Connect accounts with KYC status tracking
- Implemented validated state transitions (invalid transitions return 400)
- Stripe Transfer integration with automatic failure handling
- Retry logic with max attempts limit (default 3)
- Ledger entries execute only after successful Stripe transfer
- Payout endpoints: create, mark eligible, process, retry, get, list by status
- Stripe Connect seller onboarding with real KYC flow
- Seller registration creates ledger account + Stripe Express account
- Onboarding link generation for seller KYC on Stripe
- Webhook handler for account.updated events (auto-sync seller status)
- Full flow tested: ONBOARDING → PENDING_VERIFICATION → ACTIVE (chargesEnabled + payoutsEnabled)

### Feb 12, 2026
- Added ledger reversal for payout rollbacks (mirror DEBIT/CREDIT entries)
- Escrow balance validation before Stripe transfer (prevents dual write issues)
- Admin dashboard: payout stats, failed/blocked lists, force-retry, reversal
- Admin seller management: restricted sellers list, force-sync with Stripe
- Fixed platform fee account resolution (was hardcoded, now auto-resolved)
- Clean seed data with global escrow account
- Ledger integration tests (8 tests) + state machine unit tests (10 tests)
- First successful real Stripe Connect payout end-to-end