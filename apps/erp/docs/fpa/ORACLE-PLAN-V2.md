# THE ORACLE — V2 PLAN
## Week-grain cash budgeting, group-consolidated going-concern, sensitivity analysis

**Supersedes parts of `ORACLE.md` and `phase-oracle.md`.** Written against five requirements
given on 23 August 2026. Where this document and `ORACLE.md` disagree, **this one wins** — the
deviations are listed in §1 with the reason for each.

---

## 0. What was asked

| # | Requirement | Consequence |
|---|---|---|
| 1 | Cash flow **per year** must be safe — never below zero, and warn on the cash buffer | Horizon becomes the fiscal year, and the verdict ladder gains a rung above TOLAK |
| 2 | **Investment Center** is bound to HV and holds committed budget — the Oracle must judge it across all five consolidated cash flows | Investments need a dated commitment schedule; the committed-but-undated remainder is the hard part |
| 3 | Project budgets set **per week within a month** ("Prisma pays in Week 2 November"), split revenue / expense, **cash basis** | New week-grain plan store; the month-grain `budgets` table cannot express it |
| 4 | Output says safe / not safe when a budget scenario is run, plus **sensitivity analysis** for management | New sensitivity module — not in `ORACLE.md` at all |
| 5 | The cash flow seen is **our cash accounts across all five companies** | Group scope by default, with per-entity verdicts underneath |

---

## 1. Deviations from `ORACLE.md`, and why

1. **Horizon: 180 days → the fiscal year.** Requirement 1 is explicit. Horizon becomes
   `year_start → year_end`, configurable to roll 18 months for the budget-approval season.

2. **The plan store is week-in-month, not month.** Requirement 3. `ORACLE.md` assumed
   `plan_lines` at month grain and turned it into dated items with a per-account default day.
   That guess is no longer needed — the user enters the week directly.

3. **The verdict ladder gains `KRITIS`.** `ORACLE.md` had TOLAK / WASPADA / LULUS, all
   measured against the buffer floor. Requirement 1 names two different failures — *below zero*
   and *below the buffer*. They deserve different words. Below zero is not a policy breach, it
   is a bounced payment.

4. **Group scope is the default, per-entity is the binding test.** Requirement 5.
   `ORACLE.md` treated the group as a sum of entity floors. That stays, but the screen now
   leads with the consolidated line and shows all five underneath, because a group total that
   looks fine while MLT is dry is the exact failure the summing was meant to prevent.

5. **Phase 3 (contracts, pipeline) is no longer a dependency.** `ORACLE.md` §11 required it.
   It is not needed: `speculative` and `expected` inflows can be entered directly in the weekly
   plan. This removes 8–12 days from the critical path. Build Phase 3 later if the pipeline
   deserves its own table; the Oracle does not need it to be correct.

6. **New: investment commitment scheduling** (§5) and **sensitivity analysis** (§8). Neither
   exists in `ORACLE.md`.

Everything else in `ORACLE.md` stands — in particular §0 (the two cash defects), the certainty
ladder, the three runs, the remedy engine, and "fail pessimistic".

---

## 2. What is already in the codebase (measured, not assumed)

Read from `apps/erp` at commit `e046ebc`. **Verify line numbers before editing.**

### Already there and useful

| Thing | Where | Note |
|---|---|---|
| `cash_budget(company_id, year, week, cash_in, cash_out)` | `database.py:325` | **Weekly grain already exists** — but company-level only: no project, no account, no certainty |
| `weekly_cash_flow()` — 52-week actual vs budget, running variance | `reports.py:955` | The display pattern to reuse |
| `_cash_week_of()`, `_cash_week_dates()` | `reports.py:936`, `:947` | Week = `(day_of_year − 1) // 7 + 1`, week 52 absorbs the remainder |
| `investments(committed_amount, horizon_years, linked_project_id, …)` | `database.py:273` | |
| `investment_events(date, kind IN ('outflow','benefit'), amount)` | `database.py:298` | Dated — but only records what already happened |
| `_investment_query()` computes `invested` / `benefit` | `server.py:2206` | |
| `budgets(company_id, account_id, project_id, year, month, amount)` | `database.py:243` | Month grain, one number per cell |
| `upsert_budget()` — the NULL-safe upsert pattern to copy | `excel_io.py:503` | |
| `_consolidated()` / `_company_filter()` | `reports.py` | Intercompany elimination |
| `get_cash_codes()` | `server.py:1134` | Configurable cash-account selection |

### Not there — every one of these must be built

`plan_versions` · `plan_lines` · `contracts` · `pipeline` · `drivers` · `commitment_items`

**Phase 0 and Phase 3 were never built.** The `ORACLE.md` dependency chain is entirely
unbuilt, which is why §1.5 above matters: this plan builds the minimum version store it needs
and skips Phase 3 outright.

### Two defects that still block everything

Unchanged from `ORACLE.md` §0 — **neither is fixed yet**:

- **`1170 CC BCA VISA CARD` is an asset under `1100 Cash & Bank`** (`database.py:110`). A credit
  card counted as cash. `cash_flow()` and `weekly_cash_flow()` both sweep
  `type='asset' AND code LIKE '11%'` and will pick it up.
- **Two definitions of "cash".** `dashboard()` honours `get_cash_codes()`; the two cash-flow
  reports hardcode the `11%` prefix and ignore it.

Requirement 5 says the cash number *is* the answer. Both must be fixed in step 0 or every
number in this document is wrong.

---

## 3. The week grain — the foundation

### 3.1 The mismatch nobody should discover mid-build

The user thinks in **"Week 2 of November"**. The existing `cash_budget` thinks in
**"week 45 of the year"** (`reports.py:936`, day-of-year sequential). These are not the same
thing and never line up: week 45 of 2027 starts on 12 November, which most people would call
week 3.

**Decision: the plan store uses `(year, month, week_in_month)`.** It is what was asked for and
it is what a project manager can fill in without a lookup table.

```
week_in_month  days of the month
  1            1  – 7
  2            8  – 14
  3            15 – 21
  4            22 – 28
  5            29 – end of month     (2–3 days; empty when the month has 28 days)
```

Week 5 is short by construction. In a non-leap February it does not exist — the UI must
disable the cell rather than silently accept a number into a bucket with no days in it.

Mapping to the existing 1..52 scheme is derived from the dates, never stored. Both can coexist:
`plan_weeks` is the plan, `cash_budget` stays the published projection (§7.3).

### 3.2 Cash basis — say it in the UI or people will enter billings

Requirement 3 says cash basis. That means a row against `4100 Consulting Revenue` in the weekly
plan is **money collected in that week**, not money invoiced. This is the single most likely
data-entry error in the whole system, and it is silent — the numbers look plausible and the
Oracle passes a budget it should have rejected.

**Mitigation:** the column headers are `Penerimaan (cash in)` / `Pengeluaran (cash out)`, never
"Revenue" / "Expense". The account picker stays, because the class matters for CFO/CFI/CFF, but
the amount is always a cash movement. Put the words *dasar kas / cash basis* in the screen
header, not in a tooltip.

### 3.3 Which day of the week does the money move? — fail pessimistic

A week bucket has to become a date before it can enter a daily ledger. Choosing the middle of
the bucket is the intuitive answer and the wrong one: it flatters both directions at once.

```
outflows  → land on the FIRST day of the bucket   (money leaves as early as the week allows)
inflows   → land on the LAST  day of the bucket   (money arrives as late as the week allows)
```

Stored as `app_settings.oracle_week_settlement`, default `pessimistic`. Alternatives
`midpoint` and `actual_day` (uses a per-account default day where one is configured) exist for
comparison, but **the verdict is always computed on `pessimistic`** — the same reasoning that
fixes the verdict to the Bound run.

---

## 4. Schema

All migrations go in `database.migrate_database()` (`database.py:820`), additive and
idempotent, `_add_column()` / `CREATE TABLE IF NOT EXISTS` only. Never `DROP TABLE`.

### 4.1 `plan_versions` — the minimum version store

```sql
CREATE TABLE IF NOT EXISTS plan_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id      INTEGER REFERENCES companies(id),   -- NULL = group-wide (the normal case)
    year            INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT 'budget'
                      CHECK (kind IN ('budget','forecast','scenario')),
    status          TEXT    NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','approved','locked')),
    base_version_id INTEGER REFERENCES plan_versions(id),
    oracle_verdict  TEXT    NOT NULL DEFAULT '',
    oracle_consulted_at TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

`company_id` is nullable **on purpose**: requirement 5 wants one FY plan spanning all five
entities, consulted as one. A per-entity version is still possible for a single-company
what-if.

`check_version_writable(vid)` — helper raising `ValueError` on `approved` / `locked`. Every
write path calls it.

### 4.2 `plan_weeks` — the cash plan (requirement 3)

```sql
CREATE TABLE IF NOT EXISTS plan_weeks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id  INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
    company_id  INTEGER NOT NULL REFERENCES companies(id),
    project_id  INTEGER REFERENCES projects(id),
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    week        INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),
    flow        TEXT    NOT NULL CHECK (flow IN ('in','out')),
    amount      REAL    NOT NULL DEFAULT 0,
    certainty   TEXT    NOT NULL DEFAULT 'planned'
                  CHECK (certainty IN ('committed','planned','expected','speculative')),
    cf_class    TEXT    NOT NULL DEFAULT ''
                  CHECK (cf_class IN ('','operating','investing','financing')),
    note        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pw_version ON plan_weeks(version_id, company_id, year, month);
CREATE INDEX IF NOT EXISTS idx_pw_project ON plan_weeks(version_id, project_id);
```

**No `UNIQUE` constraint involving `project_id`.** SQLite treats NULLs as distinct, so a
unique index would not stop duplicate group-level rows — the trap `AGENT.md` warns about.
Write through a NULL-safe `upsert_plan_week()` copied from `excel_io.py:503`:

```python
UPDATE ... WHERE version_id=? AND company_id=? AND account_id=? AND project_id IS ?
           AND year=? AND month=? AND week=? AND flow=?
-- then INSERT only when cur.rowcount == 0
```

`cf_class` empty means inherit from the account (§4.4). `certainty` on a plan row is what
feeds the three runs — this is where a PM declares "this one is signed" versus "this one is
hopeful", and it is the only thing standing between a budget and a wish.

### 4.3 `investment_commitments` — requirement 2

`investments.committed_amount` is a lump sum with **no schedule**. `investment_events` records
only what already moved. So the Oracle currently has no way to know when committed investment
money leaves. That gap is the whole of requirement 2.

A new table rather than a new `kind` on `investment_events`, because changing that table's
`CHECK` constraint would require a rebuild, which `AGENT.md` forbids:

```sql
CREATE TABLE IF NOT EXISTS investment_commitments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    year          INTEGER NOT NULL,
    month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    week          INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),
    amount        REAL    NOT NULL DEFAULT 0,
    certainty     TEXT    NOT NULL DEFAULT 'committed'
                    CHECK (certainty IN ('committed','planned','expected')),
    note          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ic_inv ON investment_commitments(investment_id, year);
```

Same week grain as `plan_weeks`, deliberately — one mental model for the whole system.

#### The unscheduled remainder — the part that will actually bite

```
scheduled   = Σ investment_commitments for this investment
already_out = Σ investment_events where kind='outflow'
unscheduled = max(0, committed_amount − scheduled − already_out)
```

`unscheduled` is money the group is **legally committed to** with **no date attached**.
Dropping it is how the Oracle ends up optimistic, which is the one direction it must never
fail in.

**Rule: spread `unscheduled` evenly across the remaining weeks of the fiscal year, at
`committed` certainty, and say so on the screen.** Not silently — a named warning:

> *IDR 1.2 M of investment commitment has no schedule. Spread evenly across the 19 remaining
> weeks. Set the schedule in the Investment Center to replace this assumption.*

Even spreading is a defensible default, not a safe one. Concentration is the risk, so
"pull all unscheduled commitments into the earliest remaining quarter" becomes a **sensitivity
axis** (§8), where management can see what it costs if the money is called early.

### 4.4 Account classification

Unchanged from `ORACLE.md` §2 / `phase-oracle.md` STEP 1:

```python
_add_column(conn, "accounts", "cash_flow_class", "TEXT NOT NULL DEFAULT ''")
```

Seed idempotently (`WHERE code=? AND cash_flow_class=''` so admin overrides survive). `6500`
Depreciation and `1510` Accumulated Depreciation are **`noncash`** — getting these wrong makes
the Oracle optimistic.

### 4.5 `commitment_items` — kept, with new sources

Still worth having as the single dated input the ledger reads, so the remedy engine can shift
dates without touching source tables. DDL as `ORACLE.md` §3, with the source map revised:

| Source | Direction | Certainty | Date |
|---|---|---|---|
| `payables` | out | `committed` | `due_date` |
| `receivables` | in | `committed` | `due_date` + client lag |
| **`plan_weeks`** | in / out | as entered | week bucket → settlement day (§3.3) |
| **`investment_commitments`** | out | as entered | week bucket → settlement day |
| **investment unscheduled remainder** | out | `committed` | spread, flagged |
| payroll (6100), loans (2500) | out | `committed` | schedule |

`plan_lines`, `contracts` and `pipeline` are removed as sources — they do not exist and are no
longer needed.

### 4.6 Also needed

```python
_add_column(conn, "receivables", "paid_date", "TEXT")     # for the client collection lag
```
Backfills NULL. Where NULL, fall back to the 14-day default and mark the item
`lag_source: "default"` so the assumptions panel can show how much rests on a guess.

---

## 5. Buffer policy and the verdict

### 5.1 Policy

`app_settings.oracle_buffer_policy`, merged over fallbacks the way `get_thresholds()`
(`server.py:1073`) already does:

```json
{"months_cover": 2.0,
 "absolute_floor": {"MDA": 0, "SBR": 0, "MLT": 0, "KMA": 0, "MRS": 0},
 "cash_pooling": false,
 "interest_class": "operating",
 "horizon": "fiscal_year",
 "week_settlement": "pessimistic"}
```

```
monthly_fixed_cash_opex(e) = trailing 3-month average of posted 6xxx
                             where cash_flow_class='operating', excluding 6500
buffer_floor(e, m)         = max(absolute_floor[e], months_cover × monthly_fixed_cash_opex(e))
```

`absolute_floor` defaults to 0 deliberately — 0 is visibly wrong, so someone will set it.
Warn on every consult until they do.

### 5.2 The ladder — two different failures

```
KRITIS   (Critical)  cash < 0 on any day in BOUND
                     → not a policy breach; a payment does not clear
TOLAK    (Reject)    cash >= 0 but headroom < 0 on any day in BOUND
WASPADA  (Watch)     headroom >= 0 in BOUND, but min headroom < 25% of the floor
                     in any month, OR headroom < 0 anywhere in BASE
LULUS    (Pass)      headroom >= 25% of the floor every day in BOUND
```

`headroom = cash − buffer_floor`. **The verdict is taken from BOUND. Hardcode it — not a
parameter.** Base and Optimistic are context.

### 5.3 Consolidation across the five (requirement 5)

This is where a group number can lie, so it is worth being blunt about the rule:

- **`cash_pooling: false` (default)** — the group is safe **only if every entity is safe**.
  The group verdict is the **worst entity verdict**, not a verdict on the summed line. Cash
  trapped in MLT does not pay MDA's payroll.
- **`cash_pooling: true`** — one pooled ledger, one floor, one verdict. Only correct if the
  group genuinely sweeps cash between entities.

The screen shows the consolidated line **and** all five entity lines, always. An entity below
its floor is flagged even when the group total looks comfortable.

> **This is decision #2 in `ORACLE.md` §12 and it is still open.** It changes the verdict
> materially and I have defaulted it to `false` because that is the pessimistic reading. If
> the group does sweep cash, say so and the default flips.

---

## 6. The engine — `fpa_cash.py`

Pure functions. No Flask, no globals. Phase 6 (Scenario Lab) imports this rather than writing
a second cash bridge — **never build both**.

```python
def week_dates(year, month, week):            -> (start_iso, end_iso) | None   # None when empty
def settlement_date(year, month, week, flow, mode="pessimistic") -> iso
def materialise(conn, version_id, policy)     -> list[item]                    # §4.5 sources
def daily_ledger(items, opening_cash, start, end, run) -> list[float]
def buffer_floors(conn, company_ids, policy, months)   -> dict
def headroom(ledger, floors)                  -> list[float]
def verdict(bound, base, floors)              -> "KRITIS"|"TOLAK"|"WASPADA"|"LULUS"
def contributors(items, worst_date, n=5)      -> list[item]
def remedy(items, ledger_fn, floors)          -> dict
def consolidate(entity_results, policy)       -> dict                          # §5.3
def sensitivity(base_inputs, axes)            -> dict                          # §8
```

Run filters, unchanged from `ORACLE.md` §5:

| run | inflows counted | outflows counted |
|---|---|---|
| `bound` | `committed` | `committed` + `planned` |
| `base` | `committed` + `expected` + weighted `speculative` | all |
| `optimistic` | all at face value | `committed` + `planned` |

**The ledger is daily internally, weekly on screen.** Daily because payables and receivables
carry real due dates and payroll lands on the 25th; weekly because that is the grain the user
plans in and 52 columns is a readable year. Storing the ledger daily and aggregating for
display costs nothing and keeps the breach *date* exact — which is the headline.

Cost check: 365 days × ~5 entities × a few thousand items is microseconds per run. The
sensitivity module below needs roughly 100 recomputes; there is no performance problem here
and no need to cache anything.

---

## 7. Screens

### 7.1 `#/budgets` — a new **Cash Plan (weekly)** tab

Requirement 3. Tab alongside the existing month-grain budget grid, which stays untouched
because `budget-vs-actual` and the P&L reports depend on it.

- **Month accordion, not a 60-column grid.** Pick a month → 5 week columns (`W1…W5`, with the
  date range under each header, and `W5` disabled when the month is 28 days).
- Two blocks, visually separated: **Penerimaan (cash in)** and **Pengeluaran (cash out)**.
- Rows: account × project. Row actions: certainty pill (defaults `planned`), cf-class override.
- Right rail: month total in / out / net, and the year-to-date running cash position so the
  planner sees the consequence while typing.
- **Seed from monthly budget** — one button, spreads each `budgets` month cell across its weeks
  by policy (even by default). Turns an existing budget into a weekly plan in one click rather
  than 600 cells of typing.

### 7.2 `#/oracle` — the consult

Route `oracle`, nav glyph `☾`, under **HV Sections**. Remember all three registration points
or the menu silently vanishes for non-admins: `MENU_ROUTES` (`server.py:2444`), `NAV_ITEMS`
(`static/app.js:464`), and the `<nav>` block in `static/app.html`.

1. **Verdict header** — the date is the headline, not the colour. Group verdict plus five
   entity chips, each with its own verdict.
2. **The annual cash line** — 52 weeks, cash plotted against the buffer band, **and a zero
   line**, because requirement 1 names both. Bound solid, Base dashed, Optimistic dotted.
   Toggle: consolidated ⇄ per entity (small multiples).
3. **CFO / CFI / CFF** monthly bars + the five quality flags from `ORACLE.md` §7.
4. **Top contributors** — the 5 outflows in the 14 days before the worst point.
5. **The remedy** — plain sentences, *Apply to draft*.
6. **Sensitivity** (§8) — tornado + the two-way grid.
7. **Assumptions**, auto-expanded on `KRITIS` or `TOLAK`.

### 7.3 `#/investments` — commitment schedule

Per investment: a week-grain schedule editor, and a standing readout of
`committed − scheduled − already_out`. When that number is non-zero the Investment Center says
so in the same words the Oracle uses, so the two screens never disagree.

### 7.4 Keeping `cash_budget` honest

`cash_budget` currently feeds the weekly cash-flow report's budget line and is hand-maintained.
Two hand-maintained cash plans will diverge within a month. **Make `cash_budget` a derived
projection**: approving a version publishes its `plan_weeks` into `cash_budget` (mapping the
month×week buckets to 1..52 via dates). The existing report keeps working, unchanged, and there
is one source of truth.

---

## 8. Sensitivity analysis (requirement 4)

The verdict answers *are we safe*. Sensitivity answers *how wrong can we be before we are not* —
which is the number management actually needs.

### 8.1 One-way — the tornado

Each axis varied independently, everything else at plan. Report min headroom, first breach
week, weeks below floor, and the verdict at each level.

| Axis | Levels | Why it matters here |
|---|---|---|
| Collection lag | +0 / +15 / +30 / +45 days | 60-day-plus collections are the group's known weak point |
| Revenue realisation | 100 / 90 / 80 / 70% of planned cash in | The budget is a target, not a contract |
| Expense overrun | 0 / +5 / +10 / +20% on planned cash out | Construction overruns are the norm, not the exception |
| Investment timing | as scheduled / pulled forward one quarter / unscheduled all in H1 | §4.3 — the undated commitment risk, made visible |
| Pipeline conversion | ×0 / ×0.5 / ×1 on speculative | Bound already assumes ×0; this prices the gap to Base |
| Opening cash | ±5% | Reconciliation error, and a check on the `1170` fix |

Sorted by swing in min headroom — the widest bar is the thing to manage. That ordering *is*
the management recommendation; it does not need a paragraph next to it.

### 8.2 Break-even — the single most useful number

Bisection on each axis until the verdict crosses, reported in plain language:

> *Cash collection can fall to **87%** of plan before the group breaches its buffer, and to
> **79%** before it goes below zero. Expense can overrun by **11%** before the buffer breaks.*

Two break-evens per axis, because requirement 1 named two failures.

### 8.3 Two-way grid — what management reads

Revenue realisation (rows) × expense overrun (columns), 5 × 5, each cell coloured by verdict.
One picture showing the safe region and how close plan sits to its edge. If plan sits one cell
from red, that is the finding, and no amount of narrative improves on seeing it.

### 8.4 Honesty rules

- Sensitivity always runs on **Bound**, same as the verdict. Running it on Base would report a
  safety margin that depends on money nobody has promised.
- Every axis states what it did **not** vary. A one-way tornado hides correlation: revenue
  falling and collection slowing usually happen together, and the grid in §8.3 is the only
  place that shows up.
- Where an axis has no data to vary (no `speculative` rows at all), report *not applicable*,
  never a flat zero bar — a zero bar reads as "no risk here".

---

## 9. API

```
GET|POST   /api/plan/versions
POST       /api/plan/versions/<vid>/status          draft→submitted→approved→locked
POST       /api/plan/versions/<vid>/copy            new draft from any version
GET|POST   /api/plan/weeks?version_id=&company_id=&year=&month=
POST       /api/plan/weeks/seed-from-budget/<vid>   spread month budgets into weeks
POST       /api/plan/publish-cash-budget/<vid>      §7.4, approved versions only

GET|POST   /api/investments/<iid>/commitments
DELETE     /api/investments/commitments/<cid>

POST       /api/oracle/consult                      {version_id} -> group + 5 entity verdicts
GET        /api/oracle/ledger?version_id=&run=&scope=group|<cid>&grain=week|day
GET        /api/oracle/sensitivity?version_id=      one-way + break-even + two-way grid
GET        /api/oracle/activities?year=
GET|POST   /api/oracle/buffer-policy
GET|POST   /api/oracle/gate-mode
POST       /api/commitments/apply-remedy            draft versions only
GET|POST   /api/settings/cash-flow-classes
GET        /api/export/pdf/oracle
GET        /api/export/xlsx/oracle-sensitivity
```

House rules that are easy to forget and expensive to miss: `@role_required("admin","finance")`
on every write; `check_company_access(company_id)` on **every** endpoint taking a company;
`project_in_company()` before any project-keyed write; `raise ValueError("…")` for a 400.

`consult` and `sensitivity` are **read-only computations**. They must not write `plan_weeks` or
`commitment_items`. Only `seed-from-budget`, `publish-cash-budget` and `apply-remedy` write, and
only into a draft.

---

## 10. Build order

| Step | What | Days | Depends on |
|---|---|---|---|
| **0** | Fix the cash definition — `1170`, unify `cash_account_codes()`, add `2400`/`3300` | 1–2 | — |
| **1** | `cash_flow_class` column + seed + settings override | 1 | 0 |
| **2** | `plan_versions` + `plan_weeks` + NULL-safe upsert + `check_version_writable()` | 3–4 | — |
| **3** | Weekly Cash Plan screen + seed-from-budget | 4–5 | 2 |
| **4** | `investment_commitments` + unscheduled-remainder rule + Investment Center panel | 3–4 | 2 |
| **5** | `fpa_cash.py` — materialise, daily ledger, floors, verdict, consolidate | 4–5 | 1,2,4 |
| **6** | Remedy engine | 2–3 | 5 |
| **7** | `#/oracle` screen — rows 1–5, 7 | 4–5 | 5,6 |
| **8** | Sensitivity module + tornado + two-way grid | 3–4 | 5 |
| **9** | `cash_activities()` + the five quality flags | 2–3 | 1 |
| **10** | Gate (advisory), PDF memo, XLSX export | 2 | 7 |

**Total 29–37 dev-days**, one developer. The `ORACLE.md` route through Phase 0 + Phase 3 +
Phase O was 30–43 days *before* week-grain budgeting, investment scheduling or sensitivity
existed. Dropping Phase 3 is what pays for the three new pieces.

**Shortest path to an answer:** steps 0 → 1 → 2 → 3 → 5 gives a real verdict on a real weekly
plan in 13–17 days, without remedy, sensitivity or the investment schedule. Everything after
that makes the verdict more useful, not more correct.

---

## 11. Tests — `tests/test_fpa_oracle.py`

Carried over from `phase-oracle.md`, still required: **O1** `1170` not in the cash set ·
**O2** dashboard cash == cash-flow closing balance · **O3** `6500`/`1510` contribute 0 to CFO ·
**O4** CFO + CFI + CFF == net cash movement (**the identity check**) · **O5** Bound counts no
`speculative` inflow · **O6** worst headroom exactly 0 → `WASPADA` not `TOLAK` ·
**O7** remedy never shifts `committed` or `deferrable=0` · **O8** `consult` writes nothing ·
**O9** write to approved/locked → 409 · **O10** re-running a materialiser does not double ·
**O11** one entity below its floor breaches with `cash_pooling: false` even when the group
total is fine · **O12** unclassified accounts counted, not dropped.

New for this plan:

- **W1** `week_dates(2027, 2, 5)` returns `None` — February 2027 has 28 days. No amount can be
  stored in an empty bucket.
- **W2** `week_dates(2028, 2, 5)` returns 29 Feb only.
- **W3** Settlement is pessimistic: an `out` row in W2 November lands on 8 Nov; an `in` row in
  W2 November lands on 14 Nov.
- **W4** A `plan_weeks` row with `project_id IS NULL` upserts in place and does not duplicate
  on a second write — the SQLite NULL-uniqueness trap.
- **I1** `unscheduled = committed_amount − scheduled − already_out`, never negative.
- **I2** An investment with `committed_amount > 0` and no schedule still moves cash in the
  ledger, and raises the unscheduled warning.
- **I3** Fully scheduling an investment removes the spread rows entirely — no double count.
- **C1** Group verdict with `cash_pooling: false` equals the **worst** entity verdict, not the
  verdict on the summed line.
- **C2** With `cash_pooling: true`, the same data can pass where C1 fails — and the difference
  is stated in the response, not silent.
- **S1** Sensitivity runs on Bound: changing only `speculative` amounts moves no one-way bar.
- **S2** Break-even bisection converges to within 1% and brackets the verdict change.
- **S3** `sensitivity` writes nothing — row counts unchanged before and after.

Plus the standing no-regression check: `budget-vs-actual`, `pnl`, `balance-sheet` and
`projects/performance` return identical numbers on a freshly seeded `TEST-SERVER`.

---

## 12. Risks worth naming before starting

1. **Cash-basis data entry** (§3.2). The failure is silent and it invalidates everything.
   Worth a training note and a reconciliation check in month one, not just good labels.
2. **`cash_pooling` is still unanswered** (§5.3). Defaulted to `false`. It changes the verdict.
3. **The unscheduled investment remainder** (§4.3). Even spreading is a guess. It is visible
   and it is a sensitivity axis, but the real fix is scheduling the commitments.
4. **Two plan stores.** `budgets` (accrual, month) and `plan_weeks` (cash, week) both exist
   after this. They answer different questions and both are needed — but somebody will ask why
   the budget says one thing and the cash plan another. The answer is *accrual versus cash*,
   and it should be written on both screens.
5. **Sensitivity invites false precision.** A tornado chart looks authoritative. §8.4 exists to
   keep it honest; do not drop those rules to make the screen tidier.

---

## 13. Still the user's decisions, not the build's

1. **`1170 CC BCA VISA CARD`** — reclassify to `2xxx`, or keep and exclude explicitly?
   Reclassifying moves historical balances.
2. **Cash pooling** — does the group actually sweep cash between MDA, SBR, MLT, KMA and MRS?
3. **`absolute_floor` per entity** — the smallest cash balance each may hold before you act.
   Currently 0 for all five, which is deliberately wrong.
4. **`months_cover`** — 2.0 is conventional; with 60-day-plus collections, 2.5–3.0 is arguably
   right.
5. **Interest classification** — CFO (default) or CFF. Pick once; changing it later breaks
   comparability with prior consults.
6. **Gate mode and who may override.** Ship advisory. If whoever overrides a `TOLAK` also owns
   the budget, the gate is decorative.
7. **New: who owns the weekly plan?** Month-grain budgets were a finance exercise. Week-grain
   cash planning across five entities is roughly five times the data entry, and it only stays
   current if project managers keep it current. If it lands on one person in finance, it will
   be stale by March and the Oracle will be confidently wrong.

*Written 23 August 2026 against `apps/erp` at `e046ebc`. Line numbers were measured; verify
before editing.*
