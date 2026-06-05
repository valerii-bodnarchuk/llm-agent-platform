"""
Evaluation fixtures for retrieval benchmarking.

Not production data. Forty cases across five intent clusters (Phase 1, 4 per
cluster) plus twenty boundary cases (Phase 2a, SYN-021..SYN-040), written to
exercise the retrieval index with enough verdict/signal variance to compute
precision@5, recall@5 and MRR meaningfully. Kept separate from SEED_CASES
so the eval report can be honest about what is observed production seeds
versus what is fixture.

Cluster layout:
    Phase 1 (4 cases each):
        1. velocity_abuse        SYN-001..SYN-004
        2. geo_mismatch          SYN-005..SYN-008
        3. account_takeover      SYN-009..SYN-012
        4. merchant_collusion    SYN-013..SYN-016
        5. legitimate_high_risk  SYN-017..SYN-020

    Phase 2a boundary cases (5 cases each, cross-cluster overlap):
        Type A  SYN-021..SYN-025  ATO that looks like legitimate high-value
                                  (cluster 3 × cluster 5 boundary)
        Type B  SYN-026..SYN-030  Velocity vs card-testing / merchant-collusion
                                  overlap (cluster 1 × cluster 4 boundary)
        Type C  SYN-031..SYN-035  Geo mismatch on legitimate VIP travel
                                  (cluster 2 × cluster 5 boundary)
        Type D  SYN-036..SYN-040  Merchant collusion vs mass friendly fraud
                                  (cluster 4 internal boundary)

Phase 1 verdict distribution: 12 TRUE_POSITIVE / 5 INCONCLUSIVE / 3 FALSE_POSITIVE.
Phase 2a verdict distribution: 10 TRUE_POSITIVE / 4 INCONCLUSIVE / 6 FALSE_POSITIVE.
(Type B and Type C each contribute 2 and 4 FALSE_POSITIVEs respectively —
 these are the "looks like fraud, isn't" hard negatives for the retriever.)

The upstream BLOCK / REVIEW / ALLOW decision is encoded in `signals` (as
`decision:*`) rather than as the verdict, matching SEED_CASES vocabulary.

Cluster 5 (legitimate_high_risk) is the discriminator test: every case has
suspicious upstream signals (`decision:BLOCK`, `risk:high` etc.) but resolves
to FALSE_POSITIVE on investigation. Retrieval must learn to separate these
from the structurally similar TRUE_POSITIVE cases in clusters 1-4.

Disputes signals use the plural form (`disputes:active`, `disputes:none`)
consistently — SEED_CASES has a singular/plural inconsistency we are not
fixing here, noted in the eval report.

Phase 2a signal additions: NONE. All 20 boundary cases use signals already
present in Phase 1 vocabulary.
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
    # ── Cluster 5: legitimate_high_risk (discriminator) ─────────────────
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
    # ── Phase 2a — Type A: ATO that looks like legitimate high-value ──────
    # Cluster: 3_account_takeover. Signals overlap with cluster 5 (customer:vip,
    # seller:established, high amounts) but add auth/device takeover signals.
    # Forces retrieval not to collapse "high amount + vip → legitimate".
    {
        "case_id": "SYN-021",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "EUR 9,500 watch purchase initiated 9 minutes after a credential-stuffing "
            "event linked to a known breach database; VIP account with 4-year clean "
            "history, but checkout device fingerprint is brand-new — established "
            "luxury seller reported no prior contact from this device."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "pattern:account_takeover",
            "auth:credential_stuffing",
            "device:new_fingerprint",
            "customer:vip",
            "seller:established",
            "risk:high",
        ],
        "recommended_actions": [
            "Hold the order and freeze the account pending cardholder verification.",
            "Force credential reset and notify via verified contact channel.",
        ],
    },
    {
        "case_id": "SYN-022",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "CRITICAL",
        "summary": (
            "EUR 17,000 transferred to a newly added beneficiary 14 minutes after "
            "a VIP account password reset; source IP and device fingerprint have "
            "zero historical sessions despite a 5-year membership."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "pattern:account_takeover",
            "auth:recent_password_reset",
            "device:new_fingerprint",
            "customer:vip",
            "risk:critical",
        ],
        "recommended_actions": [
            "Block the transfer and revert the beneficiary change immediately.",
            "Flag account for step-up authentication and offline contact.",
        ],
    },
    {
        "case_id": "SYN-023",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "VIP customer account accessed via credential stuffing from a breach "
            "dump; EUR 6,800 electronics order placed immediately, shipping "
            "address differs from all prior deliveries on the 3-year account history."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "pattern:account_takeover",
            "auth:credential_stuffing",
            "device:new_fingerprint",
            "customer:vip",
            "seller:established",
            "risk:high",
        ],
        "recommended_actions": [
            "Cancel shipment and hold payout until identity is re-confirmed.",
            "Add source IP to deny list and require fresh MFA enrollment.",
        ],
    },
    {
        "case_id": "SYN-024",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "CRITICAL",
        "summary": (
            "EUR 19,500 jewelry order on a VIP account with a well-established "
            "seller; password reset 6 minutes before checkout from a device with "
            "no prior session history — classic post-takeover cash-out pattern."
        ),
        "signals": [
            "decision:BLOCK",
            "rule:amount_threshold",
            "pattern:account_takeover",
            "auth:recent_password_reset",
            "device:new_fingerprint",
            "customer:vip",
            "seller:established",
            "risk:critical",
        ],
        "recommended_actions": [
            "Suspend order fulfillment and freeze payout to the seller.",
            "Initiate offline identity verification with the account holder.",
        ],
    },
    {
        "case_id": "SYN-025",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 5,200 travel package on a VIP account 22 minutes after a "
            "self-service password reset; new device fingerprint, but the account "
            "holder replied to an out-of-band email within 4 minutes confirming "
            "a device change — takeover cannot be ruled in or out without "
            "additional session telemetry."
        ),
        "signals": [
            "decision:REVIEW",
            "auth:recent_password_reset",
            "device:new_fingerprint",
            "customer:vip",
            "seller:established",
            "disputes:none",
            "risk:medium",
        ],
        "recommended_actions": [
            "Allow the transaction but flag for 24-hour monitoring.",
            "Request device attestation on next login.",
        ],
    },
    # ── Phase 2a — Type B: Velocity vs card-testing / merchant-collusion ──
    # 3 TRUE_POSITIVE (genuine card testing on a merchant under attack) and
    # 2 FALSE_POSITIVE (merchant_collusion was upstream trigger, buyer cleared).
    # Same signal pattern, different verdicts — pure ground-truth stress test.
    {
        "case_id": "SYN-026",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "34 micro-charges of EUR 1–3 to a digital-goods merchant within "
            "7 minutes; dispute_rate rule fired concurrently due to an active "
            "card-testing campaign targeting the same store — buyer velocity "
            "and merchant dispute signals independently confirm fraud."
        ),
        "signals": [
            "decision:BLOCK",
            "amount:micro",
            "pattern:velocity_spike",
            "pattern:card_testing",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Block the buyer account and forward affected BIN ranges to the issuer.",
            "Notify the merchant of the concurrent card-testing campaign.",
        ],
    },
    {
        "case_id": "SYN-027",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "19 attempts of EUR 0.50–2.00 against a subscription platform with "
            "an elevated dispute rate from an active chargeback wave; buyer "
            "velocity and merchant dispute_rate signals aligned — confirmed "
            "stolen-card validation run on a vulnerable merchant."
        ),
        "signals": [
            "decision:BLOCK",
            "amount:micro",
            "pattern:velocity_spike",
            "pattern:card_testing",
            "rule:velocity",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Block the card and add the source ASN to the velocity watchlist.",
            "Advise the merchant to implement CAPTCHA on the payment flow.",
        ],
    },
    {
        "case_id": "SYN-028",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "28 micro-charges of EUR 0.99–4.99 on a marketplace simultaneously "
            "flagged by dispute_rate for a coordinated chargeback wave; velocity "
            "rule fired from the buyer side, dispute_rate from the merchant side "
            "— independent signals converge on card testing."
        ),
        "signals": [
            "decision:BLOCK",
            "amount:micro",
            "pattern:velocity_spike",
            "rule:velocity",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Keep buyer blocked; report the card number to the issuing network.",
            "Escalate the merchant chargeback wave to ops for pattern review.",
        ],
    },
    {
        "case_id": "SYN-029",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Micro-amount velocity fired on a buyer making normal small purchases; "
            "dispute_rate signal originated from an unrelated merchant-collusion "
            "ring on the same platform — investigation confirmed the buyer had no "
            "connection to the fraud ring and was cleared."
        ),
        "signals": [
            "decision:REVIEW",
            "amount:micro",
            "pattern:velocity_spike",
            "rule:dispute_rate",
            "disputes:active",
            "merchant:friendly_fraud",
            "risk:medium",
        ],
        "recommended_actions": [
            "Release the buyer account; document the merchant ring as upstream cause.",
            "Add signal-isolation logic to dispute_rate for this merchant tier.",
        ],
    },
    {
        "case_id": "SYN-030",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Recurring EUR 2.99 subscription billing triggered velocity on a buyer "
            "account; dispute_rate fired from a separate merchant refund-abuse "
            "investigation — buyer activity was entirely normal, merchant was the "
            "fraud actor; buyer cleared after ops review."
        ),
        "signals": [
            "decision:REVIEW",
            "amount:micro",
            "pattern:velocity_spike",
            "rule:dispute_rate",
            "disputes:active",
            "merchant:refund_abuse",
            "risk:medium",
        ],
        "recommended_actions": [
            "Reinstate buyer subscription and clear the velocity flag.",
            "Separate merchant and buyer signals in the dispute_rate rule logic.",
        ],
    },
    # ── Phase 2a — Type C: Geo mismatch on legitimate VIP travel ──────────
    # Cluster: 5_legit_high_risk. Looks like cluster 2 (geo_mismatch) but
    # customer:vip + disputes:none + seller:established flip the verdict.
    # Tests whether the vector space encodes the verdict signal given that
    # geo/risk signals dominate the embedding surface area.
    {
        "case_id": "SYN-031",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "EUR 8,700 in hotel and dining charges from Singapore; VIP customer "
            "with 6-year account history and zero disputes across 400 transactions; "
            "IP geolocation matched a pre-notified business trip itinerary."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "customer:vip",
            "seller:established",
            "disputes:none",
            "risk:high",
        ],
        "recommended_actions": [
            "Whitelist the travel jurisdiction for this account for 14 days.",
            "Approve and log as confirmed legitimate travel for model calibration.",
        ],
    },
    {
        "case_id": "SYN-032",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "EUR 12,500 luxury goods purchase in Tokyo 18 hours after a transaction "
            "in London — triggers impossible_travel; VIP account, established seller, "
            "no disputes ever; cardholder confirmed via app push within 2 minutes "
            "that they flew business class overnight."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "geo:impossible_travel",
            "customer:vip",
            "seller:established",
            "disputes:none",
            "risk:high",
        ],
        "recommended_actions": [
            "Approve and suppress the impossible_travel alert for confirmed VIP travel.",
            "Create a travel-confirmation flow as a permanent exemption mechanism.",
        ],
    },
    {
        "case_id": "SYN-033",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "LOW",
        "summary": (
            "EUR 4,300 conference registration and hotel from Dubai; VIP B2B account "
            "with 3-year history and no chargebacks; established conference-industry "
            "seller; geo mismatch from Amsterdam billing is expected for "
            "international conference travel."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "customer:vip",
            "seller:established",
            "disputes:none",
            "risk:high",
        ],
        "recommended_actions": [
            "Release payment and add a VIP geo-exemption for conference destinations.",
            "Review geo-mismatch thresholds for B2B accounts with travel patterns.",
        ],
    },
    {
        "case_id": "SYN-034",
        "verdict": "FALSE_POSITIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 16,800 art purchase in New York 22 hours after a transaction in "
            "Paris — triggers impossible_travel and ip_billing_mismatch; VIP "
            "collector account with zero dispute history; flight records confirmed "
            "same-day travel, but the timezone gap is narrow enough to warrant "
            "a note."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "geo:impossible_travel",
            "customer:vip",
            "disputes:none",
            "risk:high",
        ],
        "recommended_actions": [
            "Approve with travel verification note; flag for VIP exception tier.",
            "Adjust impossible_travel threshold for transatlantic flight windows.",
        ],
    },
    {
        "case_id": "SYN-035",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "EUR 3,900 resort booking from a Maldives IP on a VIP account with EU "
            "billing; impossible_travel fired because a charge was posted in Berlin "
            "3 hours earlier; cardholder has not responded to the verification "
            "push — could be legitimate last-minute booking or early-stage takeover."
        ),
        "signals": [
            "decision:BLOCK",
            "geo:ip_billing_mismatch",
            "geo:impossible_travel",
            "customer:vip",
            "risk:high",
        ],
        "recommended_actions": [
            "Hold the booking for 2 hours pending cardholder response.",
            "Decline and notify via verified backup channel if no response.",
        ],
    },
    # ── Phase 2a — Type D: Merchant collusion vs mass friendly fraud ───────
    # 3 TRUE_POSITIVE (confirmed merchant-side fraud) and 2 INCONCLUSIVE
    # (merchant is the economic victim of coordinated buyer abuse). Same
    # signal surface — verdict disambiguation requires case-level ops review.
    {
        "case_id": "SYN-036",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Merchant processed EUR 22,000 in refunds across 58 transactions with "
            "no matching shipping records; repeat_chargeback and refund_abuse "
            "signals co-fired — confirmed systematic merchant fraud, not buyer error."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:repeat_chargeback",
            "merchant:refund_abuse",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Suspend the merchant account and freeze all pending payouts.",
            "Open a Stripe Connect investigation and notify affected buyers.",
        ],
    },
    {
        "case_id": "SYN-037",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Coordinated chargeback cluster: 34 disputes of EUR 300–600 on a "
            "marketplace seller with a 21% chargeback rate; repeat_chargeback "
            "and friendly_fraud signals confirmed — investigation found the "
            "merchant fabricating 'goods not received' responses and coaching buyers."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:repeat_chargeback",
            "merchant:refund_abuse",
            "merchant:friendly_fraud",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Terminate the merchant agreement and escalate to legal.",
            "Hold payouts and initiate reversal proceedings for confirmed cases.",
        ],
    },
    {
        "case_id": "SYN-038",
        "verdict": "TRUE_POSITIVE",
        "risk_level": "HIGH",
        "summary": (
            "Seller issued EUR 11,500 in refunds across 29 transactions within "
            "72 hours post-payout with zero inbound buyer complaints; refund_abuse "
            "and repeat_chargeback confirmed as collusion — seller was converting "
            "platform credit to cash through fabricated refund cycles."
        ),
        "signals": [
            "decision:BLOCK",
            "pattern:repeat_chargeback",
            "merchant:refund_abuse",
            "rule:dispute_rate",
            "disputes:active",
            "risk:high",
        ],
        "recommended_actions": [
            "Block all outgoing payouts and reclaim refund-credited amounts.",
            "File a suspicious activity report with the relevant financial authority.",
        ],
    },
    {
        "case_id": "SYN-039",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Established seller with a 16% chargeback rate over 45 days; "
            "repeat_chargeback and refund_abuse signals fired, but investigation "
            "found buyers in a single geographic cluster filing coordinated "
            "friendly-fraud claims — merchant may be a victim, not the perpetrator."
        ),
        "signals": [
            "decision:REVIEW",
            "pattern:repeat_chargeback",
            "merchant:refund_abuse",
            "rule:dispute_rate",
            "disputes:active",
            "risk:medium",
        ],
        "recommended_actions": [
            "Withhold payouts pending a buyer-side investigation of the dispute cluster.",
            "If buyer collusion confirmed, clear the merchant and pursue clawback.",
        ],
    },
    {
        "case_id": "SYN-040",
        "verdict": "INCONCLUSIVE",
        "risk_level": "MEDIUM",
        "summary": (
            "Digital-goods merchant flagged for friendly_fraud and repeat_chargeback; "
            "dispute_rate at 9%; deeper review finds a buyer network exploiting a "
            "platform policy loophole to mass-dispute digital keys — merchant is the "
            "economic victim but the signal profile is indistinguishable from "
            "genuine merchant collusion without manual ops review."
        ),
        "signals": [
            "decision:REVIEW",
            "pattern:repeat_chargeback",
            "merchant:friendly_fraud",
            "rule:dispute_rate",
            "disputes:active",
            "risk:medium",
        ],
        "recommended_actions": [
            "Escalate to ops for manual case-by-case dispute review.",
            "If buyer network confirmed, block the network and release merchant payouts.",
        ],
    },
]
