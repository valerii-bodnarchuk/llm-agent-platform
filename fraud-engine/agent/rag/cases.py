"""
Seed historical cases for local similar-case retrieval.

These are intentionally static and read-only. Auto-indexing completed
investigations is out of scope for this implementation.
"""
from __future__ import annotations


SEED_CASES: list[dict] = [
    {
        "case_id": "case_amount_threshold_false_positive",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "Established seller hit the amount_threshold rule during a normal "
            "seasonal order, with clean dispute history and healthy ledger."
        ),
        "signals": [
            "decision:REVIEW",
            "rule:amount_threshold",
            "risk:medium",
            "seller:established",
            "disputes:none",
            "ledger:balanced",
        ],
        "recommended_actions": [
            "Approve after confirming buyer payment settled.",
            "Consider threshold tuning for established sellers.",
        ],
    },
    {
        "case_id": "case_velocity_spike_true_positive",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Seller generated a sharp 24h payout velocity spike with repeated "
            "failed transfers and no matching historical volume."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:velocity",
            "rule:failed_history",
            "risk:high",
            "pattern:velocity_spike",
        ],
        "recommended_actions": [
            "Keep payout blocked.",
            "Review seller account activity and recent buyers.",
        ],
    },
    {
        "case_id": "case_new_seller_high_amount_true_positive",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "New seller attempted a high-value payout before building any "
            "successful payout or dispute-free history."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:new_account",
            "rule:amount_threshold",
            "risk:high",
            "seller:new",
        ],
        "recommended_actions": [
            "Hold payout for manual KYC and order validation.",
            "Require additional seller verification before retry.",
        ],
    },
    {
        "case_id": "case_active_dispute_high_risk",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Transaction had an active dispute while payout was pending, making "
            "release unsafe until dispute resolution."
        ),
        "signals": [
            "decision:REVIEW",
            "rule:active_dispute",
            "rule:dispute_rate",
            "risk:high",
            "dispute:active",
        ],
        "recommended_actions": [
            "Do not release payout until dispute is resolved.",
            "Escalate to operations for evidence review.",
        ],
    },
    {
        "case_id": "case_ledger_inconsistency_critical",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "CRITICAL",
        "summary": (
            "Ledger integrity failed after money movement, requiring immediate "
            "reconciliation before any payout action."
        ),
        "signals": [
            "rule:ledger_imbalanced",
            "rule:ledger_inconsistency",
            "risk:critical",
            "ledger:imbalanced",
        ],
        "recommended_actions": [
            "Freeze payout operations for the affected accounts.",
            "Run full reconciliation and investigate missing ledger entries.",
        ],
    },
    {
        "case_id": "case_missing_data_inconclusive",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Investigation could not load complete transaction or seller context, "
            "so no reliable fraud conclusion was possible."
        ),
        "signals": [
            "data:missing",
            "data:partial",
            "risk:medium",
            "verdict:inconclusive",
        ],
        "recommended_actions": [
            "Retry investigation after source systems recover.",
            "Route to manual review if data remains incomplete.",
        ],
    },
]

