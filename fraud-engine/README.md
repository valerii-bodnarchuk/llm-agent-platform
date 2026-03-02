# Fraud Engine

Rule-based fraud scoring microservice for the Payment Processing System.

## Stack
Python 3.13, FastAPI, Pydantic

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
- **velocity** — too many payouts in 24h
- **amount_threshold** — single payout exceeds limit
- **daily_volume** — total daily volume too high
- **failed_history** — recent failed payouts
- **new_account** — account age < 30 days
- **dispute_rate** — high dispute count
