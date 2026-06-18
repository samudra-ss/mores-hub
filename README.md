# MORES-HUB

Indonesian multi-wallet payments platform — wallets, top-up via Indonesian banks, QRIS payments, prepaid cards, expense tracking, and an admin Vault.

> **Status:** scaffolding / sandbox. Payment providers run in **mock mode**. Pursuing **Bank Indonesia PJP licensing** in parallel — see [COMPLIANCE.md](COMPLIANCE.md).

## Monorepo layout

```
MORES-HUB/
├── apps/
│   ├── api/      Node.js + NestJS + Prisma + PostgreSQL  (the brain)
│   ├── mobile/   Flutter (iOS + Android + Web build)
│   └── admin/    Next.js admin Vault (separate origin, hardware key required)
├── packages/
│   └── shared/   shared TS types
├── docker-compose.yml
├── COMPLIANCE.md
└── README.md
```

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| API | NestJS + TypeScript + Prisma | Modules/guards/DI map cleanly to fintech boundaries; easy to bolt on audit logging |
| DB | PostgreSQL 16 | Strong constraints + transactional double-entry ledger |
| Cache / queues | Redis | Session, rate-limit, webhook retry queue |
| Mobile | Flutter 3 | Single codebase → iOS, Android, and Web |
| Admin | Next.js 14 (App Router) | Separate origin from user app; SSR-only sensitive pages |
| Auth | Google OAuth + JWT + device PIN + TOTP for admin | |
| Payments (mocked) | Pluggable `PaymentProvider` interface — swap in Xendit / Midtrans / DOKU |

## Quick start

```bash
# 1. Boot infra
docker compose up -d postgres redis

# 2. API
cd apps/api
cp .env.example .env
npm install
npx prisma migrate dev
npm run seed         # creates demo users + wallets + admin
npm run start:dev    # http://localhost:3000

# 3. Admin
cd ../admin
cp .env.example .env.local
npm install
npm run dev          # http://localhost:3001

# 4. Mobile
cd ../mobile
flutter pub get
flutter run          # pick device
```

Demo credentials are printed by `npm run seed`.

## Core concepts

### Multi-wallet model
Every user has **at least one personal wallet** (created on signup). Users can also create **shared wallets** and grant access to other users with one of three roles:

| Role | Can view | Can spend | Can invite |
|---|---|---|---|
| `OWNER` | yes | yes | yes |
| `MEMBER` | yes | yes | no |
| `VIEWER` | yes | no | no |

A wallet is *only* visible to its owner and people on its access list. Enforced at the database query layer via a `WalletAccessGuard`.

### Double-entry ledger
Balances are **never stored as a column**. They are always derived from `LedgerEntry` rows. Every transaction creates two entries (debit + credit) inside a single Postgres transaction. Sum of debits === sum of credits, enforced by a check constraint and a daily reconciliation job. This is the only way you survive a Bank Indonesia audit.

### Payment provider abstraction
`apps/api/src/payments/provider.interface.ts` defines `PaymentProvider`. The `MockProvider` simulates Xendit-style virtual accounts and webhooks for local dev. To go live, drop in `XenditProvider` (or Midtrans / DOKU) — no other code changes.

### QRIS
Mock mode generates a **MPM (Merchant Presented Mode)** QR payload conforming to QRIS spec (EMVCo TLV format) with mock Merchant ID. Real QRIS requires acquiring bank sponsorship — see COMPLIANCE.md.

### Prepaid card
Mock mode generates virtual card metadata (PAN-less token, expiry, CVV-equivalent). Real issuance requires either a Visa/Mastercard BIN sponsor (e.g. Bank Sahabat Sampoerna) or co-brand with a domestic e-money issuer.

### Admin Vault
Separate Next.js app on a separate origin. Every "big action" (manual ledger adjustment, KYC override, freeze wallet, refund) is:
1. Logged to immutable `AuditLog` table
2. Requires admin TOTP re-confirmation
3. For amounts above a configurable threshold, requires **dual approval** (two admins)

## API surface (high level)

```
POST   /auth/google              Google OAuth callback → JWT
POST   /auth/pin                 set / verify PIN (mobile)
GET    /me                       current user + accessible wallets

POST   /wallets                  create wallet
GET    /wallets/:id              get balance + recent ledger
POST   /wallets/:id/access       grant access to another user
POST   /wallets/:id/transfer     wallet → wallet
GET    /wallets/:id/report       expense report (per category, per period)

POST   /topup/orders             create top-up (returns mock VA number)
POST   /topup/webhook            simulate bank credit (dev only)

POST   /qris/static              generate static MPM QR for a wallet
POST   /qris/dynamic             generate dynamic QR for an amount
POST   /qris/scan                pay a scanned QR

POST   /cards                    issue virtual prepaid card
GET    /cards/:id                card metadata

GET    /admin/users              admin only
POST   /admin/wallets/:id/freeze admin only, audited
POST   /admin/ledger/adjust      admin only, dual-approval, audited
```

## License & compliance
See [COMPLIANCE.md](COMPLIANCE.md) for the PJP licensing roadmap and current sandbox vs. production gating.
