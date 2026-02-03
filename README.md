# Payment Processing System

> Full-cycle marketplace payment platform with escrow and seller payouts

**Tech Stack:** NestJS, Prisma, PostgreSQL, Stripe, Redis, BullMQ

## Architecture

- Double-entry ledger for financial accuracy
- Idempotent payment processing
- Async payout scheduling with retries
- Reconciliation with Stripe

## Features

- [ ] Payment intake via Stripe
- [ ] Escrow holding
- [ ] Seller payouts via Stripe Connect
- [ ] Platform fee calculation
- [ ] Reconciliation jobs
- [ ] Webhook handling

## Production Considerations
- Replace autoincrement IDs with UUIDs for security
- Use environment-specific seed data

## Development Log

Building in public - tracking daily progress below.

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
- Designed double-entry ledger schema
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