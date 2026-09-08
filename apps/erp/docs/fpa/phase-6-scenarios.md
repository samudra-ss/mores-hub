# Phase 6 — Scenario Lab

**Depends on:** Phase 0, 2, 4 · **Estimate:** 10–14 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §6

## GOAL

Answer "what if" without corrupting the plan: a scenario is an ordered list of assumptions
over a base version, recomputed on demand.

**Must not break:** a scenario must never write a `plan_lines` row. The only sanctioned path
from scenario to plan is the explicit **Promote to forecast** action, which creates a new
`plan_version`.

## WHY NOT COPY THE NUMBERS

Copies rot. Copy a forecast in March, re-forecast in July, and you are now comparing a March
scenario to a July base without noticing. Store the assumptions; recompute.

## DDL

```sql
CREATE TABLE IF NOT EXISTS scenarios (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id       INTEGER REFERENCES companies(id),
    year             INTEGER NOT NULL,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'custom'
                       CHECK (kind IN ('base','best','worst','custom','stress')),
    base_version_id  INTEGER NOT NULL REFERENCES plan_versions(id),
    description      TEXT NOT NULL DEFAULT '',
    probability_pct  REAL NOT NULL DEFAULT 0,
    created_by       INTEGER REFERENCES users(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, year, name)
);

CREATE TABLE IF NOT EXISTS scenario_assumptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL DEFAULT 0,
    target_type  TEXT NOT NULL
                   CHECK (target_type IN ('driver','account','project','pipeline',
                                          'headcount','collection','contract')),
    target_id    INTEGER,
    op           TEXT NOT NULL CHECK (op IN ('pct','abs','set','shift_months','toggle')),
    value        REAL NOT NULL DEFAULT 0,
    from_month   INTEGER NOT NULL DEFAULT 1  CHECK (from_month BETWEEN 1 AND 12),
    to_month     INTEGER NOT NULL DEFAULT 12 CHECK (to_month BETWEEN 1 AND 12),
    label        TEXT NOT NULL DEFAULT ''
);

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

CREATE INDEX IF NOT EXISTS idx_scen_results ON scenario_results(scenario_id, input_hash, year);
```

`input_hash` = SHA-256 of `(base_version_id, base_version.locked_at, the assumption rows in
seq order, a digest of the base version's driver_values)`. Its real job is stale detection,
not speed — 5 companies × 40 accounts × 12 months is 2 400 rows.

## THE SEVEN ASSUMPTIONS — build these, they cover ~90% of real questions

| Question | target_type | op | example |
|---|---|---|---|
| Utilization drops to 60% | `driver` (`util_pct`) | `set` | 0.60, months 7–12 |
| Rates up 8% in Q4 | `driver` (`avg_rate`) | `pct` | +0.08, months 10–12 |
| Hire 5 consultants in September | `headcount` | `abs` | +5 from month 9, cost derived from `loaded_cost_fte` |
| We lose PRJ-PRISMA | `project` | `toggle` | off, months 8–12 |
| CDA slips a quarter | `project` | `shift_months` | +3 |
| Client pays at 90 days not 60 | `collection` | `set` | 90 — **cash only, P&L untouched** |
| Only 30% of pipeline converts | `pipeline` | `pct` | probability × 0.30 |

## COMPUTATION ORDER — order matters and is user-visible

```
1. Resolve base_version -> plan_lines + driver_values
2. Apply assumptions in seq order to DRIVERS first (they cascade)
3. Re-evaluate driver_mappings -> revenue and direct cost
4. Apply account-level assumptions (these override step 3 for their target)
5. Apply project toggles and shifts (zero or slide BOTH revenue and cost lines)
6. Recompute P&L, then the cash bridge
7. Write scenario_results with input_hash
```

Two assumptions on the same target apply in sequence. Document it in the UI or someone will
file a bug.

## CASH BRIDGE

```
Cash_m = Cash_{m-1} + Collections_m - Disbursements_m - Tax_m - CapEx_m - Debt_service_m

Collections_m    = Σ_k Revenue_k * collection_curve(m - k)
collection_curve = derived from collection_days
                   default: 20% month of invoice, 55% +1, 20% +2, 5% +3
Disbursements_m  = payroll_m (same month) + vendor_m (lagged by DPO)

min_cash = min over months of Cash_m
runway   = months until Cash_m < minimum_operating_cash (an app_settings value)
```

**Reuse:** write the scenario's weekly cash into `cash_budget` (behind an explicit user
action, never automatically) so `reports.weekly_cash_flow()` (`reports.py:920`) renders
scenario-vs-actual with zero new plumbing. This is the highest-leverage reuse in the build.

## API

```
GET|POST   /api/scenarios            PUT|DELETE /api/scenarios/<int:sid>
GET|POST   /api/scenarios/<int:sid>/assumptions
PUT|DELETE /api/scenario-assumptions/<int:aid>
POST       /api/scenarios/<int:sid>/run            recompute, returns P&L + cash
GET        /api/scenarios/<int:sid>/results?view=pnl|cash|bridge
GET        /api/scenarios/compare?ids=1,2,3
POST       /api/scenarios/<int:sid>/promote        -> new plan_version, kind='forecast'
GET        /api/export/scenario
```

## SCREEN — `#/scenarios`

New `pageScenarios(el)`. Remember `MENU_ROUTES` / `NAV_ITEMS` / `app.html`.

- **Left:** scenario list, kind badges, probability
- **Centre:** assumption builder — plain-language rows ("Utilization → 60% from Jul",
  "Lose PRJ-PRISMA from Aug"), drag to reorder (`seq`), each row deletable
- **Right:** live results — FY revenue / profit / margin / min cash / runway, each with its
  delta vs base
- **Compare tab:** 2–4 scenarios side by side, P&L and cash
- **Promote to forecast** button, with a confirm modal naming the version it will create

Sensitivity lives in Phase 7.

## DONE WHEN

Tests in `tests/test_fpa_phase6.py`:

12. A scenario with zero assumptions produces results identical to its base version.
13. Two assumptions on the same driver apply in `seq` order — `0.9` then `set 1.1` differs
    from `set 1.1` then `0.9`.
14. Changing `collection_days` moves cash and leaves FY profit unchanged to the rupiah.
15. Toggling a project off zeroes both its revenue **and** its direct cost, not revenue alone.
16. Editing the base version changes `input_hash` and marks cached results stale.
- No code path in this phase writes to `plan_lines` except `promote`.
- `promote` creates a version with `kind='forecast'`, `status='draft'`, and
  `basis_version_id` pointing at the scenario's base.

## NOTES FOR THE AGENT

- This is the largest phase. If you are running out of room, ship the runner and the results
  view and defer the compare tab — but never defer the "no writes to plan_lines" guarantee.
