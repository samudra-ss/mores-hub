# MORES HV — FP&A Framework Specification

**Target codebase:** `apps/erp` (MORES HV — Helicopter View), Flask + SQLite + vanilla-JS SPA
**Scope:** add Forecasting, Variance Analysis, and Scenario Modeling to the existing finance core
**Author:** advisory draft, 20 Aug 2026
**Status:** specification only — no code written

---

## 0. The verdict, before the feature list

**[certain] You asked for three modules. You actually need one schema change plus three modules. If you build the modules on today's schema, you will ship three disconnected grids that quietly destroy your own baseline.**

Here is the problem, from your own code:

```sql
CREATE TABLE budgets (
    ...
    UNIQUE (company_id, account_id, project_id, year, month)
);
```

`apps/erp/excel_io.py:503 upsert_budget()` does `UPDATE ... amount=?` in place. There is exactly **one number per company × account × project × year × month**, and saving overwrites it with no history.

Consequences, all of them fatal to FP&A:

1. **[certain] There is no "original budget".** The moment Finance edits a cell in `pageBudgets`, the number you approved in January is gone. Variance vs Budget becomes variance vs *whatever Finance last typed*, which is not a control — it is a mirror.
2. **[certain] A forecast has nowhere to live.** A forecast is the same shape as a budget (account × month). Without a version key, storing one means either overwriting the budget or inventing a parallel table that no report knows about.
3. **[certain] A scenario has nowhere to live either**, and worse — scenarios are not one alternative, they are *N* alternatives you keep side by side.
4. **[likely] Your variance is already half-built and you didn't notice.** `reports.py:451 budget_vs_actual()` and `:554 project_budget_vs_actual()` already return `variance` and `used_pct`. What is missing is not the subtraction. It is *sign convention, materiality, attribution, and commentary* — and the sign logic currently lives in the frontend (`app.js:~945`: `const good = lbl === "COGS" ? v <= 0 : v >= 0;`), not in the reports layer, so every new screen will re-implement it and one of them will get it backwards.

**[certain] Second uncomfortable point, specific to consulting:** your P&L is people × rate × utilization, but your data model has no people, no rates, and no hours. `5100-01 Direct Labor / Consultant Fees` is a lump sum. Without a driver layer, a "forecast module" is just a second budget grid — someone types numbers into cells and calls it a projection. That is not FP&A, that is optimism with a schema.

**[certain] Third:** you have no pipeline and no backlog. For a consulting group, the single most important forward-looking number is **coverage** — signed backlog plus weighted pipeline divided by the revenue you still have to book this year. You cannot compute it today. It is a bigger decision-changer than all three requested modules combined.

So the build order below is deliberately **not** the order you listed.

---

## 1. The FP&A operating model (what the software has to serve)

Software without a cadence is a spreadsheet with extra steps. Fix the cycle first; the app enforces it.

| # | Step | Owner | Timing | System artefact |
|---|---|---|---|---|
| 1 | **Annual Budget** — bottom-up per project, top-down check per company | Finance + PM | Nov–Dec | `plan_version` kind=`budget`, status→`locked` |
| 2 | **Month-end close** | Accountant | WD+5 | journal entries `posted`, period locked |
| 3 | **Variance pack** — Actual vs Budget vs Prior Forecast | Finance | WD+7 | variance report + mandatory commentary on material lines |
| 4 | **Rolling re-forecast** — closed months = actual, open months = re-driven | Finance + PM | monthly (WD+9) | `plan_version` kind=`forecast`, `as_of_month=M`, `is_current=1` |
| 5 | **Scenario review** — what if we lose PRJ-X / hire 5 / client pays 90 days late | CEO + Finance | quarterly + ad hoc | `scenario` + assumptions, never overwrites a plan |
| 6 | **Forecast accuracy scoring** | Finance | quarterly | MAPE / bias vs prior locked forecasts |

**Non-negotiable rules the app must enforce:**

- A `locked` version is immutable. Ever. Corrections create a new version.
- Exactly one forecast per company-year carries `is_current=1`. The dashboard reads that one.
- Every material variance requires a written reason with a root-cause code and an owner. No comment → the variance pack does not reach "complete".
- Scenarios never write to `plan_lines` of a budget or forecast. They store *assumptions* and materialise into a cache.

Step 6 is the one people skip. It is also the one that makes the forecast trustworthy within two quarters, because it makes the forecaster accountable in public.

---

## 2. The structural change: versioned plan facts

### 2.1 New tables

```sql
-- WHO/WHAT/WHEN a set of planned numbers belongs to
CREATE TABLE IF NOT EXISTS plan_versions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        INTEGER REFERENCES companies(id),   -- NULL = group-wide
    year              INTEGER NOT NULL,
    code              TEXT NOT NULL,                      -- 'BUD-2026', 'FC-2026-07'
    label             TEXT NOT NULL DEFAULT '',
    kind              TEXT NOT NULL DEFAULT 'budget'
                        CHECK (kind IN ('budget','forecast','scenario')),
    basis_version_id  INTEGER REFERENCES plan_versions(id),
    as_of_month       INTEGER,                            -- months <= this are actualised
    status            TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','locked','archived')),
    is_current        INTEGER NOT NULL DEFAULT 0,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    locked_at         TEXT,
    notes             TEXT NOT NULL DEFAULT '',
    UNIQUE (company_id, year, code)
);

-- the facts themselves — same grain as today's `budgets`, plus version + provenance
CREATE TABLE IF NOT EXISTS plan_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id   INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    project_id   INTEGER REFERENCES projects(id),
    year         INTEGER NOT NULL,
    month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    amount       REAL NOT NULL DEFAULT 0,
    method       TEXT NOT NULL DEFAULT 'manual'
                   CHECK (method IN ('manual','runrate','seasonal','trend_to_budget',
                                     'driver','backlog','override','copy')),
    is_override  INTEGER NOT NULL DEFAULT 0,
    source_note  TEXT NOT NULL DEFAULT '',
    UNIQUE (version_id, company_id, account_id, project_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_plan_lines_lookup
    ON plan_lines(version_id, company_id, year);
CREATE INDEX IF NOT EXISTS idx_plan_lines_project
    ON plan_lines(project_id, year);
CREATE INDEX IF NOT EXISTS idx_plan_versions_current
    ON plan_versions(company_id, year, kind, is_current);
```

Note the `UNIQUE` constraint carries the same SQLite NULL caveat as today's `budgets` — reuse the `upsert_budget()` pattern (`UPDATE ... WHERE project_id IS ?` then conditional `INSERT`) rather than `ON CONFLICT`, exactly as `excel_io.py:503` already does.

### 2.2 Migration — blast radius is 15 SQL sites, 5 of them writes

Measured from the current tree:

| File | Reads | Writes |
|---|---|---|
| `reports.py` | `:457`, `:538`, `:566`, `:639` | — |
| `server.py` | `:692`, `:1020` | `:791`, `:1045` |
| `excel_io.py` | — | `:506`, `:512` (`upsert_budget`) |
| `database.py` | — | `:636`, `:641`, `:784` |
| `migrate_cakun.py` | `:91` | `:83` |

**Recommended path — keep `budgets` readable, move the store:**

1. In `migrate_database(conn)` (`database.py:820`), after the existing `CREATE TABLE IF NOT EXISTS` block:
   - create `plan_versions` + `plan_lines`
   - for each distinct `(company_id, year)` in `budgets`, create version `BUD-<year>` with `kind='budget'`, `status='locked'`, `is_current=0`
   - `INSERT INTO plan_lines SELECT ...` from `budgets` with that `version_id`, `method='copy'`
   - **do not drop `budgets`.** Rename it `budgets_legacy_YYYYMMDD` and create a compatibility view:

```sql
CREATE VIEW IF NOT EXISTS budgets AS
SELECT pl.id, pl.company_id, pl.account_id, pl.project_id,
       pl.year, pl.month, pl.amount
FROM plan_lines pl
JOIN plan_versions pv ON pv.id = pl.version_id
WHERE pv.kind = 'budget' AND pv.status IN ('approved','locked');
```

   Every read site in the table above keeps working untouched. **[likely]** this saves you a full regression pass on `reports.py`, `pdf_export.py`, and every Excel export.

2. Repoint the 5 write sites at `plan_lines` with an explicit `version_id`. `upsert_budget()` gains a `version_id` first argument; `server.py:1045` (`DELETE`) and `:791` (cascade on project delete) take the same key.

3. Add a guard: writing to a version whose `status` is `locked` or `archived` returns HTTP 409. Put it next to `check_company_access()` in `server.py` — call it `check_version_writable(version_id)`.

4. **One casualty:** `migrate_cakun.py:83` does `UPDATE budgets SET account_id=...` — a view is not writable, so that one-off script must be repointed at `plan_lines` or retired. It is a historical C-AKUN remap; **[likely]** retire it.

**Rollback:** the legacy table is still on disk under its dated name; `DROP VIEW budgets; ALTER TABLE budgets_legacy_YYYYMMDD RENAME TO budgets;` restores the previous state exactly.

---

## 3. Layer 1 — the driver model (this is what makes it consulting FP&A)

Without this, forecasting and scenarios are cosmetic. Build it before both.

### 3.1 Tables

```sql
CREATE TABLE IF NOT EXISTS drivers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  INTEGER REFERENCES companies(id),   -- NULL = group default
    project_id  INTEGER REFERENCES projects(id),    -- NULL = company level
    code        TEXT NOT NULL,        -- 'billable_fte','util_pct','avg_rate',...
    label       TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT 'number'
                  CHECK (unit IN ('number','percent','currency','hours','days')),
    kind        TEXT NOT NULL DEFAULT 'input'
                  CHECK (kind IN ('input','derived')),
    formula     TEXT NOT NULL DEFAULT '',   -- for kind='derived', see §3.3
    is_active   INTEGER NOT NULL DEFAULT 1,
    UNIQUE (company_id, project_id, code)
);

CREATE TABLE IF NOT EXISTS driver_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id   INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    version_id  INTEGER REFERENCES plan_versions(id) ON DELETE CASCADE, -- NULL = actual
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    value       REAL NOT NULL DEFAULT 0,
    UNIQUE (driver_id, version_id, year, month)
);

-- how a driver set turns into money on a specific account
CREATE TABLE IF NOT EXISTS driver_mappings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER NOT NULL REFERENCES companies(id),
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    project_id    INTEGER REFERENCES projects(id),
    expression    TEXT NOT NULL,        -- 'billable_fte * hours_per_fte * util_pct * avg_rate * realization_pct'
    is_active     INTEGER NOT NULL DEFAULT 1
);
```

### 3.2 The standard driver set (seed these, per company)

**Consulting entities — MDA, MRS**

| code | unit | typical | meaning |
|---|---|---|---|
| `billable_fte` | number | 12 | consultants who can be charged out |
| `hours_per_fte` | hours | 160 | available hours/month |
| `util_pct` | percent | 0.68 | billable ÷ available |
| `avg_rate` | currency | 750 000 | IDR per billable hour |
| `realization_pct` | percent | 0.92 | invoiced ÷ standard value (write-offs, discounts) |
| `collection_days` | days | 62 | DSO — cash timing only |
| `loaded_cost_fte` | currency | 22 000 000 | fully loaded cost per FTE/month |
| `bench_fte` | number | 2 | non-billable, still paid |
| `attrition_pct` | percent | 0.015 | monthly leavers |

**Construction — MLT:** `contract_value`, `poc_pct`, `cost_to_date`, `etc_cost`, `retention_pct`, `progress_billing_lag_days`

**Media — SBR, KMA:** `active_contracts`, `avg_contract_value`, `renewal_pct`, `production_cost_ratio`

### 3.3 Core formulas

```
Revenue_m       = billable_fte_m × hours_per_fte × util_pct_m × avg_rate_m × realization_pct_m
Direct_cost_m   = (billable_fte_m + bench_fte_m) × loaded_cost_fte_m
Gross_margin_m  = Revenue_m − Direct_cost_m
GM%_m           = 1 − loaded_cost_fte / (hours_per_fte × util_pct × avg_rate × realization_pct)

Breakeven utilization
util_be         = loaded_cost_fte / (hours_per_fte × avg_rate × realization_pct)

Revenue per FTE (the one number a consulting CEO should watch monthly)
rev_per_fte_m   = Revenue_m / (billable_fte_m + bench_fte_m)
```

Post the formula as `drivers.formula` for `kind='derived'` and evaluate it in a whitelisted evaluator — **[certain] do not use Python `eval()`**. Tokenise to driver codes + `+ - * / ( )` + numeric literals, reject everything else. ~60 lines in a new `fpa_calc.py`.

### 3.4 Backfill actual drivers from the ledger

So that variance-on-drivers works from day one, derive actual drivers where you can:

```
actual avg_rate_m   = Revenue_m(actual, acct 41xx) / billable_hours_m   -- needs hours; see §3.5
actual loaded_cost  = (acct 5100-01 + 5100-02 + 6100) / headcount_m
actual util_pct     = billable_hours_m / (headcount_m × hours_per_fte)
```

### 3.5 The one input you do not have — hours

**[certain] You cannot compute rate or utilization variance without billable hours.** Cheapest fix that avoids building a timesheet system: add two columns to `journal_lines` and let the bank/manual entry flow capture them where relevant.

```sql
-- additive, idempotent, via database._add_column()
_add_column(conn, "journal_lines", "quantity", "REAL NOT NULL DEFAULT 0")
_add_column(conn, "journal_lines", "uom",      "TEXT NOT NULL DEFAULT ''")   -- 'hour','day','unit'
```

Revenue and direct-labour lines then carry hours alongside rupiah, and price/volume decomposition (§5.4) becomes real arithmetic instead of a plug. **[guessing]** if your PMs will not fill this in, fall back to a monthly `project_hours` table maintained by each PM — one number per project per month. Worse, but survivable.

---

## 4. Layer 2 — Forecasting

### 4.1 Definition

A forecast version for company C, year Y, cut at month M is:

```
FC_line(a, p, m) =  Actual(a, p, m)                   for m ≤ M   (closed months, frozen)
                    forecast_method(a, p, m)          for m > M   (open months)

FY_LE(a, p)     =  Σ_{m=1..M} Actual + Σ_{m=M+1..12} FC          (Latest Estimate)
```

`as_of_month` on `plan_versions` is what makes this unambiguous. Actualising closed months is what makes the LE comparable to Budget on the same axis.

### 4.2 Methods (`plan_lines.method`)

| method | formula | when to default to it |
|---|---|---|
| `runrate` | `FC_m = mean(Actual_{M-2..M})` | opex, stable overhead |
| `seasonal` | `FC_m = Actual_{m, Y-1} × (1 + g)`, `g = YTD_Y / YTD_{Y-1} − 1` | revenue with a seasonal shape and ≥ 18 months of history — you have 17 months seeded, so this is borderline in year 1 |
| `trend_to_budget` | `FC_m = Budget_m × (YTD Actual ÷ YTD Budget)` | when the budget shape is trusted and only the level is off |
| `driver` | evaluate `driver_mappings.expression` on forecast driver values | **all revenue and direct cost** |
| `backlog` | contracted backlog run-off + weighted pipeline (§4.4) | consulting revenue, preferred over `driver` for the next 2 quarters |
| `override` | manual number, `is_override=1`, `source_note` required | anything a human insists on |

Store the method **per line**, not per version. Mixed-method forecasts are normal and correct. Every `override` must carry a note — enforce at the API layer, not the UI.

### 4.3 Generating a forecast (the `POST /api/plan/versions/{id}/generate` job)

```
1. lock inputs: company, year, as_of_month M, default method per account type
2. actualise months 1..M from posted journal entries (same query as reports.budget_vs_actual)
3. for months M+1..12:
     a. revenue accounts (4xxx)      -> backlog method, falling back to driver
     b. COGS (5xxx)                  -> driver (loaded cost × FTE), or % of revenue where no driver
     c. opex (6xxx)                  -> runrate, except 6500 depreciation = schedule, 6100 = headcount plan
     d. interest (7200)              -> loan schedule (manual for now)
4. preserve any existing is_override=1 line — never overwrite a human decision
5. recompute derived driver values for the same months
6. write plan_lines, set status='draft'
```

Generation is **idempotent and re-runnable** while `status='draft'`. Once `approved`, regenerating creates a new version instead.

### 4.4 Backlog and pipeline — the missing forward-revenue engine

```sql
CREATE TABLE IF NOT EXISTS contracts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id     INTEGER NOT NULL REFERENCES companies(id),
    project_id     INTEGER REFERENCES projects(id),
    client         TEXT NOT NULL DEFAULT '',
    contract_no    TEXT NOT NULL DEFAULT '',
    signed_date    TEXT,
    start_date     TEXT,
    end_date       TEXT,
    value          REAL NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'IDR',
    recognition    TEXT NOT NULL DEFAULT 'straight'
                     CHECK (recognition IN ('straight','poc','milestone')),
    status         TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','cancelled')),
    notes          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pipeline (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        INTEGER NOT NULL REFERENCES companies(id),
    project_id        INTEGER REFERENCES projects(id),   -- if it converts
    name              TEXT NOT NULL,
    client            TEXT NOT NULL DEFAULT '',
    stage             TEXT NOT NULL DEFAULT 'lead'
                        CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
    probability_pct   REAL NOT NULL DEFAULT 0,     -- 0..1, defaulted per stage
    value             REAL NOT NULL DEFAULT 0,
    expected_start    TEXT,
    duration_months   INTEGER NOT NULL DEFAULT 6,
    owner             TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Default stage probabilities (editable in Settings): lead 10%, qualified 25%, proposal 50%, negotiation 75%, won 100%, lost 0%.

```
Backlog(as of D)      = Σ contracts.value − Σ revenue recognised to date on those contracts
Weighted pipeline     = Σ pipeline.value × probability_pct   (open stages only)
Forecast revenue_m    = Σ backlog run-off in m + Σ weighted pipeline spread over duration from expected_start

Coverage ratio  =  (Backlog + Weighted pipeline) ÷ (FY revenue plan − YTD actual revenue)
```

**[certain] Coverage is the headline KPI for a consulting group.** Put it on the dashboard as a gauge:

| Coverage | Verdict | Meaning |
|---|---|---|
| ≥ 1.20 | Healthy | plan is covered with room |
| 0.90 – 1.20 | Watch | plan achievable only if you win most of the pipeline |
| < 0.90 | At risk | the plan is arithmetically out of reach — cut cost or sell, now |

### 4.5 Forecast accuracy

Every time a forecast is locked, it becomes a scoring candidate.

```
Error_m   = Actual_m − FC_m
APE_m     = |Error_m| / max(|Actual_m|, ε)
MAPE      = mean(APE over scored months)
Bias      = mean(Error_m) / mean(Actual_m)          -- persistent sign = systematic optimism
Hit rate  = share of months where |Error| ≤ 10% of Actual
```

Score at lags 1, 3, and 6 months. Show per company and per forecaster. **[likely]** publishing bias internally cuts sandbagging faster than any policy.

---

## 5. Layer 3 — Variance analysis

### 5.1 What already exists

`reports.budget_vs_actual()` and `reports.project_budget_vs_actual()` return `variance = actual − budget` and `used_pct`. Keep both. Everything below extends them.

### 5.2 Fix the sign convention — in the reports layer, once

```python
# reports.py, next to the existing SIGN dict
SIGN_FAV = {"revenue": 1.0, "expense": -1.0, "asset": 1.0,
            "liability": -1.0, "equity": 1.0}

def favourable(acct_type, actual, plan):
    """Signed variance where positive is ALWAYS good for the business."""
    return SIGN_FAV[acct_type] * (actual - plan)
```

Return both `variance` (raw, actual − plan, unchanged for backward compatibility) and `variance_fav` + `is_favourable` on every variance row. Then delete the ad-hoc `good = lbl === "COGS" ? v <= 0 : v >= 0` in `app.js` and read the flag from the API. One source of truth.

### 5.3 Three comparison axes, one report

| Axis | Question it answers | Comparison |
|---|---|---|
| **A vs B** | Are we hitting the plan we committed to? | Actual vs `kind='budget'`, `status='locked'` |
| **A vs F** | Can Finance forecast? | Actual vs prior locked forecast |
| **A vs PY** | Are we actually growing? | Actual vs same period last year |

The API takes `?base=budget|forecast|prior_year&base_version_id=...`. Same response shape for all three — the UI is one component with a selector.

### 5.4 Decomposition — the part that turns numbers into a conversation

**Revenue (requires hours from §3.5):**

```
Total variance   = (H_a × R_a) − (H_b × R_b)

Volume variance  = (H_a − H_b) × R_b            -- did we sell more hours?
Rate variance    = (R_a − R_b) × H_a            -- did we charge more per hour?
Mix variance     = Σ_i (H_a,i − H_a × w_b,i) × (R_b,i − R_b,avg)

Identity check: Volume + Rate + Mix = Total. Assert it in tests; a residual means a bug.
```

**Direct labour:**

```
Rate variance        = (cost_per_hour_a − cost_per_hour_std) × hours_a
Efficiency variance  = (hours_a − hours_std_for_output) × cost_per_hour_std
```

**Opex without a driver:** report as a single `spend` variance and require commentary. Do not fake a decomposition you cannot evidence.

**Project-level bridge (Budget profit → Actual profit):**

```
Budget profit
  + revenue volume
  + revenue rate
  + revenue mix
  − direct cost rate
  − direct cost efficiency
  − opex spend
  ± timing (revenue booked in a different month)
= Actual profit
```

Render as a waterfall. This single chart is what a board meeting actually needs.

### 5.5 Materiality and commentary

```sql
CREATE TABLE IF NOT EXISTS variance_rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER REFERENCES companies(id),   -- NULL = group default
    account_type  TEXT,                               -- NULL = all
    account_code  TEXT,                               -- NULL = all in type
    abs_threshold REAL NOT NULL DEFAULT 25000000,     -- IDR 25 juta
    pct_threshold REAL NOT NULL DEFAULT 0.10,         -- 10%
    is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS variance_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    account_id   INTEGER REFERENCES accounts(id),
    project_id   INTEGER REFERENCES projects(id),
    year         INTEGER NOT NULL,
    month        INTEGER,                             -- NULL = full year
    base_kind    TEXT NOT NULL DEFAULT 'budget',
    variance_amt REAL NOT NULL DEFAULT 0,
    root_cause   TEXT NOT NULL DEFAULT 'other'
                   CHECK (root_cause IN ('volume','price','mix','timing','scope_change',
                                         'cost_overrun','fx','one_off','error','other')),
    commentary   TEXT NOT NULL DEFAULT '',
    action       TEXT NOT NULL DEFAULT '',
    owner        TEXT NOT NULL DEFAULT '',
    due_date     TEXT,
    status       TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','closed')),
    created_by   INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, account_id, project_id, year, month, base_kind)
);
```

```
material  ⟺  |variance| ≥ abs_threshold  OR  |variance| ≥ pct_threshold × |plan|
```

Both, not either-or, and OR between them — a 40% miss on a small account still deserves a sentence; so does a 3% miss on a billion-rupiah line.

**Completion gate:** `variance_pack_complete = (# material lines with a non-empty commentary) / (# material lines)`. Show it as a percentage on the report header. Finance closes the month when it reads 100%.

### 5.6 Project EAC — the consulting killer feature

Variance on a project that is 60% done tells you where you *were*. EAC tells you where you will *land*. For a project business this is the whole game.

```
BAC   = budgeted cost at completion         (Σ plan_lines expense for the project)
ACWP  = actual cost of work performed       (Σ posted expense to date)
POC   = ACWP / EAC_cost                     (cost-based percent complete)
BCWP  = POC_physical × BAC                  (earned value; POC_physical from the PM, 0..1)
CPI   = BCWP / ACWP                         (< 1.0 = burning faster than earning)
EAC   = ACWP + (BAC − BCWP) / CPI           (independent estimate at completion)
ETC   = EAC − ACWP                          (estimate to complete)
VAC   = BAC − EAC                           (variance at completion; negative = overrun)

Margin at completion   = contract_value − EAC
Margin erosion         = budget_margin% − margin_at_completion%
```

Alert when `margin_erosion > 5pp` **or** `CPI < 0.90`. Surface as a red row on Project HV. Add `poc_physical` as a monthly PM input (one number per project per month — put it in `driver_values` as driver code `poc_physical`).

---

## 6. Layer 4 — Scenario modeling

### 6.1 Principle

**[certain] A scenario is a list of assumptions applied to a base version, not a copy of the numbers.** Copies rot the moment the base is re-forecast, and you end up comparing a March scenario to a July forecast without noticing.

```sql
CREATE TABLE IF NOT EXISTS scenarios (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id       INTEGER REFERENCES companies(id),   -- NULL = group
    year             INTEGER NOT NULL,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'custom'
                       CHECK (kind IN ('base','best','worst','custom','stress')),
    base_version_id  INTEGER NOT NULL REFERENCES plan_versions(id),
    description      TEXT NOT NULL DEFAULT '',
    probability_pct  REAL NOT NULL DEFAULT 0,   -- for expected-value roll-up
    created_by       INTEGER REFERENCES users(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, year, name)
);

CREATE TABLE IF NOT EXISTS scenario_assumptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL DEFAULT 0,     -- applied in order
    target_type  TEXT NOT NULL
                   CHECK (target_type IN ('driver','account','project','pipeline',
                                          'headcount','collection','contract')),
    target_id    INTEGER,                        -- driver_id / account_id / project_id / pipeline_id
    op           TEXT NOT NULL
                   CHECK (op IN ('pct','abs','set','shift_months','toggle')),
    value        REAL NOT NULL DEFAULT 0,
    from_month   INTEGER NOT NULL DEFAULT 1 CHECK (from_month BETWEEN 1 AND 12),
    to_month     INTEGER NOT NULL DEFAULT 12 CHECK (to_month BETWEEN 1 AND 12),
    label        TEXT NOT NULL DEFAULT ''
);

-- materialised results, invalidated by an input hash
CREATE TABLE IF NOT EXISTS scenario_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    input_hash   TEXT NOT NULL DEFAULT '',
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    project_id   INTEGER REFERENCES projects(id),
    year         INTEGER NOT NULL,
    month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    amount       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scen_results
    ON scenario_results(scenario_id, input_hash, year);
```

`input_hash` = SHA-256 of `(base_version_id, base_version.locked_at, sorted assumption rows, driver_values digest)`. Recompute only when it changes. A group-wide scenario over 5 companies × 40 accounts × 12 months is 2 400 rows — **[likely]** sub-200ms in SQLite, so caching is a nicety, not a necessity, but the hash also gives you "this scenario is stale" detection, which is the real value.

### 6.2 Assumption catalogue (build these seven; they cover ~90% of real questions)

| Business question | target_type | op | example |
|---|---|---|---|
| "What if utilization drops to 60%?" | `driver` (`util_pct`) | `set` | 0.60, months 7–12 |
| "What if we raise rates 8% in Q4?" | `driver` (`avg_rate`) | `pct` | +0.08, months 10–12 |
| "What if we hire 5 consultants in September?" | `headcount` | `abs` | +5 FTE from month 9, cost auto-derived from `loaded_cost_fte` |
| "What if we lose PRJ-PRISMA?" | `project` | `toggle` | off, months 8–12 |
| "What if CDA slips one quarter?" | `project` | `shift_months` | +3 |
| "What if the client pays in 90 days not 60?" | `collection` | `set` | 90 — **cash only, P&L unchanged** |
| "What if only 30% of the pipeline converts?" | `pipeline` | `pct` | probability × 0.30 |

The collection-days one matters more than people expect: for a consulting group, the difference between profitable and insolvent is usually timing, not margin.

### 6.3 Computation order

```
1. resolve base_version -> plan_lines + driver_values
2. apply assumptions in `seq` order to DRIVERS first (they cascade)
3. re-evaluate driver_mappings -> revenue and direct cost
4. apply account-level assumptions (they override step 3 for their target)
5. apply project toggles/shifts (zero or slide both revenue and cost lines)
6. recompute P&L, then the balance-sheet and cash bridge (§6.4)
7. write scenario_results with input_hash
```

Assumption order is user-visible and drag-reorderable. Two assumptions on the same target apply in sequence — document that, or someone will file a bug.

### 6.4 Cash bridge (the output people actually act on)

```
Cash_m = Cash_{m-1}
       + Collections_m
       − Disbursements_m
       − Tax_m − CapEx_m − Debt_service_m

Collections_m     = Σ_k Revenue_k × collection_curve(m − k)
collection_curve  = distribution derived from collection_days
                    (default: 20% in month of invoice, 55% +1, 20% +2, 5% +3)
Disbursements_m   = payroll_m (same month) + vendor_m (lagged by DPO)

Min cash          = min over months of Cash_m
Runway (months)   = months until Cash_m < minimum_operating_cash
```

Feed the existing `cash_budget` weekly table from the scenario output so `reports.weekly_cash_flow()` (`reports.py:920`) shows scenario-vs-actual with zero new plumbing. **[likely]** this is the highest-leverage reuse available in the whole spec.

### 6.5 Sensitivity

- **Tornado:** flex each driver ±10% independently, sort by absolute effect on FY profit. Answers "which lever actually matters" — usually rate and utilization, and usually not the one management is arguing about.
- **Two-way grid:** the top two drivers, 5×5, cells coloured by FY profit or min-cash.
- **Expected value:** `Σ (scenario FY profit × probability_pct)` where probabilities sum to 1. Warn if they don't.

---

## 7. Schema summary — 11 new tables, 2 new columns

| Object | Purpose | Layer |
|---|---|---|
| `plan_versions` | version/scenario registry | Foundation |
| `plan_lines` | versioned plan facts (replaces `budgets` as store) | Foundation |
| `budgets` (VIEW) | backward compatibility for 10 read sites | Foundation |
| `drivers` | driver definitions per company/project | Driver |
| `driver_values` | monthly values, actual + per version | Driver |
| `driver_mappings` | driver expression → account | Driver |
| `contracts` | signed backlog | Forecast |
| `pipeline` | weighted opportunities | Forecast |
| `variance_rules` | materiality thresholds | Variance |
| `variance_notes` | commentary, root cause, owner, action | Variance |
| `scenarios` | scenario header | Scenario |
| `scenario_assumptions` | ordered deltas | Scenario |
| `scenario_results` | hashed cache | Scenario |
| `journal_lines.quantity` | hours/units alongside rupiah | Driver |
| `journal_lines.uom` | unit of measure | Driver |

All of it goes into `database.migrate_database()` as idempotent `CREATE TABLE IF NOT EXISTS` + `_add_column()`, following the pattern already at `database.py:820`.

---

## 8. API surface

Follows the existing `@app.get` / `@role_required("admin","finance")` conventions in `server.py`.

**Plan versions**
```
GET    /api/plan/versions?company_id=&year=&kind=
POST   /api/plan/versions                       create (optionally copy from basis)
PUT    /api/plan/versions/<int:vid>             rename / notes / probability
POST   /api/plan/versions/<int:vid>/status      draft|submitted|approved|locked|archived
POST   /api/plan/versions/<int:vid>/set-current sets is_current, clears siblings
DELETE /api/plan/versions/<int:vid>             blocked if locked
GET    /api/plan/lines?version_id=&company_id=  the grid
PUT    /api/plan/lines                          bulk upsert (409 if version locked)
```

**Drivers**
```
GET    /api/drivers?company_id=&project_id=
POST   /api/drivers
PUT    /api/drivers/<int:did>
DELETE /api/drivers/<int:did>
GET    /api/drivers/values?version_id=&year=&company_id=
PUT    /api/drivers/values                      bulk upsert
GET    /api/drivers/actuals?company_id=&year=   derived from ledger (§3.4)
GET    /api/drivers/mappings?company_id=
PUT    /api/drivers/mappings
```

**Forecast**
```
POST   /api/forecast/generate                   {company_id, year, as_of_month, methods{}}
GET    /api/forecast/current?company_id=&year=  the is_current version + LE
GET    /api/forecast/accuracy?company_id=&year=&lag=  MAPE / bias / hit rate
GET    /api/forecast/coverage?company_id=&year=       backlog + pipeline coverage
```

**Contracts / pipeline**
```
GET|POST /api/contracts        PUT|DELETE /api/contracts/<int:cid>
GET|POST /api/pipeline         PUT|DELETE /api/pipeline/<int:pid>
GET      /api/pipeline/summary?company_id=&year=   weighted by stage
```

**Variance**
```
GET    /api/variance?company_id=&year=&base=budget|forecast|prior_year
        &base_version_id=&month=&project_id=&materiality=1
GET    /api/variance/bridge?company_id=&year=&project_id=     waterfall components
GET    /api/variance/decompose?account_id=&year=&month=       volume/rate/mix
GET|POST /api/variance/notes    PUT /api/variance/notes/<int:nid>
GET    /api/variance/completion?company_id=&year=&month=      the % gate
GET|POST /api/settings/variance-rules
```

**Scenario**
```
GET|POST /api/scenarios        PUT|DELETE /api/scenarios/<int:sid>
GET|POST /api/scenarios/<int:sid>/assumptions
PUT|DELETE /api/scenario-assumptions/<int:aid>
POST   /api/scenarios/<int:sid>/run             recompute, returns P&L + cash
GET    /api/scenarios/<int:sid>/results?view=pnl|cash|bridge
GET    /api/scenarios/compare?ids=1,2,3         side-by-side
GET    /api/scenarios/<int:sid>/sensitivity?mode=tornado|grid&drivers=
```

**Project EAC**
```
GET    /api/projects/<int:pid>/eac?year=
PUT    /api/projects/<int:pid>/poc              {year, month, poc_physical}
```

**Exports** — mirror the existing pattern in `excel_io.py` / `pdf_export.py`:
```
GET /api/export/forecast          GET /api/export/pdf/variance-pack
GET /api/export/variance          GET /api/export/pdf/scenario
GET /api/export/scenario          GET /api/templates/driver-values
```

---

## 9. Screens

Add four routes. Update **both** `MENU_ROUTES` (`server.py:2444`) and `NAV_ITEMS` (`static/app.js:464`) and the `<nav>` block in `static/app.html` — they are kept in sync manually today, and forgetting one silently hides the menu for non-admins.

```python
MENU_ROUTES = {"dashboard", "projecthv", "journals", "bank", "receivables", "payables",
               "budgets", "forecast", "variance", "scenarios", "pipeline",
               "investments", "projects", "reports", "accountant", "settings"}
```

```js
["forecast",  "◈", "Forecast"],
["variance",  "⇅", "Variance Analysis"],
["scenarios", "⟐", "Scenario Lab"],
["pipeline",  "◇", "Pipeline & Backlog"],
```

### 9.1 `#/forecast` — Forecast

- Header: version selector (`BUD-2026` / `FC-2026-07` / …), status pill, `as_of_month` cut marker, **Generate** / **Lock** buttons
- KPI row: FY Latest Estimate · vs Budget · vs Prior Forecast · Coverage ratio · Forecast MAPE (last 3 months)
- Grid: account rows × 12 months. Closed months greyed and labelled *Actual*; open months editable, method chip per cell, overridden cells flagged
- Chart: Actual (solid) → Forecast (dashed) → Budget (grey), with the cut month marked
- Driver panel: FTE / utilization / rate / realization by month, editable, recalculates the grid live
- Tabs: Company level · Per project — mirroring the existing `pageBudgets` two-mode pattern so it feels native

### 9.2 `#/variance` — Variance Analysis

- Selector: base (Budget / Forecast / Prior Year) · period (month / QTD / YTD / FY) · scope (company / project)
- **Waterfall** Budget profit → Actual profit with the §5.4 components
- Table: account · plan · actual · variance · variance% · **F/U pill** · material flag · root cause · commentary · owner · status
- Inline commentary editor on any material row; `variance_pack_complete` percentage in the header, red until 100%
- Drill: account → month → journal entries (reuse `reports.account_ledger()` at `reports.py:273` — it already does this)
- Decomposition drawer: volume / rate / mix bars with the identity check displayed

### 9.3 `#/scenarios` — Scenario Lab

- Left: scenario list with kind badges and probability
- Centre: assumption builder — plain-language rows ("Utilization → 60% from Jul", "Lose PRJ-PRISMA from Aug"), drag to reorder
- Right: live results — FY revenue / profit / margin / min cash / runway, each with delta vs base
- Compare tab: 2–4 scenarios side by side, P&L and cash
- Sensitivity tab: tornado chart + two-way grid
- **Promote to forecast** button: copies the scenario's computed lines into a new `plan_version` of kind `forecast`. This is the only sanctioned path from scenario to plan.

### 9.4 `#/pipeline` — Pipeline & Backlog

- Kanban by stage with values and weighted values
- Backlog table: contract · client · value · recognised to date · remaining · run-off end date
- Coverage gauge against the FY revenue plan, per company and consolidated
- Conversion funnel and win-rate by stage — feeds the default probabilities back

### 9.5 Dashboard additions (`pageDashboard`)

Three tiles, nothing more: **FY Latest Estimate vs Budget**, **Coverage ratio**, **Projects with negative VAC**. Resist adding more; the dashboard is already dense.

---

## 10. Build order

Deliberately not the order you asked for. Sequenced so each phase is independently useful and nothing is built twice.

| Phase | What | Why it comes here | Rough effort |
|---|---|---|---|
| **0** | `plan_versions` + `plan_lines` + `budgets` view + migration + lock enforcement. UI: version selector on the existing Budgets page. | Everything else writes into this. Doing it later means redoing it. | 3–5 days |
| **1** | Variance layer: `SIGN_FAV`, `variance_rules`, `variance_notes`, `/api/variance`, `#/variance` screen with A-vs-B and A-vs-PY. | Cheapest real value — the math is 60% written. Gives Finance something to use while Phase 2 is built. | 5–7 days |
| **2** | Drivers: tables, whitelisted evaluator (`fpa_calc.py`), seed set per entity, `journal_lines.quantity/uom`, actual-driver derivation. | The engine. Forecast and scenarios both sit on it. | 7–10 days |
| **3** | Contracts + pipeline + coverage ratio + backlog run-off. | Standalone value on day one — sales pipeline visibility — and it is the best forecast method you will have. | 5–7 days |
| **4** | Forecasting: methods, `/api/forecast/generate`, `#/forecast`, LE vs Budget, A-vs-F axis lit up in the variance screen. | Needs 0+2+3. | 7–10 days |
| **5** | Project EAC / CPI / VAC on Project HV. | Needs `poc_physical` from Phase 2. Highest per-day payoff of anything in this list for a project business. | 3–4 days |
| **6** | Scenario Lab: scenarios, assumptions, runner, cash bridge, compare. | Needs 0+2+4. | 10–14 days |
| **7** | Sensitivity, forecast accuracy scoring, Excel/PDF exports for all three packs. | Polish that makes it stick. | 5–7 days |

**Total ≈ 45–64 working days for one developer.** **[guessing]** on the estimate — it assumes the same developer who wrote the current `apps/erp` code, working in the same style, no test suite to maintain.

**If you only get 3 weeks:** Phase 0 + Phase 1 + Phase 3. Versioned plans, real variance with commentary, and coverage. That is a defensible FP&A function. Forecasting without drivers is not.

---

## 11. Acceptance tests

Write these as `pytest` against a seeded `TEST-SERVER` database. **[certain]** the identity checks are the ones that catch real bugs.

**Foundation**
1. Migrating a database with N budget rows produces exactly N `plan_lines` under a `BUD-<year>` version, and `SELECT * FROM budgets` (the view) returns identical rows to the pre-migration table.
2. `PUT /api/plan/lines` against a `locked` version returns 409 and changes nothing.
3. `set-current` on a forecast clears `is_current` on every sibling of the same company-year.

**Forecast**
4. A forecast with `as_of_month=6` has months 1–6 equal to posted actuals to the rupiah.
5. Regenerating a draft forecast leaves every `is_override=1` line untouched.
6. `FY_LE = Σ actuals(1..M) + Σ forecast(M+1..12)` for every account.
7. Coverage ratio with zero pipeline and zero backlog returns 0, not a division error.

**Variance**
8. `variance_fav` is positive when revenue beats plan **and** when expense comes in under plan.
9. Volume + Rate + Mix = Total revenue variance, within 0.01 IDR, on a three-project fixture.
10. A material line without commentary keeps `variance_pack_complete` below 100%.
11. Materiality fires on the OR of absolute and percentage thresholds, tested at each boundary.

**Scenario**
12. A scenario with zero assumptions produces results identical to its base version.
13. Two assumptions on the same driver apply in `seq` order (0.9 then 1.1 ≠ 1.1 then 0.9 when one is `set`).
14. Changing `collection_days` moves cash and leaves FY profit unchanged to the rupiah.
15. Toggling a project off zeroes both its revenue and its direct cost, not revenue alone.
16. Editing the base version invalidates `input_hash` and marks cached results stale.

**Consolidation** — regression, since these paths already exist
17. Intercompany accounts (`is_intercompany=1`) are still eliminated in consolidated forecast and scenario output, matching `_consolidated()` behaviour at `reports.py:59`.

---

## 11A. The Oracle (*Ahli Nujum*) — see `ORACLE.md`

A going-concern gate on project budgets, specified separately in `ORACLE.md` and built by
`phase-oracle.md`. It sits on the standard three-activity cash flow framework — **CFO**
operating, **CFI** investing, **CFF** financing — and answers one question at the moment a
budget is submitted: *if we commit this, does the group stay above its cash buffer, and if
not, on what date does it break?*

Three things about it are not covered anywhere above:

- **It needs a grain this spec does not have.** `plan_lines` is month-grain; solvency breaks
  on dates. The Oracle introduces `commitment_items` — per item, per due date, per certainty
  band — and a **daily** cash ledger.
- **It needs a cash-flow classification the COA does not carry.** New column
  `accounts.cash_flow_class`. Without it the three-activity split cannot be computed at all,
  and `reports.cash_flow()` (`:696`) is a bank-movement report, not a cash flow statement.
- **Two live defects block it.** `1170 CC BCA VISA CARD` is classified as an asset under
  `1100 Cash & Bank`, so a credit card counts as cash; and `dashboard()` honours the
  configurable cash-account selection while `cash_flow()` and `weekly_cash_flow()` hardcode
  `code LIKE '11%'`, so the two can already disagree. Both are fixed in Phase O step 0.

It depends only on Phase 0 and Phase 3, and it **owns `fpa_cash.py`** — the daily ledger,
collection curve and buffer policy that §6.4's scenario cash bridge would otherwise
duplicate. Build one of the two first; never both.

## 12. What NOT to build

Scope discipline is the difference between shipping this and shipping 40% of it.

- **A full timesheet system.** Two columns on `journal_lines` plus a monthly PM input gets you 90% of the analytical value at 5% of the cost. Revisit in a year.
- **Monte Carlo simulation.** Discrete named scenarios with probabilities are what a board discusses. A distribution is not.
- **Multi-currency.** Everything is IDR. `currency` columns exist; leave them alone until a real foreign contract lands.
- **Automated ML forecasting.** With 17 months of history and 5 entities you do not have enough data for a model to beat a driver build. It would only launder judgement as objectivity.
- **Rolling 18-month horizon.** Calendar year is fine for now. The version model already supports extending later.
- **A separate approval workflow engine.** The `status` field plus `role_required` covers it.

---

## 13. Open decisions for you

1. **Forecast cadence — monthly or quarterly?** Monthly is proper FP&A but is real work every month. **[likely]** with your current team, quarterly re-forecast plus a monthly *flash* (revenue and cash only) is the realistic starting cadence. Confirm before Phase 4, because it changes how heavy the generate flow needs to be.
2. **Who owns the forecast number?** If it is Finance alone, it will be conservative and PMs will ignore it. If it is PMs alone, it will be optimistic. Recommendation: PM proposes per project, Finance challenges and locks at company level. The `status` workflow (`draft → submitted → approved → locked`) is built for exactly this — but only if you actually give PMs logins.
3. **Materiality thresholds.** IDR 25 juta / 10% is a placeholder scaled off your seeded revenue (~IDR 4.5 bn/month group-wide). Set them per entity before Phase 1 ships, or nobody will trust the flags.
4. **`poc_physical` input.** Someone must judge percent-complete monthly per project, and it must not be the person whose bonus depends on it. Decide who.

---

*Sources: `apps/erp/database.py`, `apps/erp/reports.py`, `apps/erp/server.py`, `apps/erp/excel_io.py`, `apps/erp/static/app.js`, `apps/erp/README.md` — read at commit state of 30 Jul 2026 in `mores-hub-main`.*
