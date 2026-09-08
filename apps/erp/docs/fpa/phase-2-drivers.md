# Phase 2 — Driver engine

**Depends on:** Phase 0 · **Estimate:** 7–10 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §3

## GOAL

Give the plan a causal layer: revenue and direct cost computed from people, rates and
utilization instead of typed into cells. This is what separates a forecast from a second
budget.

**Must not break:** `journal_lines` gains two columns; every existing query that does
`SELECT *` or inserts positionally must still work. Check before you add.

## DDL

```sql
CREATE TABLE IF NOT EXISTS drivers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  INTEGER REFERENCES companies(id),
    project_id  INTEGER REFERENCES projects(id),
    code        TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT 'number'
                  CHECK (unit IN ('number','percent','currency','hours','days')),
    kind        TEXT NOT NULL DEFAULT 'input' CHECK (kind IN ('input','derived')),
    formula     TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    UNIQUE (company_id, project_id, code)
);

CREATE TABLE IF NOT EXISTS driver_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id   INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    version_id  INTEGER REFERENCES plan_versions(id) ON DELETE CASCADE,
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    value       REAL NOT NULL DEFAULT 0,
    UNIQUE (driver_id, version_id, year, month)
);

CREATE TABLE IF NOT EXISTS driver_mappings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  INTEGER NOT NULL REFERENCES companies(id),
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    project_id  INTEGER REFERENCES projects(id),
    expression  TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_driver_values ON driver_values(driver_id, version_id, year);
```

Columns, via the existing helper:

```python
_add_column(conn, "journal_lines", "quantity", "REAL NOT NULL DEFAULT 0")
_add_column(conn, "journal_lines", "uom",      "TEXT NOT NULL DEFAULT ''")   # 'hour','day','unit'
```

`version_id IS NULL` on `driver_values` means **actual**. Same nullable-UNIQUE caveat —
use UPDATE-then-INSERT with `version_id IS ?`.

## THE EVALUATOR — `fpa_calc.py`

**Do not use Python `eval()`.** Write a small tokeniser + shunting-yard evaluator, roughly
60 lines:

- Accept: driver codes matching `[a-z_][a-z0-9_]*`, numeric literals, `+ - * / ( )`.
- Reject everything else — attribute access, calls, comparisons, names not in the driver
  map. Raise `ValueError` on any rejected token.
- Division by zero returns `0.0`, not an exception.
- Unit-test the rejection path harder than the happy path.

## STANDARD DRIVER SET — seed per entity

**Consulting (MDA, MRS)**

| code | unit | default | meaning |
|---|---|---|---|
| `billable_fte` | number | 12 | consultants chargeable out |
| `hours_per_fte` | hours | 160 | available hours/month |
| `util_pct` | percent | 0.68 | billable ÷ available |
| `avg_rate` | currency | 750000 | IDR per billable hour |
| `realization_pct` | percent | 0.92 | invoiced ÷ standard value |
| `loaded_cost_fte` | currency | 22000000 | fully loaded cost per FTE/month |
| `bench_fte` | number | 2 | non-billable, still paid |
| `collection_days` | days | 62 | DSO — cash timing only |
| `attrition_pct` | percent | 0.015 | monthly leavers |

**Construction (MLT):** `contract_value`, `poc_pct`, `poc_physical`, `cost_to_date`,
`etc_cost`, `retention_pct`, `progress_billing_lag_days`

**Media (SBR, KMA):** `active_contracts`, `avg_contract_value`, `renewal_pct`,
`production_cost_ratio`

Add `poc_physical` (percent, 0–1) for **every** entity — Phase 5 needs it.

## FORMULAS

```
Revenue_m      = billable_fte * hours_per_fte * util_pct * avg_rate * realization_pct
Direct_cost_m  = (billable_fte + bench_fte) * loaded_cost_fte
GM%            = 1 - loaded_cost_fte / (hours_per_fte * util_pct * avg_rate * realization_pct)
util_be        = loaded_cost_fte / (hours_per_fte * avg_rate * realization_pct)
rev_per_fte_m  = Revenue_m / (billable_fte + bench_fte)
```

Default mappings to seed: `4100`/`4200`/`4900` ← the revenue expression;
`5100-01` ← `Direct_cost_m`.

## ACTUAL DRIVER DERIVATION

```
actual util_pct    = billable_hours_m / (headcount_m * hours_per_fte)
actual avg_rate    = Revenue_m(4xxx) / billable_hours_m
actual loaded_cost = (5100-01 + 5100-02 + 6100) / headcount_m
```

`billable_hours_m` comes from the new `journal_lines.quantity` where `uom='hour'`. Where
hours are absent, return `null` for that driver rather than a fabricated number.

## STEPS

1. Tables + columns in `migrate_database()`; verify no positional-insert breakage on
   `journal_lines`.
2. `fpa_calc.py` with the whitelisted evaluator + its tests. Write these first.
3. Seed the standard driver set and default mappings per entity (idempotent — `INSERT OR IGNORE`).
4. Derived-driver resolution: topological order, cycle detection, `ValueError` on a cycle.
5. Actual derivation from the ledger.
6. API:
   ```
   GET|POST /api/drivers          PUT|DELETE /api/drivers/<int:did>
   GET      /api/drivers/values?version_id=&year=&company_id=
   PUT      /api/drivers/values   bulk upsert
   GET      /api/drivers/actuals?company_id=&year=
   GET|PUT  /api/drivers/mappings
   ```
7. A reusable driver grid component in `app.js` (12 months × drivers, editable, recalcs
   derived rows live). Phase 4's forecast screen embeds it — build it standalone-testable.
8. Add `quantity` / `uom` inputs to the journal-entry line editor, shown only for revenue
   and `5100-*` accounts. Optional; never required.

## DONE WHEN

- Evaluator rejects `__import__`, `os.system`, `a.b`, `f()`, `1 if x else 2`, and any
  driver code not in the supplied map — one test per case.
- A derived driver recomputes when its input changes.
- A cyclic formula raises `ValueError` instead of recursing.
- Seeding twice adds no duplicate drivers.
- Actual drivers on seeded `TEST-SERVER` return numbers for cost-based drivers and `null`
  for hour-based ones (the seed has no hours).

## NOTES FOR THE AGENT

- If the user says PMs will not enter hours, say so in the notes and fall back to a monthly
  `project_hours` input driver. Do not silently fabricate hours from revenue ÷ rate.
