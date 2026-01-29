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

## Development Log

Building in public - tracking daily progress below.

### Jan 29, 2025
- Designed ledger schema (accounts, transactions, entries)
- Set up Prisma with PostgreSQL
- Implemented double-entry bookkeeping foundation
