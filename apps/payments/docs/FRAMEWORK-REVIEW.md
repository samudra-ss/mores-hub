# Framework Review — Internal Payment System

A review of `payment_system_framework.md` / `.json` (the 15-week,
Flutter + NestJS + PostgreSQL + Xendit plan), judged against MORES'
actual context: an existing MORES-HUB monorepo (NestJS API, Flutter app,
double-entry ledger design), a PJP licence application in progress, and a
development machine that runs Python but not Node.

**Verdict: the framework is a solid generic blueprint, but it plans a
15-week waterfall for a system you can validate in week 1, and it plans a
second fintech stack alongside the one you already own.**

---

## 1. What the framework gets right

- **PostgreSQL for money** — correct instinct; ACID is non-negotiable.
- **Gateway abstraction** (Xendit/Midtrans/Faspay behind one interface) —
  matches the `PaymentProvider` pattern already in MORES-HUB. Keep it.
- **RBAC + approval workflow + audit** as first-class features, not
  afterthoughts.
- **Internal distribution** (managed Google Play / MDM) instead of public
  stores — right call for a field-agent tool.
- **Sandbox-first gateway integration** and explicit edge-case testing
  (gateway timeout, crash during upload).

## 2. Where it goes wrong, and the better option

### 2.1 It's a waterfall. Build a vertical slice first. ✅ *(done — this app)*

Phases 1–6 put working software in agents' hands at **week 13 (UAT)**. The
riskiest assumptions — will agents photograph receipts? does Finance accept
approval-then-auto-disburse? are the quota rules right? — are all testable
with a mock gateway in days, not months.

**Better option:** build the end-to-end slice immediately (mobile submit →
approval → mock disbursement → ledger → report), demo it to Finance and two
real agents, and only then spend integration money. `apps/payments` is that
slice — running, seeded, demoable today. The 15-week plan becomes a
hardening roadmap (§4) instead of a construction plan.

### 2.2 Don't build a second backend. This belongs inside MORES-HUB.

The framework proposes choosing NestJS *or* Django *or* Go as if starting
from zero. But MORES-HUB already has a NestJS + Prisma + PostgreSQL API with
users, wallets, a double-entry ledger and a provider abstraction. An
"internal payment system for field agents" is **a feature module of that
platform** (`ReimbursementModule`, `ApprovalModule`), not a new stack to
operate, secure and audit separately. Two fintech backends = two audit
surfaces for the PJP licence.

**Better option:** treat this prototype as the executable spec; port it as
NestJS modules into `apps/api` when it graduates. The API contract in the
README is deliberately transport-plain (JSON + multipart) to make that port
mechanical.

### 2.3 Mobile: a PWA covers 90% of this. Flutter only if you need the 10%.

The agent app needs: camera upload, QRIS scan, PIN, status list. Browsers do
all of it — `<input capture>` for receipts, `getUserMedia` + a JS QR decoder
for scanning, WebAuthn for biometrics. A PWA skips MDM/app-store
distribution entirely (a real cost the framework itself flags in Phase 6)
and ships updates instantly.

**Better option:** ship `agent.html` as a PWA (manifest + service worker)
for the pilot. Adopt Flutter — which MORES-HUB already uses — only when you
hit genuine native needs: offline queueing of submissions in poor-signal
field areas, hardware-backed key storage for PIN, or push notifications.
Then reuse the hub's existing Flutter shell rather than a new app.

### 2.4 Gateway: pick Xendit, integrate once, behind the existing interface.

The framework lists three providers without choosing. For this workload
(QRIS acquiring + bank disbursement in one API, good sandbox, first-class
IDR support), **Xendit** is the strongest default; Midtrans is the fallback
if commercial terms disagree. What matters more than the pick: the app never
talks to the provider directly — `MockProvider` and `XenditProvider` share
two methods. This prototype already enforces that seam, including the
HMAC-verified webhook and idempotent settlement you'll need for real
callbacks (Xendit retries; double-settlement must be impossible).

### 2.5 The approval hierarchy question, answered concretely.

Phase 1 says "define business rules (1 or 2 approvers?)" and leaves it open.
Leaving it open is how workflow engines get over-built.

**Better option:** single finance approval below a threshold (e.g.
Rp 5.000.000), **maker-checker** (finance approves, admin releases) at or
above it. Ship the single-approval flow first — that's what this prototype
does — and add the second signature as one status (`awaiting_release`)
between `approved` and `disbursing` when the threshold rule is confirmed.

### 2.6 Two design gaps the framework misses entirely

1. **No ledger.** It lists `Transactions` and `Budgets` tables but never
   demands double-entry. Storing balances as columns is the classic
   fintech mistake — mutable balances can't be audited or reconciled. This
   prototype derives every balance from balanced debit/credit rows through
   a clearing account; carry that into production unchanged.
2. **Reimbursement vs quota semantics.** A reimbursement repays the agent's
   own money; QRIS/vendor payments spend company money. They must hit
   budget checks differently (quota applies to the latter, only the
   per-transaction cap to the former) — the framework treats all three as
   interchangeable "transactions".

### 2.7 Timeline arithmetic

15 weeks assumes serial phases and one team. With the slice-first approach:
pilot in **~2 weeks** (this app + PWA polish + real user list), Xendit
sandbox integration in **weeks 3–4**, hardening + UAT **5–8**, production
**~week 9** — roughly half the plan, with feedback flowing from week 1.

## 3. Corrected stack recommendation (MORES context)

| Layer | Framework says | Use instead | Why |
|---|---|---|---|
| Prototype backend | pick NestJS/Django/Go | **Flask + SQLite** (this app) | runs on the actual dev machine today; executable spec |
| Production backend | new service | **module in `apps/api`** (NestJS + Prisma + Postgres) | one platform, one audit surface, ledger already designed |
| Agent app | Flutter or RN | **PWA now → hub's Flutter later** | zero distribution cost for pilot; native only when needed |
| Dashboard | React/Next + UI kit | keep server-rendered/vanilla now; **Next.js in `apps/admin`** when ported | admin Vault already exists on a separate origin |
| Gateway | Xendit/Midtrans/Faspay | **Xendit** behind `PaymentProvider` | QRIS + disbursement in one integration; interface already enforced |
| DB | PostgreSQL | SQLite (pilot) → **PostgreSQL 16** (prod) | Postgres was already right; SQLite is fine below ~50 concurrent users |
| Storage | S3/GCS | local uploads (pilot) → **S3-compatible w/ SSE** | don't buy cloud storage before UAT |

## 4. Production checklist (what graduates this sandbox)

- [x] Port API to `apps/api` NestJS modules; Prisma migrations for the new
      tables; keep the ledger invariant as a DB constraint + nightly
      reconciliation job (sum debits = sum credits, clearing nets to zero).
      → done: `apps/api/src/field-payments/` (module, services, controller,
      cron) + migration `20260706093000_field_payments` (deferred
      constraint trigger + append-only ledger trigger). Code-complete;
      needs `npm install && npx prisma migrate dev` on a machine with
      Node + Postgres (this dev machine has neither running).
- [ ] Real `XenditProvider` (QRIS dynamic charge + disbursement + webhook
      signature validation + idempotency keys on create).
- [ ] AuthN hardening: CSRF tokens, rate limiting, login throttling, TLS,
      WebAuthn for agent biometrics, TOTP for finance/admin (hub standard).
- [ ] Maker-checker release step above the agreed threshold (§2.5).
- [ ] Receipts to S3-compatible storage, server-side encryption, retention
      policy per BI record-keeping rules.
- [ ] PWA manifest + offline submission queue; managed distribution only if
      the Flutter path is chosen.
- [ ] Pen test + UAT with real agents (framework Phase 5 — this part was
      right, just do it against a system users have already been using).
