# Compliance & Licensing — MORES-HUB

> Pursuing **PJP (Penyedia Jasa Pembayaran)** license under **PBI 23/6/PBI/2021** and supporting POJK regulations. This document is the operational checklist; legal counsel signs the final version.

## Regulatory framework (Indonesia)

| Body | Regulation | What it governs |
|---|---|---|
| Bank Indonesia (BI) | PBI 23/6/PBI/2021, PADG 23/11/PADG/2021 | Payment service provider licensing, capital, governance |
| Bank Indonesia | PBI 19/8/PBI/2017 | National Payment Gateway (GPN) |
| Bank Indonesia | PADG 21/18/PADG/2019 | QRIS (Quick Response Code Indonesian Standard) |
| OJK | POJK 12/2017, POJK 4/2023 | KYC (CDD/EDD), AML, governance |
| PPATK | UU 8/2010 | AML / CFT reporting (LTKM, LTKT) |
| Kominfo | PP 71/2019 | Electronic system operator (PSE) registration |
| UU PDP 27/2022 | Personal data protection (Indonesia's GDPR) |

## PJP categories (pick one)

| Category | Activities allowed | Min paid-in capital (modal disetor) |
|---|---|---|
| **Category 1** | Issuing payment instruments, acquiring, account issuance, fund transfers, e-money | **IDR 15B** |
| **Category 2** | Payment initiation + account information services | **IDR 5B** |
| **Category 3** | Payment system operator (remittance, narrow scope) | **IDR 500M – 3B** |

> MORES-HUB target: **Category 1** (we want to issue wallets/cards and acquire QRIS merchants). If capital is a blocker, start **Category 2** and act as PISP/AISP on top of partner bank accounts.

## Pre-license go-live path (what we can do now without our own license)

You can launch in the market by **riding on a licensed partner**:

1. **Partner with an existing PJP** (e.g. Xendit, Midtrans, DOKU, Flip for Business) as a **merchant aggregator client**. Wallets are technically held in their licensed system; you own the UX.
2. **Co-brand prepaid card** with an existing e-money issuer (Bank Sahabat Sampoerna, Bank Neo, BNC, or international BIN sponsor like Nium / Rapyd).
3. **QRIS** through your acquiring bank — they list MORES-HUB as a sub-merchant aggregator.

This lets MORES-HUB go live in **2–4 months** while the PJP application runs in parallel (**6–18 months**).

## License application checklist

### Corporate
- [ ] PT (Perseroan Terbatas) established, ≥51% Indonesian ownership for Category 1
- [ ] Paid-in capital deposited and verified
- [ ] Fit & proper test passed by directors and commissioners (BI assessment)
- [ ] Independent commissioner appointed
- [ ] Business plan (5 years) submitted

### Technology & security
- [ ] **ISO/IEC 27001** certification (information security)
- [ ] **PCI-DSS Level 1** if handling card PAN (we avoid this by tokenizing via issuer)
- [ ] Penetration test by BSSN-listed assessor (annual)
- [ ] Disaster Recovery site in Indonesia, RTO ≤ 4 hours
- [ ] Data residency: customer data **must** be stored in Indonesia (UU PDP + BI rules)
- [ ] Source code escrow

### Compliance & risk
- [ ] AML/CFT program approved by PPATK
- [ ] KYC tiers defined (basic / verified / enhanced) with limits per POJK 12/2017
- [ ] Sanctions screening (DTTOT list — Indonesia's sanctions list)
- [ ] Suspicious Transaction Reporting (LTKM) integration with PPATK goAML
- [ ] Cash Transaction Reporting (LTKT) for transactions ≥ IDR 500M
- [ ] Customer complaint mechanism + dispute resolution SLA

### Operational
- [ ] Indonesian-incorporated office with on-site staff
- [ ] 24/7 customer service (Bahasa Indonesia)
- [ ] Audited financial statements (Big-4 auditor)
- [ ] Internal audit & risk committee

## How this scaffold supports compliance

| Requirement | How the codebase addresses it |
|---|---|
| Double-entry ledger | `apps/api/src/ledger/` — all balance changes via paired entries inside DB transaction |
| Audit trail | `AuditLog` table + interceptor on every admin endpoint |
| Data residency | Postgres provisioned in `id-jakarta` region (see `docker-compose.yml` comment); no PII leaves Indonesia in production |
| KYC tiering | `User.kycTier` enum (`UNVERIFIED`, `BASIC`, `VERIFIED`, `ENHANCED`); transaction limits checked per tier |
| Sanctions screening | `apps/api/src/compliance/sanctions.service.ts` — interface stub for DTTOT screening |
| AML thresholds | `LTKT_THRESHOLD_IDR = 500_000_000` constant; flagged transactions written to `SuspiciousActivity` table |
| Dual approval | Admin Vault enforces 2-of-N approval for ledger adjustments above threshold |
| Immutable audit | `AuditLog` is append-only; daily hash-chain commit |
| Encryption at rest | Postgres TDE in production; PIN stored as Argon2id |
| Encryption in transit | TLS 1.3 enforced; HSTS, mTLS for admin |
| PIN security | Argon2id, 6-digit PIN, lockout after 5 attempts, 24h cool-down |

## Sandbox vs production gating

Every payment-related env has `MODE=mock|sandbox|production`:
- **mock** → in-process simulator, no external calls (default for local dev)
- **sandbox** → real partner sandbox (Xendit sandbox, etc.)
- **production** → live partner; refuses to start unless BI license number is set in env (`BI_PJP_LICENSE_NO`)

This prevents accidentally running prod credentials in dev.
