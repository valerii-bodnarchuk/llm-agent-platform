# Risk Model

## Dispute Loss Allocation

When a buyer wins a dispute, who absorbs the loss?

### Scenario 1: Payout NOT yet released
- Funds still in escrow → refund buyer from escrow
- **Loss: None** — money never left platform

### Scenario 2: Payout released, seller has balance
- Reverse payout → debit seller account → refund buyer
- **Loss: Seller** absorbs the loss

### Scenario 3: Payout released, seller withdrew funds
- Reverse payout → seller balance goes negative
- Seller blocked (payoutsBlocked: true)
- **Loss: Platform** until seller repays negative balance
- Recovery: future payouts withheld until balance recovered

## Negative Balance Policy
- Seller accounts allow negative balance (allowNegative: true)
- When negativeBalance > 0 → payouts automatically blocked
- Admin can manually review and force-unblock

## Platform Fee on Disputes
- If payout reversed: platform fee is also reversed
- Platform does not profit from disputed transactions

## Fraud Prevention
- Sellers with multiple disputes → status: RESTRICTED
- KYC verification required before first payout (Stripe Connect)
- Dispute rate monitoring via admin dashboard