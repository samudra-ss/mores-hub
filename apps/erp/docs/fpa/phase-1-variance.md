# Phase 1 — Variance layer

**Depends on:** Phase 0 · **Estimate:** 5–7 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §5

## GOAL

Turn the existing budget-vs-actual subtraction into a variance *control*: correct
favourable/unfavourable sign in the API, materiality thresholds, price/volume/mix
decomposition, and mandatory written commentary on every material line.

**Must not break:** `reports.budget_vs_actual()` and `reports.project_budget_vs_actual()`
must keep returning their existing keys (`variance`, `used_pct`) unchanged. New keys are
additive.

## WHAT ALREADY EXISTS

- `reports.py:451 budget_vs_actual()` — returns `variance = actual - budget`, `used_pct`
- `reports.py:554 project_budget_vs_actual()` — same, per project
- `reports.py:273 account_ledger()` — the drill-through you will reuse
- `reports.SIGN` — natural-sign map applied to `SUM(debit - credit)`

## THE BUG TO FIX

The favourable/unfavourable rule currently lives in the **frontend**, in `pageProjectHV`
(`app.js`, around line 945):

```js
const good = lbl === "COGS" ? v <= 0 : v >= 0;   // ← delete this
```

Every new screen will re-implement it and one will get it backwards. Move it into
`reports.py` and have the UI read a flag.

## DDL

```sql
CREATE TABLE IF NOT EXISTS variance_rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER REFERENCES companies(id),
    account_type  TEXT,
    account_code  TEXT,
    abs_threshold REAL NOT NULL DEFAULT 25000000,
    pct_threshold REAL NOT NULL DEFAULT 0.10,
    is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS variance_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    account_id   INTEGER REFERENCES accounts(id),
    project_id   INTEGER REFERENCES projects(id),
    year         INTEGER NOT NULL,
    month        INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_var_notes ON variance_notes(company_id, year, base_kind);
```

Note the nullable-column `UNIQUE` caveat from `AGENT.md` — use the UPDATE-then-INSERT
pattern for `variance_notes` too.

Seed one group-wide default rule (`company_id` NULL, `account_type` NULL) on migration.

## FORMULAS

```python
SIGN_FAV = {"revenue": 1.0, "expense": -1.0, "asset": 1.0,
            "liability": -1.0, "equity": 1.0}

def favourable(acct_type, actual, plan):
    """Signed variance where positive is ALWAYS good for the business."""
    return SIGN_FAV[acct_type] * (actual - plan)
```

Materiality — **OR**, not AND:

```
material  ⟺  abs(variance) >= abs_threshold  OR  abs(variance) >= pct_threshold * abs(plan)
```

Revenue decomposition (needs `journal_lines.quantity` from Phase 2 — until then return
`decomposable: false` and show a single `spend` variance):

```
Total  = (H_a * R_a) - (H_b * R_b)
Volume = (H_a - H_b) * R_b
Rate   = (R_a - R_b) * H_a
Mix    = Σ_i (H_a,i - H_a * w_b,i) * (R_b,i - R_b,avg)

assert abs(Volume + Rate + Mix - Total) < 0.01
```

Completion gate:

```
variance_pack_complete = material lines with non-empty commentary / material lines
```

## STEPS

1. Add `SIGN_FAV` and `favourable()` to `reports.py`, next to the existing `SIGN`.
2. Add `variance_fav`, `is_favourable`, `is_material`, `threshold_applied` to every row
   returned by `budget_vs_actual()` and `project_budget_vs_actual()`. Existing keys stay.
3. New `reports.variance(conn, company_ids, year, base, base_version_id, month=None,
   project_id=None)` — one function, three bases:
   - `budget` → the locked `kind='budget'` version
   - `forecast` → a named `plan_versions` row (Phase 4 lights this up; ship the plumbing now)
   - `prior_year` → the same actuals query shifted a year
   Response shape identical for all three so the UI is one component.
4. `reports.variance_bridge(...)` — the waterfall components: budget profit, revenue
   volume/rate/mix, direct cost rate/efficiency, opex spend, timing, actual profit.
   Until Phase 2 lands, collapse the undecomposable pieces into one `unexplained` bar and
   label it honestly.
5. API:
   ```
   GET      /api/variance?company_id=&year=&base=&base_version_id=&month=&project_id=&materiality=
   GET      /api/variance/bridge?company_id=&year=&project_id=
   GET      /api/variance/decompose?account_id=&year=&month=
   GET|POST /api/variance/notes        PUT /api/variance/notes/<int:nid>
   GET      /api/variance/completion?company_id=&year=&month=
   GET|POST /api/settings/variance-rules
   ```
6. `#/variance` screen — new `pageVariance(el)` in `app.js`, registered in `routes`.
   Remember the three-list rule from `AGENT.md`.
   - Selectors: base (Budget / Forecast / Prior Year), period (month / QTD / YTD / FY),
     scope (company / project)
   - Waterfall chart — reuse `chartBars()`; add a stacked/floating variant if needed
   - Table: account · plan · actual · variance · variance% · F/U pill · material flag ·
     root cause · commentary · owner · status
   - Inline commentary editor on material rows (modal, reuse `openModal()`)
   - Completion percentage in the header, red until 100%
   - Row click → account ledger drill using `reports.account_ledger()`
7. Delete the ad-hoc sign logic in `pageProjectHV` and read `is_favourable` from the API.

## DONE WHEN

Tests in `tests/test_fpa_phase1.py`:

8. `variance_fav` is positive when revenue beats plan **and** when expense lands under plan.
9. Volume + Rate + Mix == Total within 0.01 IDR on a three-project fixture
   *(defer to Phase 2 if hours are not yet available — say so in the notes)*.
10. A material line with empty commentary keeps `variance_pack_complete` below 1.0.
11. Materiality fires on the OR of both thresholds — test at each boundary
    (just under abs, just over abs, just under pct, just over pct).

## NOTES FOR THE AGENT

- Set real thresholds per entity before shipping. IDR 25 juta / 10% is a placeholder scaled
  off ~IDR 4.55 bn/month group revenue in the seed data. Ask the user for real ones.
- Do not build the forecast generation here. Wire the `base=forecast` path and leave it.
