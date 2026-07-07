# Field Payments module

NestJS port of the `apps/payments` Flask prototype (the executable spec).
Reimbursements, vendor payment orders, budget allocation, gateway
disbursement, and nightly ledger reconciliation.

## What maps to what

| Prototype (Flask + SQLite) | Here (NestJS + Prisma + PostgreSQL) |
|---|---|
| `users` role='agent' + `wallets` | `FieldAgent` (+ a dedicated quota `Wallet`) |
| `transactions` (reimbursement / direct_payment) | `PaymentRequest` |
| `transactions` (topup) | `Transaction` type `BUDGET_ALLOCATION` |
| `ledger_entries` on named accounts | `LedgerEntry` on SYSTEM wallets (`SYSTEM:CORPORATE_MAIN`, `SYSTEM:CLEARING_GATEWAY`, `SYSTEM:EXPENSE:<cat>`) |
| `gateway_payouts` | `GatewayPayout` (+ `idempotencyKey`) |
| Python zero-sum assert in `post_ledger()` | **deferred constraint trigger** in Postgres + `LedgerService` check |
| manual zero-sum verification | `ReconciliationService` `@Cron` nightly + `ReconciliationRun` table |
| `audit_log` | existing hash-chained `AuditLog` (wire via `AuditService`) |

QRIS payments stay in `QrisModule`; call
`FieldPaymentsService.assertWithinLimits(agent, amount, true)` before charging
an agent's quota wallet to enforce the monthly quota there too.

## Ledger invariants — enforced in three layers

1. **Application** — `LedgerService.post()` writes balanced pairs atomically.
2. **Database** — migration `20260706093000_field_payments`:
   - `ledger_balanced`: DEFERRABLE INITIALLY DEFERRED constraint trigger; at
     COMMIT every touched transaction must satisfy sum(DEBIT)=sum(CREDIT).
   - `ledger_no_mutation`: `LedgerEntry` is append-only; corrections are
     posted as reversals.
3. **Nightly job** — `ReconciliationService` (02:00 Asia/Jakarta): global
   debits=credits, per-transaction sweep, and `CLEARING_GATEWAY` must net to
   exactly the pending in-flight payout amount. Failures write a
   `SuspiciousActivity` row (treated as an incident, not a log line).

## Money flow

```
allocate   CORPORATE_MAIN   -> agent quota wallet     BUDGET_ALLOCATION
approve    CORPORATE_MAIN   -> CLEARING_GATEWAY       REIMBURSEMENT | VENDOR_PAYMENT (status DISBURSING)
settle ok  CLEARING_GATEWAY -> EXPENSE:<category>     (status PAID)
settle ko  CLEARING_GATEWAY -> CORPORATE_MAIN         REFUND (status FAILED, retryable)
```

`DisbursementService.settle()` is idempotent (atomic PENDING→terminal flip),
so provider webhook retries and the mock's 4-second timer share one code path
and double-settlement is impossible.

## Endpoints (all under `/field-payments`)

Agent: `GET summary` · `GET requests/mine` · `POST requests` (multipart,
`receipt` file). Finance (Admin role ≥ OPERATIONS): `GET approvals` ·
`POST approvals/:id` `{action, note}` · `POST requests/:id/retry` ·
`POST agents` · `POST agents/:id/topup` · `GET usage?month=` ·
`GET reconciliation` · `POST reconciliation/run`. Files:
`GET receipts/:key` (owner or finance). Public: `POST webhooks/gateway`
(HMAC-SHA256 over raw body, header `x-callback-signature`, secret
`GATEWAY_WEBHOOK_SECRET`).

## Bring-up (needs Node + Postgres — not run on the dev machine yet)

```bash
cd apps/api
npm install                       # pulls new @nestjs/schedule
npx prisma migrate dev            # applies 20260706093000_field_payments
npm run start:dev
```

Notes:
- `main.ts` now boots with `rawBody: true` (webhook HMAC needs it).
- BigInt: add a JSON serializer if not present —
  `(BigInt.prototype as any).toJSON = function () { return this.toString(); }`
  in `main.ts`, or map DTOs explicitly.
- Swap `MockDisbursementProvider` → `XenditProvider` in
  `field-payments.module.ts` (`DISBURSEMENT_PROVIDER` token) to go live.
