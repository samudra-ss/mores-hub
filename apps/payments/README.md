# MORES PAY — Internal Payment System for Field Agents

Reimbursements, direct payment orders and QRIS payments — submitted by field
agents from a mobile app, approved by Finance on a dashboard, disbursed
through a (mocked) payment gateway, and reconciled on a **double-entry
ledger**.

Built in the MORES-HUB design language (dark `#0a0d0f`, teal `#00a2b6`,
JetBrains Mono accents) and following the same architecture principles as
`apps/api`: derived balances, provider abstraction, append-only audit.

> **Status:** sandbox. The gateway is a mock (Xendit-style). No real money
> moves. See [docs/FRAMEWORK-REVIEW.md](docs/FRAMEWORK-REVIEW.md) for the
> path to production.

---

## Quick start

```bash
cd apps/payments
python server.py        # http://127.0.0.1:8020  (Flask 3 + SQLite, no other deps)
```

The database (`payments.db`) is created and seeded on first run.

| Login | Password | Lands on | Can do |
|---|---|---|---|
| `dimas` `sari` `budi` `ayu` `raka` `nina` | `agent123` (PIN `123456`) | `/agent` | submit, pay QRIS |
| `finance` | `finance123` | `/admin` | approve, top-up, reports |
| `admin` | `admin123` | `/admin` | everything + user management |
| `auditor` | `audit123` | `/admin` | read-only everything |

(`raka` has no budget allocated yet — a deliberate zero-balance state.)

**UI preferences** — every page has two pill toggles (top bar on mobile,
sidebar on the dashboard): **EN/ID** switches the whole UI between English
and Bahasa Indonesia (statuses, tables, flash messages, month names
included), and **☾/☀** switches dark/light theme. Both persist in
`localStorage` and apply before first paint.

**Demo tricks**
- The QRIS screen has two demo scans: **dynamic** (amount locked inside the
  code, tag 01=12 + 54) and **static** (reusable merchant code, tag 01=11,
  agent keys the amount in) — both real EMVCo TLV that the backend parses.
- *Pay Vendor* remembers payees: pick one from the **saved-vendor** dropdown
  (autofills bank details), add one with the ＋ button, or tick
  *"Save this vendor"* on submit.
- `/agent` has its own sign-in page with **biometric login** (WebAuthn):
  enrol under Profile → *Enable biometrics on this device*, then sign in
  with fingerprint/face. Requires `http://localhost:8020` (secure context).
- A bank account starting with `000` always **fails** disbursement — use it
  to demo the failure → ledger reversal → retry flow.
- Approvals settle asynchronously ~4 s after "Approve & disburse", exactly
  like a gateway webhook would arrive.
- Reports (dashboard) has a **⭳ CSV statement button per agent** for
  one-click personnel extracts, plus full transaction and ledger exports.

---

## Architecture

```
apps/payments/
├── server.py        Flask app: auth, RBAC, agent + admin APIs, webhook, CSV
├── database.py      schema, ledger helpers, demo seed
├── gateway.py       PaymentProvider interface + MockProvider + QRIS TLV parser
├── static/
│   ├── index.html   landing + login (routes by role)
│   ├── agent.html   mobile app (phone frame, bottom nav)
│   └── admin.html   dashboard (sidebar: overview/approvals/txns/agents/reports/audit)
├── uploads/         receipt & invoice files (uuid names, served authenticated)
└── payments.db      SQLite (WAL mode), created on first run
```

Single Flask process, session-cookie auth, no build step, no Node — the same
idiom as `apps/erp`, chosen deliberately: this machine has Python 3.14 and no
Node runtime, and a prototype must run where it is developed.

### The money model (the part worth copying)

**Balances are never stored — they are always derived** from
`ledger_entries`. Every movement writes balanced debit/credit rows inside one
SQLite transaction; `post_ledger()` refuses unbalanced postings. This is the
same discipline as the main hub's PostgreSQL ledger and the only way to
survive a Bank Indonesia (or internal) audit.

Accounts:

| Account | Meaning |
|---|---|
| `equity:capital` | opening funding source |
| `corporate:main` | the company float that funds everything |
| `wallet:<user_id>` | an agent's allocated spending balance |
| `clearing:gateway` | money in flight while the gateway disburses |
| `expense:<category>` | final expense recognition |

Flows:

```
top-up            corporate:main   → wallet:<agent>
QRIS payment      wallet:<agent>   → expense:<cat>          (instant)
approve payout    corporate:main   → clearing:gateway       (disbursing)
gateway settles   clearing:gateway → expense:<cat>          (paid)
gateway fails     clearing:gateway → corporate:main         (failed, reversal)
```

`sum(debits) == sum(credits)` across the whole ledger at all times
(verified: the seed + every test flow nets to zero).

### Transaction lifecycle

```
reimbursement / direct_payment:
  pending ──approve──▶ disbursing ──webhook ok──▶ paid
     │                     └──────webhook fail─▶ failed ──retry─▶ disbursing
     └────reject──▶ rejected (note required)

qris:  paid instantly (PIN + per-txn limit + monthly quota + balance checks)
topup: paid instantly (finance/admin allocates corporate float to a wallet)
```

**Quota semantics:** QRIS and direct payment orders consume the agent's
monthly quota (they spend company money going forward). Reimbursements do
*not* consume quota — they repay the agent's own money — but the
per-transaction cap still applies. All checks are server-side.

### Roles

| | agent | finance | auditor | admin |
|---|---|---|---|---|
| mobile app (submit, QRIS) | ✔ | | | |
| approve / reject / retry / top-up | | ✔ | | ✔ |
| reports + CSV + audit log | | ✔ | read-only | ✔ |
| create users, set limits, disable | | | | ✔ |

Auditor is enforced in one place: the `role_required` guard lets `auditor`
through **GET** endpoints that allow `finance`, never mutations.

### Gateway abstraction

`gateway.PaymentProvider` has two methods: `create_disbursement()` and
`create_qris_charge()`. `MockProvider` implements them with a 4-second
settlement timer that calls the same idempotent `settle_disbursement()`
function the signed-webhook endpoint (`POST /api/webhooks/gateway`,
HMAC-SHA256) uses. Going live = writing `XenditProvider` with the same two
methods; nothing else changes.

---

## API reference

All endpoints return JSON; errors are `{"error": "..."}` with 4xx status.
Auth is a session cookie (`POST /api/auth/login`).

### Auth
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` |
| POST | `/api/auth/logout` | any | |
| GET | `/api/auth/me` | any | |
| POST | `/api/auth/pin` | agent | `{pin, old_pin?}` — 6 digits |

### Agent
| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent/summary` | balance, quota, month spend, recent txns |
| GET | `/api/agent/transactions` | own history |
| POST | `/api/agent/reimbursements` | multipart: amount, category, description, bank_code, bank_account, bank_holder?, **receipt** file |
| POST | `/api/agent/payment-orders` | multipart: + merchant, **invoice** file, `save_vendor=1` to remember the payee |
| POST | `/api/agent/qris/parse` | `{payload}` → merchant/city/amount/**scheme** preview |
| GET | `/api/agent/qris/demo?scheme=` | sample EMVCo payload — `dynamic` (tag 01=12, amount in tag 54) or `static` (tag 01=11, no amount) |
| POST | `/api/agent/qris/pay` | `{payload, pin, category, amount?}` — `amount` required for static codes, ignored for dynamic |

### Vendor book (shared payee memory)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/vendors` | any signed-in role; feeds the Pay-Vendor picker |
| POST | `/api/vendors` | agent/finance/admin; upserts by name |

### WebAuthn (biometric sign-in, agents)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/webauthn/register/options` | challenge + platform-authenticator params |
| POST | `/api/webauthn/register/verify` | stores SPKI public key from `getPublicKey()` (ES256/RS256) |
| GET | `/api/webauthn/devices` | enrolled devices for the current agent |
| POST | `/api/webauthn/login/options` | `{username}` → challenge + allowCredentials (pre-auth) |
| POST | `/api/webauthn/login/verify` | full check: challenge, origin, rpIdHash, UP+UV flags, signature |

Biometrics need a secure context — `http://localhost:8020` works, raw IPs
do not. The signature path is covered by an automated test that simulates a
real authenticator (EC P-256) including tampered-signature and wrong-rpId
rejections.

### Admin / finance (auditor: GET only)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/overview` | KPIs + category/daily series |
| GET | `/api/admin/approvals` | pending queue with `receipt_url` |
| POST | `/api/admin/approvals/<id>` | `{action: approve\|reject, note}` — approve triggers disbursement; reject requires note |
| GET | `/api/admin/transactions` | filters: `status`, `type`, `user_id` |
| POST | `/api/admin/transactions/<id>/retry` | failed → disbursing |
| GET/POST | `/api/admin/users` | POST is admin-only; returns generated initial password |
| PATCH | `/api/admin/users/<id>` | admin-only: limits, `is_active`, `reset_password` |
| POST | `/api/admin/topup` | `{user_id, amount, note?}` |
| GET | `/api/reports/usage?month=YYYY-MM` | per-agent usage + quota utilisation |
| GET | `/api/reports/transactions.csv?month=` | Excel-friendly (UTF-8 BOM) |
| GET | `/api/reports/ledger.csv?month=` | full debit/credit export |
| GET | `/api/reports/agent/<id>/statement.csv?month=` | one personnel's monthly statement + summary block — one-click buttons per row in Reports |
| GET | `/api/admin/audit` | append-only trail |

### Files & webhook
| Method | Path | Notes |
|---|---|---|
| GET | `/api/files/<name>` | authenticated; agents only see their own |
| POST | `/api/webhooks/gateway` | `X-Callback-Signature` HMAC-SHA256 verified |

---

## Security notes (sandbox honesty)

Implemented: hashed passwords + PINs (Werkzeug), server-side session cookies,
RBAC on every endpoint, upload type/size validation with random filenames,
authenticated file serving, HMAC webhook verification, idempotent settlement,
append-only audit log, parameterised SQL throughout, and **WebAuthn biometric
sign-in with real signature verification** (challenge, origin, rpIdHash,
UP/UV flags, ES256/RS256 via `cryptography`).

**Not** implemented (needed before anything real): HTTPS/TLS termination,
CSRF tokens (SameSite=Lax cookie is the only mitigation), rate limiting,
login throttling, password rotation policy, encrypted uploads at rest,
maker-checker dual approval above a threshold, WebAuthn attestation +
sign-count regression checks. The production path is in
[docs/FRAMEWORK-REVIEW.md](docs/FRAMEWORK-REVIEW.md).
