# Fraud Engine Context

## Architecture

Two-component system:
- **NestJS client** (`src/fraud/fraud.service.ts`) — HTTP client, fail-open fallback
- **Python/FastAPI microservice** (`fraud-engine/`) — scoring engine, six rules

## NestJS Client (`FraudService`)

**Endpoint called**: `POST $FRAUD_ENGINE_URL/check` (default: `http://localhost:8000`)

**Request shape** (`FraudCheckRequest`):
```typescript
{
  transaction_id: number;
  seller_id: number;
  amount: number;                    // minor units (cents)
  seller_payout_count_24h?: number;
  seller_total_amount_24h?: number;
  seller_failed_payouts_7d?: number;
  seller_account_age_days?: number;
  seller_dispute_count?: number;
}
```

**Response shape** (`FraudCheckResponse`):
```typescript
{
  transaction_id: number;
  risk_score: number;                // 0.0–1.0
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK';
  rules_triggered: Array<{ rule: string; triggered: boolean; score: number; reason: string | null }>;
}
```

**Fail-open policy**: if the engine is unreachable → returns `{ decision: 'REVIEW', risk_score: 0.5, rule: 'engine_unavailable' }`. Never blocks on engine failure.

## Decision Thresholds

| Score | Decision | Effect |
|-------|----------|--------|
| < 0.3 | ALLOW    | Payout proceeds normally |
| 0.3–0.7 | REVIEW | Payout marked ELIGIBLE with `failureReason` set to triggered rules |
| ≥ 0.7 | BLOCK   | `markEligible()` throws `BadRequestException` |

## Six Scoring Rules (Python engine)

1. **velocity** — payout count in last 24h
2. **amount_threshold** — single payout amount vs limit
3. **daily_volume** — total amount paid out in 24h
4. **failed_history** — failed payouts in last 7d
5. **new_account** — account age in days
6. **dispute_rate** — open dispute count

## Call Site

`PayoutService.markEligible()` (`src/payout/payout.service.ts`) — called on `PENDING → ELIGIBLE` transition. Aggregates the five context metrics from DB before calling `FraudService.checkTransaction()`.

## Starting the Python Engine

```bash
cd fraud-engine
source venv/bin/activate
uvicorn app.main:app --reload --port 8000
pytest tests/
```

## Key Invariant

REVIEW does **not** block a payout — it flags it for manual review via `failureReason`. Only BLOCK rejects. This is intentional: fail-open for operational resilience.
