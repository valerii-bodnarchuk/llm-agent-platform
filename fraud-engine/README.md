# Fraud Engine

Rule-based fraud scoring microservice. Scores seller payout requests 0.0–1.0 and returns ALLOW / REVIEW / BLOCK decisions.

**Decision boundaries:** `< 0.3` → ALLOW &nbsp;·&nbsp; `0.3–0.7` → REVIEW &nbsp;·&nbsp; `≥ 0.7` → BLOCK

Scoring is additive across all triggered rules, capped at 1.0.

## Stack

Python 3.13 · FastAPI · Pydantic

## Quick Start

```bash
cd fraud-engine
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydantic
uvicorn app.main:app --reload --port 8000
```

Swagger: http://localhost:8000/docs

## API

`POST /check` — evaluate transaction risk
`GET /health` — health check

## Rules

| Rule | Trigger | Score |
|------|---------|-------|
| **velocity** | ≥ 5 payouts in 24h | +0.20 |
| **velocity** | ≥ 10 payouts in 24h | +0.40 |
| **amount_threshold** | single payout ≥ €5,000 | +0.20 |
| **amount_threshold** | single payout ≥ €10,000 | +0.50 |
| **daily_volume** | 24h total ≥ €20,000 | +0.15 |
| **daily_volume** | 24h total ≥ €50,000 | +0.40 |
| **failed_history** | ≥ 2 failed payouts in 7d | +0.20 |
| **failed_history** | ≥ 5 failed payouts in 7d | +0.50 |
| **new_account** | account age < 30 days | +0.05 |
| **new_account** | account age < 7 days | +0.15 |
| **dispute_rate** | ≥ 1 dispute on record | +0.15 |
| **dispute_rate** | ≥ 3 disputes on record | +0.50 |

## Tests

```bash
cd fraud-engine
source venv/bin/activate
pytest tests/ -v
```
