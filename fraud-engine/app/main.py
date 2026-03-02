from fastapi import FastAPI
from app.models import FraudCheckRequest, FraudCheckResponse, Decision
from app.rules.engine import evaluate

app = FastAPI(
    title="Fraud Engine",
    description="Rule-based fraud scoring for payment processing",
    version="1.0.0",
)


def score_to_decision(score: float) -> Decision:
    if score >= 0.7:
        return Decision.BLOCK
    if score >= 0.3:
        return Decision.REVIEW
    return Decision.ALLOW


@app.post("/check", response_model=FraudCheckResponse)
def fraud_check(req: FraudCheckRequest):
    risk_score, results = evaluate(req)
    return FraudCheckResponse(
        transaction_id=req.transaction_id,
        risk_score=round(risk_score, 2),
        decision=score_to_decision(risk_score),
        rules_triggered=[r for r in results if r.triggered],
    )


@app.get("/health")
def health():
    return {"status": "healthy", "service": "fraud-engine"}