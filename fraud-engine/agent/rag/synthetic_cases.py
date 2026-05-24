"""
Evaluation fixtures for retrieval benchmarking.

Not production data. Twenty cases across five intent clusters, written to
exercise the retrieval index with enough verdict/signal variance to compute
precision@5, recall@5 and MRR meaningfully. Kept separate from SEED_CASES
so the eval report can be honest about what is observed production seeds
versus what is fixture.

Cluster layout (4 cases each):
    1. velocity_abuse        SYN-001..SYN-004
    2. geo_mismatch          SYN-005..SYN-008
    3. account_takeover      SYN-009..SYN-012
    4. merchant_collusion    SYN-013..SYN-016
    5. legitimate_high_risk  SYN-017..SYN-020

Verdict distribution: 12 TRUE_POSITIVE / 5 INCONCLUSIVE / 3 FALSE_POSITIVE.
The upstream BLOCK / REVIEW / ALLOW decision is encoded in `signals` (as
`decision:*`) rather than as the verdict, matching SEED_CASES vocabulary.

Cluster 5 (legitimate_high_risk) is the discriminator test: every case has
suspicious upstream signals (`decision:BLOCK`, `risk:high` etc.) but resolves
to FALSE_POSITIVE on investigation. Retrieval must learn to separate these
from the structurally similar TRUE_POSITIVE cases in clusters 1-4.

Disputes signals use the plural form (`disputes:active`, `disputes:none`)
consistently — SEED_CASES has a singular/plural inconsistency we are not
fixing here, noted in the eval report.
"""
from __future__ import annotations


SYNTHETIC_CASES: list[dict] = [
    # ── Cluster 1: velocity_abuse ────────────────────────────────────────
    {
        "case_id": "SYN-001",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Stolen-card validation pattern: 23 transactions of EUR 1.50–3.00 "
            "to a dropshipping marketplace within 4 minutes, all from the same "
            "buyer device fingerprint."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:velocity",
            "pattern:velocity_spike",
            "pattern:card_testing",
            "amount:micro",
            "risk:high",
        ],
        "recommended_actions": [
            "Keep payouts blocked and freeze the associated buyer account.",
            "Forward affected BIN ranges to issuer for fraud notification.",
        ],
    },
    {
        "case_id": "SYN-002",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "CRITICAL",
        "summary": (
            "Bot-driven sweep: 150+ EUR 5–20 charges across sequential card "
            "numbers in 8 minutes, distinct billing addresses but identical "
            "user-agent and source ASN."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:velocity",
            "pattern:card_testing",
            "risk:critical",
            "device:vpn",
        ],
        "recommended_actions": [
            "Block source IP range and notify the issuing banks involved.",
            "Add a velocity rule covering sequential BIN attempts.",
        ],
    },
    {
        "case_id": "SYN-003",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Same card hit ten EUR 200 marketplace purchases within 90 seconds, "
            "well outside the cardholder's six-month median of one purchase "
            "per week."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:velocity",
            "pattern:velocity_spike",
            "rule:failed_history",
            "risk:high",
        ],
        "recommended_actions": [
            "Keep payout blocked and decline subsequent attempts within the window.",
            "Flag the card for issuer review.",
        ],
    },
    {
        "case_id": "SYN-004",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Twelve EUR 500 gift-card redemptions in 6 minutes across two "
            "merchants — cash-out vector following probable compromise."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:velocity",
            "pattern:velocity_spike",
            "pattern:card_testing",
            "risk:high",
        ],
        "recommended_actions": [
            "Suspend gift-card delivery and reverse pending redemptions.",
            "Notify the gift-card issuer of probable compromise.",
        ],
    },
    # ── Cluster 2: geo_mismatch ──────────────────────────────────────────
    {
        "case_id": "SYN-005",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "EUR 1,200 electronics order with EU billing address but checkout "
            "IP geolocated to Lagos; first-time buyer on platform."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "geo:high_risk_jurisdiction",
            "rule:new_account",
            "risk:high",
        ],
        "recommended_actions": [
            "Cancel the order and refund through the chargeback flow.",
            "Add the source country to the elevated-risk watchlist.",
        ],
    },
    {
        "case_id": "SYN-006",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Two purchases on the same card 41 minutes apart, one from a "
            "Stockholm WiFi and one from a Hong Kong residential IP — "
            "physically impossible."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:impossible_travel",
            "geo:ip_billing_mismatch",
            "rule:velocity",
            "risk:high",
        ],
        "recommended_actions": [
            "Block the second transaction and lock the card on the platform.",
            "Notify the cardholder through a verified channel.",
        ],
    },
    {
        "case_id": "SYN-007",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "EUR 850 subscription signup from a datacenter VPN exit, billing "
            "claims Switzerland, payment instrument issued in Brazil."
        ),
        "signals": [
            "decision:BLOCK",
            "device:vpn",
            "geo:ip_billing_mismatch",
            "geo:high_risk_jurisdiction",
            "risk:high",
        ],
        "recommended_actions": [
            "Decline and add VPN exit IPs to the high-value blocklist tier.",
            "Require step-up auth for any retry from this card.",
        ],
    },
    {
        "case_id": "SYN-008",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 600 hotel booking from a Bangkok IP but billing in Berlin; "
            "cardholder has a two-year clean history but no prior "
            "international charges."
        ),
        "signals": [
            "decision:REVIEW",
            "geo:ip_billing_mismatch",
            "seller:established",
            "disputes:none",
            "risk:medium",
        ],
        "recommended_actions": [
            "Send an out-of-band verification SMS before releasing the booking.",
            "Confirm with the merchant whether dates align with travel.",
        ],
    },
    # ── Cluster 3: account_takeover ──────────────────────────────────────
    {
        "case_id": "SYN-009",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "EUR 4,800 laptop order placed 11 minutes after a password reset, "
            "from a device fingerprint never seen on the account, shipping "
            "to a new address."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:account_takeover",
            "auth:recent_password_reset",
            "device:new_fingerprint",
            "seller:established",
            "risk:high",
        ],
        "recommended_actions": [
            "Hold the order, freeze the account, contact the holder via a verified channel.",
            "Roll back the password reset if takeover is confirmed.",
        ],
    },
    {
        "case_id": "SYN-010",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Account accessed via credential-stuffing attempt traced to a "
            "known leak dump; immediate EUR 2,200 transfer to the attacker's "
            "newly added beneficiary."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:account_takeover",
            "auth:credential_stuffing",
            "device:new_fingerprint",
            "risk:high",
        ],
        "recommended_actions": [
            "Reverse the transfer if still pending and force a password reset.",
            "Add the IP and device fingerprint to the deny list.",
        ],
    },
    {
        "case_id": "SYN-011",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "CRITICAL",
        "summary": (
            "Veteran seller account drained EUR 12,000 across three rapid "
            "payouts to a newly added bank account, all from a device "
            "fingerprint with zero historical sessions."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:account_takeover",
            "device:new_fingerprint",
            "rule:velocity",
            "seller:established",
            "risk:critical",
        ],
        "recommended_actions": [
            "Block payouts and revert the bank-account change.",
            "Open a Stripe Connect review and contact the seller offline.",
        ],
    },
    {
        "case_id": "SYN-012",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Password reset followed within 30 minutes by a EUR 380 purchase "
            "on a recently-used device; could be legitimate after a forgotten "
            "password."
        ),
        "signals": [
            "decision:REVIEW",
            "auth:recent_password_reset",
            "seller:established",
            "risk:medium",
        ],
        "recommended_actions": [
            "Send a transactional alert email and let the purchase proceed.",
            "Flag for review if any further high-value action occurs within 24h.",
        ],
    },
    # ── Cluster 4: merchant_collusion ────────────────────────────────────
    {
        "case_id": "SYN-013",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Same merchant processed EUR 18,000 in refunds across 47 "
            "transactions with no matching shipped-order records — "
            "refund-to-cash pattern."
        ),
        "signals": [
            "decision:BLOCK",
            "merchant:refund_abuse",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Suspend merchant payouts and open a Stripe Connect investigation.",
            "Reverse refunds where buyer collusion is confirmed.",
        ],
    },
    {
        "case_id": "SYN-014",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Cluster of EUR 200–400 chargebacks from buyers who all received "
            "goods but disputed as 'not received'; merchant has 18% chargeback "
            "rate vs platform median of 0.4%."
        ),
        "signals": [
            "decision:BLOCK",
            "merchant:friendly_fraud",
            "rule:dispute_rate",
            "pattern:repeat_chargeback",
            "risk:high",
        ],
        "recommended_actions": [
            "Hold payouts pending evidence submission to the issuer.",
            "Add the merchant to the enhanced-monitoring tier.",
        ],
    },
    {
        "case_id": "SYN-015",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Marketplace seller with 3.5% chargeback rate over 60 days; could "
            "be legitimate buyer dissatisfaction for the product category."
        ),
        "signals": [
            "decision:REVIEW",
            "rule:dispute_rate",
            "disputes:active",
            "seller:established",
            "risk:medium",
        ],
        "recommended_actions": [
            "Sample 10 recent disputes for buyer/seller narrative review.",
            "If pattern is systematic, escalate to ops; if isolated, monitor.",
        ],
    },
    {
        "case_id": "SYN-016",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Merchant issued EUR 3,000 in refunds 48 hours after a payout with "
            "no associated buyer complaints — could be reconciliation, could "
            "be collusion."
        ),
        "signals": [
            "decision:REVIEW",
            "merchant:refund_abuse",
            "disputes:none",
            "ledger:balanced",
            "risk:medium",
        ],
        "recommended_actions": [
            "Request merchant explanation and the corresponding shipment records.",
            "Tag the account for follow-up if refund-without-complaint repeats.",
        ],
    },
    # ── Cluster 5: legitimate_high_risk (discriminator) ──────────────────
    {
        "case_id": "SYN-017",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "EUR 32,000 watch purchase triggered amount_threshold; customer "
            "has 4-year history, EUR 200k cumulative spend, and zero disputes."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "customer:vip",
            "seller:established",
            "disputes:none",
        ],
        "recommended_actions": [
            "Approve manually and whitelist the customer above platform threshold.",
            "Tune amount_threshold for the verified VIP segment.",
        ],
    },
    {
        "case_id": "SYN-018",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "Mid-November volume spike (EUR 15,000 over 6 hours) for an "
            "established electronics seller — pre-Christmas peak matches the "
            "prior-year seasonal pattern."
        ),
        "signals": [
            "decision:REVIEW",
            "rule:velocity",
            "pattern:seasonal",
            "seller:established",
            "disputes:none",
            "ledger:balanced",
        ],
        "recommended_actions": [
            "Release payouts after spot-check; document the seasonal exception.",
            "Adjust velocity threshold seasonally for verified merchants.",
        ],
    },
    {
        "case_id": "SYN-019",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 8,500 enterprise software subscription flagged for "
            "amount_threshold and new merchant relationship; buyer is a "
            "registered B2B account with a prior procurement track record."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "rule:new_account",
            "customer:vip",
            "disputes:none",
            "risk:medium",
        ],
        "recommended_actions": [
            "Approve and onboard the merchant to the verified B2B tier.",
            "Add a B2B account-age exception to the new_account rule.",
        ],
    },
    {
        "case_id": "SYN-020",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 1,100 hotel and restaurant charges from a jurisdiction the "
            "customer has never visited; could be a business trip, could be "
            "card cloning."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "geo:high_risk_jurisdiction",
            "rule:amount_threshold",
            "risk:medium",
        ],
        "recommended_actions": [
            "Send a verification request via verified email and SMS.",
            "Decline if no response within 2 hours; approve if confirmed.",
        ],
    },
]
