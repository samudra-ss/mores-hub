# THE ORACLE — *Ahli Nujum*

**A going-concern gate on project budgets, built on the three-activity cash flow framework.**

Companion to `FPA-FRAMEWORK.md`. Build task: `phase-oracle.md`.

---

## 0. Two defects to fix before this can be trusted

**[certain] `1170 CC BCA VISA CARD` is classified as an asset under `1100 Cash & Bank`.**
`database.py:110`. A credit card is a liability in substance — money you owe, not money you
hold. Both `reports.cash_flow()` (`:696`) and `reports.weekly_cash_flow()` (`:920`) sweep
`type='asset' AND code LIKE '11%'`, so today card spending is booked as cash movement and
any card balance inflates the cash position. For the Oracle this is fatal: it would report a
buffer you do not have. **Reclassify to `2xxx` (Liabilities), or exclude it from the cash set
explicitly and document why.** Nothing downstream is safe until this is settled.

**[certain] The codebase holds two different definitions of "cash".**
`dashboard()` honours the configurable selection from `get_cash_codes()`
(`server.py:1134`, backed by `app_settings.dashboard_cash_codes`). `cash_flow()` and
`weekly_cash_flow()` hardcode `code LIKE '11%'` and ignore it. So the dashboard's cash tile
and the cash flow report can already disagree. The Oracle needs exactly one definition —
promote `get_cash_codes()` into `reports.py` and make all three read it.

**[likely] No dividends account exists**, so CFF is structurally incomplete. Add
`2400 Dividends Payable` (liability) and `3300 Dividends Declared` (equity contra) to the
standard COA.

---

## 1. What the Oracle is

It runs at the moment a project budget is submitted for approval, and answers one question:

> **If we commit this, does the group stay above its cash buffer — and if not, on what date
> does it break, by how much, and which items caused it?**

It is a **gate**, not a report. Its value is in refusing.

### Why a monthly budget cannot answer it

`plan_lines` is month-grain. Going concern is broken by **dates**: payroll on the 25th, a
vendor on the 12th, a loan instalment on the 5th, a client who pays 40 days after the due
date. A month that nets positive can still be insolvent on the 14th.

So the Oracle needs a new grain — **dated commitment items** — and a **daily** cash ledger.
That is the whole reason this is its own section and not a chart on the forecast screen.

---

## 2. The three activities — how each one enters the ledger

The user-facing framework is the standard split. Each activity answers a different question,
and the Oracle reports all three because the *mix* is the going-concern signal, not the total.

### CFO — Operating

```
CFO = collections from customers
    − payments to vendors and subcontractors
    − payroll and benefits
    − tax paid
    − interest paid          (PSAK 2 / IAS 7 permit CFO or CFF; default CFO, configurable)
```

Accounts: 4xxx, 5xxx, 6xxx (**less non-cash**), 7200, and the working-capital movers
1200 AR · 1300 Inventory · 1400 Prepaid · 2100 AP · 2200 Accrued · 2300 Taxes Payable.

**Non-cash must be excluded or the Oracle lies optimistically:** 6500 Depreciation Expense
and 1510 Accumulated Depreciation never move cash.

### CFI — Investing

```
CFI = − capex on fixed assets
    + proceeds from disposals
    − investment outflows        (the existing `investments` table + `investment_events`)
    + investment returns
```

Accounts: 1500 Fixed Assets, 1510 (contra, non-cash), plus `investment_events`
where `kind='outflow'` / `kind='benefit'`.

CFI is the most **deferrable** activity — which is why the Oracle's remedy engine looks here
first.

### CFF — Financing

```
CFF = + loan drawdowns
    − loan principal repayments
    − dividends paid
    + capital injections
```

Accounts: 2500 Bank Loans, 3100 Share Capital, and the two new dividend accounts.
Intercompany (1900 / 2900) is financing at entity level and **eliminated** at group level —
reuse `reports._consolidated()`.

### The classification lives on the account

New column, seeded from the standard COA, overridable per account in Settings:

```sql
_add_column(conn, "accounts", "cash_flow_class", "TEXT NOT NULL DEFAULT ''")
-- '' | 'operating' | 'investing' | 'financing' | 'cash' | 'noncash' | 'eliminate'
```

Seed map:

| Codes | class |
|---|---|
| the configured cash set (1110, 1120, 1130 — **not** 1170) | `cash` |
| 1200, 1300, 1400, 2100, 2200, 2300, 4xxx, 5xxx, 6xxx, 7200, 7300-xx | `operating` |
| 6500 | `noncash` |
| 1500 | `investing` |
| 1510 | `noncash` |
| 2500, 3100, 2400, 3300 | `financing` |
| 1900, 2900 | `eliminate` |

An account left at `''` is reported in an **Unclassified** bucket on the Oracle screen and
counted as `operating` for the verdict — visible, never silently dropped.

---

## 3. Dated commitments — the new grain

```sql
CREATE TABLE IF NOT EXISTS commitment_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER NOT NULL REFERENCES companies(id),
    project_id    INTEGER REFERENCES projects(id),
    version_id    INTEGER REFERENCES plan_versions(id) ON DELETE CASCADE,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    label         TEXT NOT NULL DEFAULT '',
    counterparty  TEXT NOT NULL DEFAULT '',
    direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
    amount        REAL NOT NULL DEFAULT 0,
    due_date      TEXT NOT NULL,
    certainty     TEXT NOT NULL DEFAULT 'planned'
                    CHECK (certainty IN ('committed','planned','expected','speculative')),
    cf_class      TEXT NOT NULL DEFAULT ''
                    CHECK (cf_class IN ('','operating','investing','financing')),
    deferrable    INTEGER NOT NULL DEFAULT 1,
    defer_limit_days INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','budget','contract','payable','receivable',
                                      'payroll','loan','investment')),
    source_id     INTEGER,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commit_due     ON commitment_items(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_commit_version ON commitment_items(version_id);
```

`cf_class` empty means *inherit from the account* — set it explicitly only to override.

### The certainty ladder — this is what keeps the Oracle honest

**Outflows**

| certainty | meaning | deferrable? |
|---|---|---|
| `committed` | signed contract, PO, payroll, loan schedule — legally owed | no |
| `planned` | in the approved budget, not yet contracted | yes |
| `expected` | forecast only | yes |

**Inflows**

| certainty | meaning |
|---|---|
| `committed` | contracted, invoice issued or scheduled |
| `expected` | contracted backlog not yet invoiced |
| `speculative` | weighted pipeline |

### Where items come from — mostly automatic

| Source | Becomes |
|---|---|
| `payables` (existing table) | outflow, `committed`, due at `due_date` |
| `receivables` (existing table) | inflow, `committed`, at `due_date` + that client's median lag |
| `contracts` (Phase 3) | inflow, `expected`, per its recognition schedule |
| `pipeline` (Phase 3) | inflow, `speculative`, value × probability |
| `plan_lines` for the version under review | outflow, `planned`, due on a per-account default day |
| payroll (6100) | outflow, `committed`, on the payroll day |
| loans (2500) | outflow, `committed`, on the instalment schedule |
| `investment_events` | in/out, `planned`, at `date` |

Only the gaps get typed by hand. **Per-account default due day** is a small settings table
(`payroll → 25th`, `vendors → 30 days after invoice`, `tax → 10th`) so that turning a monthly
budget into dated items is one click, not 200 rows of data entry.

**Receivable lag** — derive per client from their own history rather than a global DSO:

```
lag(client) = median(paid_date − due_date) over that client's settled receivables
              default 14 days when fewer than 3 settled invoices exist
```

The data is already in `receivables`. This is the single biggest accuracy win available.

---

## 4. The cash buffer — *Bantalan Kas*

```
buffer_floor(entity, month) = max(
    absolute_floor(entity),
    months_cover × monthly_fixed_cash_opex(entity)
)

monthly_fixed_cash_opex = trailing 3-month average of posted 6xxx
                          where cash_flow_class = 'operating'
                          excluding 6500 Depreciation
```

Defaults: `months_cover = 2.0`, `absolute_floor` per entity set by policy (there is no
sensible default — **ask, do not guess**). Stored in `app_settings` under
`oracle_buffer_policy`, merged over fallbacks the way `get_thresholds()` (`server.py:1073`)
already does it.

Group buffer is the **sum of entity floors**, not a group-level recomputation — cash trapped
in MLT does not pay MDA's payroll. If the group genuinely sweeps cash between entities, make
that an explicit `cash_pooling: true` policy flag, and say so in the verdict.

---

## 5. The three runs

The Oracle always computes and displays three, and takes its verdict from the strictest.

| Run | Indonesian | Inflows counted | Outflows counted |
|---|---|---|---|
| **Bound** | *Terikat* | `committed` only | `committed` + `planned` |
| **Base** | *Dasar* | `committed` + `expected` + weighted `speculative` | all |
| **Optimistic** | *Cerah* | everything at face value | `committed` + `planned` |

**The verdict comes from Bound.** Base and Optimistic are context, never the answer. An
oracle that gives you the answer you want is a horoscope.

### The daily ledger

```
cash[d]     = cash[d-1] + inflows(d) − outflows(d)
headroom[d] = cash[d] − buffer_floor(entity, month_of(d))
```

Opening `cash[0]` = the posted balance of the configured cash accounts as of today.
Horizon: 180 days default, configurable to 540. Day grain, not month.

### The verdict

```
TOLAK   (Reject)  headroom < 0 on any day in the BOUND run
WASPADA (Watch)   headroom ≥ 0 in Bound, but min headroom < 25% of the buffer floor
                  in any month, OR headroom < 0 anywhere in the BASE run
LULUS   (Pass)    headroom ≥ 25% of the buffer floor every day in Bound
```

**A verdict is never just a colour.** Every response carries:

- `breach_date` — the first day headroom goes negative
- `worst_date`, `worst_shortfall` — the deepest point and by how much
- `top_contributors` — the 5 outflows with the largest amount landing in the 14 days before
  `worst_date`, each with its due date, counterparty and certainty
- `remedy` — see below
- `assumptions` — buffer policy, horizon, collection lags used, certainty mix
  (share of the total by certainty band). If more than 40% of counted inflows are
  `speculative`, say so at the top: the answer rests on money nobody has promised.

---

## 6. The remedy engine — the part worth building

Anyone can print a red light. The Oracle earns its name by saying what fixes it.

```
remedy(breach):
    candidates = outflows in the horizon where
                   deferrable = 1
                   AND certainty != 'committed'
                   AND due_date <= worst_date
    order by (cf_class = 'investing' first,      # capex is the cheapest thing to move
              then amount desc)
    for each candidate:
        shift it later by min(defer_limit_days, days needed)
        recompute the daily ledger
        if min headroom >= 0: return the shift list
    return partial: the best achievable headroom + the residual shortfall
```

Output reads as plain instructions:

> *Move the PRJ-PRISMA equipment purchase (IDR 480 jt, CFI) from 12 Mar to 5 Apr, and the
> subcontractor second instalment (IDR 210 jt, CFO) from 20 Mar to 3 Apr. Headroom then
> stays above IDR 340 jt throughout. Two items, no committed obligation touched.*

If no deferral set works, the Oracle says so and names the gap — that is the moment to raise
financing or refuse the project, and the CEO should hear it in March, not in June.

---

## 7. Going-concern quality flags — what the CFO/CFI/CFF split buys you

The verdict says *whether* you survive. These say *how*, and they matter more over time.

| Flag | Condition | What it means |
|---|---|---|
| **Operating burn** | CFO < 0 for 3 consecutive months | The core business consumes cash. Nothing else on this list can be fixed until this is. |
| **Financing dependence** | CFO < 0 while CFF > 0 covering it | You are alive on borrowed money. The classic going-concern qualification a Big Four auditor writes up. |
| **Avoidable breach** | The breach disappears if CFI outflows in that window are deferred | The easiest fix on the board — the capex is the problem, not the business. |
| **Quality of earnings gap** | CFO ÷ Net profit < 0.7 over 12 months | You are booking profit you are not collecting. For a consulting group this almost always means AR. |
| **Buffer erosion** | Min headroom lower than the prior consult on the same project | Each revision is making it worse. Worth surfacing on the second consult, not the tenth. |

**Financing dependence is the one to put in front of the board.** It is the difference
between "we had a slow quarter" and "we have a business model problem", and it is invisible
in a P&L.

---

## 8. Gate behaviour

`app_settings.oracle_gate_mode` — `advisory` (default) or `blocking`.

- **advisory** — a `TOLAK` shows a full-width warning on the approval screen with the breach
  date and the remedy; approval still proceeds, and the verdict is stamped onto the
  `plan_versions` row (`oracle_verdict`, `oracle_consulted_at`) so it is on the record.
- **blocking** — `POST /api/plan/versions/<vid>/status` to `approved` returns **409** on a
  `TOLAK` unless the caller is an admin passing `override_reason`, which is written to
  `variance_notes`-style audit text.

**Ship advisory.** Blocking a budget approval on a model's say-so in week one is how the
model gets switched off in week two. Turn on blocking once the forecast has a track record
— which is exactly what Phase 7's accuracy scoring is for.

---

## 9. Screen — `#/oracle`

Route `oracle`; remember `MENU_ROUTES` / `NAV_ITEMS` / `app.html`. Nav glyph `◈` won't do —
it is taken by Forecast; use `☾`. Label: `Ahli Nujum (The Oracle)` in ID, `The Oracle` in EN
via the existing `t()`.

**Header** — verdict block. The date is the headline, not the colour:
> **TOLAK** · Buffer breached **14 March 2027** · short by **IDR 340 jt** at the worst point

**Row 1 — the daily cash line.** Cash plotted daily across the horizon; buffer floor as a
filled band beneath; breach region shaded red; Bound solid, Base dashed, Optimistic dotted.
The three lines diverging *is* the uncertainty, drawn honestly.

**Row 2 — the three activities.** CFO / CFI / CFF monthly bars, plus the quality flags from
§7 as pills. This is the section the user's framework names, and it should be the second
thing on the page.

**Row 3 — contributors.** The 5 items driving the worst point: label, counterparty, amount,
due date, certainty pill, cf-class pill, deferrable toggle.

**Row 4 — the remedy.** The proposed shifts as plain sentences with an **Apply to draft**
button that rewrites those `commitment_items.due_date` values in the draft version only —
never a locked one, never a posted entry.

**Row 5 — assumptions**, always expanded on a `TOLAK`: buffer policy, horizon, collection
lags used, certainty mix, and any unclassified accounts.

### On the name

Naming a solvency control after a fortune-teller invites people to argue with the verdict
instead of the inputs. Keep the name — it is memorable and it will get used — but make the
screen argue with the data: the headline is a **date**, the assumptions panel is always one
click away and auto-opens on a reject, and every number traces to an item with a due date and
a certainty band. *Ahli Nujum* that shows its working is a control. One that shows a colour
is a horoscope.

---

## 10. API

```
POST /api/oracle/consult          {version_id} | {company_id, items:[...]}  -> verdict
GET  /api/oracle/ledger?company_id=&horizon_days=&run=bound|base|optimistic
GET  /api/oracle/activities?company_id=&year=          CFO / CFI / CFF monthly + flags
GET  /api/oracle/flags?company_id=
GET|POST /api/oracle/buffer-policy
GET|POST /api/oracle/gate-mode
GET|POST /api/commitments         PUT|DELETE /api/commitments/<int:cid>
POST /api/commitments/from-version/<int:vid>    materialise dated items from plan_lines
POST /api/commitments/apply-remedy              shift due dates in a DRAFT version only
GET|POST /api/settings/cash-flow-classes        per-account override
GET  /api/export/pdf/oracle                     the consult, as a one-page memo
```

`consult` is a **read-only** computation — it must not write `commitment_items` or
`plan_lines`. Only `from-version` and `apply-remedy` write, and only into a draft.

---

## 11. Where it sits in the build

Depends on **Phase 0** (versioned plans) and **Phase 3** (contracts, pipeline). It does
**not** need drivers, forecasting or scenarios.

The Oracle owns `fpa_cash.py` — the daily cash ledger, the collection curve, the buffer
policy. **Phase 6 (Scenario Lab) then imports it instead of writing its own cash bridge.**
Build the Oracle before Phase 6 and Phase 6 gets meaningfully cheaper; build it after and it
reuses what is there. Either order works — building both cash engines does not.

**If going-concern safety at budget-commit time is the live worry, sequence it 0 → 3 →
Oracle**, ahead of variance and forecasting. It is the only phase that can stop the company
from signing something that kills it.

---

## 12. Open decisions — for the CEO, not the developer

1. **`absolute_floor` per entity.** There is no defensible default. What is the smallest cash
   balance MDA, SBR, MLT, KMA and MRS may each hold before you would act?
2. **Cash pooling.** Does the group actually sweep cash between the five entities? If yes,
   the group buffer is one number; if no, it is five. The verdict changes materially.
3. **`months_cover`.** 2.0 is a common convention. For a consulting group with 60-day-plus
   collections, 2.5–3.0 is arguably right.
4. **Interest classification.** CFO (default) or CFF. Pick once; changing it later breaks
   comparability with prior consults.
5. **Gate mode and who may override.** Advisory to start. Who signs a `TOLAK` override, and
   does that person also own the budget? If it is the same person, the gate is decorative.
