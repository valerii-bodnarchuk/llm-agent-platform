-- Durable, append-only storage for fraud investigation agent runs.

CREATE TABLE "InvestigationRun" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "verdict" TEXT,
    "confidence" DOUBLE PRECISION,
    "riskLevel" TEXT,
    "summary" TEXT,
    "verdictPayload" JSONB,
    "toolCalls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvestigationAuditEntry" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "stage" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAuditEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvestigationRun_transactionId_idx" ON "InvestigationRun"("transactionId");
CREATE INDEX "InvestigationRun_verdict_idx" ON "InvestigationRun"("verdict");
CREATE INDEX "InvestigationRun_completedAt_idx" ON "InvestigationRun"("completedAt");

CREATE INDEX "InvestigationAuditEntry_runId_idx" ON "InvestigationAuditEntry"("runId");
CREATE INDEX "InvestigationAuditEntry_action_idx" ON "InvestigationAuditEntry"("action");
CREATE UNIQUE INDEX "InvestigationAuditEntry_runId_sequence_key" ON "InvestigationAuditEntry"("runId", "sequence");

ALTER TABLE "InvestigationAuditEntry"
ADD CONSTRAINT "InvestigationAuditEntry_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "InvestigationRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
