"""
Central tool registry — single list of all tools available to the agent.
Import this in graph.py to bind tools to the LLM.
"""
from agent.tools.transaction import get_transaction_context
from agent.tools.seller import get_seller_risk_profile
from agent.tools.timeline import get_payout_timeline
from agent.tools.fraud_score import get_fraud_score_explanation
from agent.tools.ledger import check_ledger_consistency

ALL_TOOLS = [
    get_transaction_context,
    get_seller_risk_profile,
    get_payout_timeline,
    get_fraud_score_explanation,
    check_ledger_consistency,
]
