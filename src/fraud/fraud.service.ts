import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

export interface FraudCheckRequest {
  transaction_id: number;
  seller_id: number;
  amount: number;
  seller_payout_count_24h?: number;
  seller_total_amount_24h?: number;
  seller_failed_payouts_7d?: number;
  seller_account_age_days?: number;
  seller_dispute_count?: number;
}

export interface FraudCheckResponse {
  transaction_id: number;
  risk_score: number;
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK';
  rules_triggered: Array<{
    rule: string;
    triggered: boolean;
    score: number;
    reason: string | null;
  }>;
}

@Injectable()
export class FraudService {
  private readonly baseUrl: string;

  constructor(
    @InjectPinoLogger(FraudService.name)
    private readonly logger: PinoLogger,
  ) {
    this.baseUrl = process.env.FRAUD_ENGINE_URL || 'http://localhost:8000';
  }

  async checkTransaction(params: FraudCheckRequest): Promise<FraudCheckResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`Fraud engine returned ${response.status}`);
      }

      const result = (await response.json()) as FraudCheckResponse;

      this.logger.info(
        { transactionId: params.transaction_id, riskScore: result.risk_score, decision: result.decision },
        'Fraud check completed',
      );

      return result;
    } catch (error) {
      this.logger.error(
        { transactionId: params.transaction_id, error: error instanceof Error ? error.message : String(error) },
        'Fraud engine unavailable — defaulting to REVIEW',
      );

      // Fail-open with REVIEW, not BLOCK — don't block payouts if fraud engine is down
      return {
        transaction_id: params.transaction_id,
        risk_score: 0.5,
        decision: 'REVIEW',
        rules_triggered: [{ rule: 'engine_unavailable', triggered: true, score: 0.5, reason: 'Fraud engine unreachable' }],
      };
    }
  }
}