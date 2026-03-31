import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry: client.Registry;

  // --- HTTP metrics ---
  readonly httpRequestDuration: client.Histogram;
  readonly httpRequestsTotal: client.Counter;

  // --- Business metrics (fintech-specific) ---
  readonly payoutsTotal: client.Counter;
  readonly payoutAmountTotal: client.Counter;
  readonly fraudDecisions: client.Counter;
  readonly ledgerTransactionsTotal: client.Counter;
  readonly stripeWebhooksTotal: client.Counter;
  readonly disputesTotal: client.Counter;
  readonly reconciliationRuns: client.Counter;
  readonly reconciliationMismatches: client.Gauge;

  constructor() {
    this.registry = new client.Registry();

    client.collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.payoutsTotal = new client.Counter({
      name: 'payouts_total',
      help: 'Total payouts by final status',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.payoutAmountTotal = new client.Counter({
      name: 'payout_amount_cents_total',
      help: 'Total payout amount in cents by status',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.fraudDecisions = new client.Counter({
      name: 'fraud_decisions_total',
      help: 'Fraud engine decisions',
      labelNames: ['decision'],
      registers: [this.registry],
    });

    this.ledgerTransactionsTotal = new client.Counter({
      name: 'ledger_transactions_total',
      help: 'Total ledger transactions created',
      registers: [this.registry],
    });

    this.stripeWebhooksTotal = new client.Counter({
      name: 'stripe_webhooks_total',
      help: 'Stripe webhook events received',
      labelNames: ['event_type'],
      registers: [this.registry],
    });

    this.disputesTotal = new client.Counter({
      name: 'disputes_total',
      help: 'Disputes by resolution',
      labelNames: ['resolution'],
      registers: [this.registry],
    });

    this.reconciliationRuns = new client.Counter({
      name: 'reconciliation_runs_total',
      help: 'Reconciliation job executions',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.reconciliationMismatches = new client.Gauge({
      name: 'reconciliation_mismatches_current',
      help: 'Current count of unresolved reconciliation mismatches',
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Registry initialized in constructor; default Node.js metrics already collecting
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
