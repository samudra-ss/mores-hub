-- Field payments port (apps/payments prototype -> apps/api)
--
-- Adds: FieldAgent, PaymentRequest, GatewayPayout, ReconciliationRun,
--       new TxnType values, and TWO database-level guarantees on the ledger:
--
--   1. ledger_balanced  — a DEFERRED constraint trigger: at COMMIT, every
--      transaction touched must satisfy sum(DEBIT) = sum(CREDIT). Application
--      code already checks this (LedgerService.post), but the database is the
--      last line of defence against a buggy code path or a manual psql write.
--
--   2. ledger_append_only — LedgerEntry rows can never be UPDATEd or DELETEd.
--      Corrections are posted as reversals, which is what an auditor expects.

-- ---------------------------------------------------------------- enums
ALTER TYPE "TxnType" ADD VALUE IF NOT EXISTS 'REIMBURSEMENT';
ALTER TYPE "TxnType" ADD VALUE IF NOT EXISTS 'VENDOR_PAYMENT';
ALTER TYPE "TxnType" ADD VALUE IF NOT EXISTS 'BUDGET_ALLOCATION';

CREATE TYPE "RequestKind" AS ENUM ('REIMBURSEMENT', 'VENDOR_PAYMENT');
CREATE TYPE "RequestStatus" AS ENUM
  ('PENDING', 'APPROVED', 'DISBURSING', 'PAID', 'REJECTED', 'FAILED');
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SETTLED', 'FAILED');

-- ---------------------------------------------------------------- tables
CREATE TABLE "FieldAgent" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "walletId"     TEXT NOT NULL,
    "monthlyQuota" BIGINT NOT NULL DEFAULT 5000000,
    "perTxnLimit"  BIGINT NOT NULL DEFAULT 2000000,
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FieldAgent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FieldAgent_userId_key" ON "FieldAgent"("userId");
CREATE UNIQUE INDEX "FieldAgent_walletId_key" ON "FieldAgent"("walletId");
ALTER TABLE "FieldAgent"
  ADD CONSTRAINT "FieldAgent_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FieldAgent_walletId_fkey" FOREIGN KEY ("walletId")
    REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentRequest" (
    "id"            TEXT NOT NULL,
    "ref"           TEXT NOT NULL,
    "agentId"       TEXT NOT NULL,
    "kind"          "RequestKind" NOT NULL,
    "amount"        BIGINT NOT NULL,
    "category"      TEXT NOT NULL DEFAULT 'general',
    "description"   TEXT,
    "merchant"      TEXT,
    "bankCode"      "IdBank" NOT NULL,
    "bankAccount"   TEXT NOT NULL,
    "bankHolder"    TEXT NOT NULL,
    "receiptKey"    TEXT NOT NULL,
    "status"        "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById"   TEXT,
    "decidedAt"     TIMESTAMP(3),
    "decisionNote"  TEXT,
    "transactionId" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentRequest_amount_positive" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "PaymentRequest_ref_key" ON "PaymentRequest"("ref");
CREATE UNIQUE INDEX "PaymentRequest_transactionId_key" ON "PaymentRequest"("transactionId");
CREATE INDEX "PaymentRequest_status_createdAt_idx" ON "PaymentRequest"("status", "createdAt");
CREATE INDEX "PaymentRequest_agentId_createdAt_idx" ON "PaymentRequest"("agentId", "createdAt");
ALTER TABLE "PaymentRequest"
  ADD CONSTRAINT "PaymentRequest_agentId_fkey" FOREIGN KEY ("agentId")
    REFERENCES "FieldAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GatewayPayout" (
    "id"             TEXT NOT NULL,
    "gatewayRef"     TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestId"      TEXT NOT NULL,
    "amount"         BIGINT NOT NULL,
    "bankCode"       "IdBank" NOT NULL,
    "bankAccount"    TEXT NOT NULL,
    "status"         "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"      TIMESTAMP(3),
    CONSTRAINT "GatewayPayout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GatewayPayout_gatewayRef_key" ON "GatewayPayout"("gatewayRef");
CREATE UNIQUE INDEX "GatewayPayout_idempotencyKey_key" ON "GatewayPayout"("idempotencyKey");
CREATE INDEX "GatewayPayout_status_idx" ON "GatewayPayout"("status");
ALTER TABLE "GatewayPayout"
  ADD CONSTRAINT "GatewayPayout_requestId_fkey" FOREIGN KEY ("requestId")
    REFERENCES "PaymentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReconciliationRun" (
    "id"              TEXT NOT NULL,
    "ranAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ledgerDebits"    BIGINT NOT NULL,
    "ledgerCredits"   BIGINT NOT NULL,
    "clearingBalance" BIGINT NOT NULL,
    "unbalancedTxns"  INTEGER NOT NULL,
    "ok"              BOOLEAN NOT NULL,
    "notes"           TEXT,
    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReconciliationRun_ranAt_idx" ON "ReconciliationRun"("ranAt");

-- ---------------------------------------------------------------- invariant 1
-- Per-transaction balance, checked at COMMIT (deferred), so multi-row postings
-- written inside one database transaction settle before the check fires.
CREATE OR REPLACE FUNCTION ledger_txn_balanced() RETURNS trigger AS $$
DECLARE
  tid TEXT;
  debits  BIGINT;
  credits BIGINT;
BEGIN
  tid := COALESCE(NEW."transactionId", OLD."transactionId");
  SELECT
    COALESCE(SUM(CASE WHEN "direction" = 'DEBIT'  THEN "amount" ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amount" ELSE 0 END), 0)
  INTO debits, credits
  FROM "LedgerEntry" WHERE "transactionId" = tid;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'ledger imbalance on transaction %: debits % != credits %',
      tid, debits, credits;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balanced();

-- ---------------------------------------------------------------- invariant 2
-- The ledger is append-only. Mistakes are corrected with reversals, never edits.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'LedgerEntry is append-only (attempted %). Post a reversal instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_mutation
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
