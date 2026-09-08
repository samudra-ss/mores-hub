# Phase 3 — Contracts, pipeline, coverage

**Depends on:** nothing (can run in parallel with Phase 0) · **Estimate:** 5–7 days
**Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §4.4

## GOAL

Make forward revenue visible: signed backlog, weighted pipeline, and the coverage ratio —
the single most decision-changing number for a consulting group, and one MORES HV cannot
compute today.

This phase has standalone value on day one, before any forecasting exists.

## DDL

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
    project_id        INTEGER REFERENCES projects(id),
    name              TEXT NOT NULL,
    client            TEXT NOT NULL DEFAULT '',
    stage             TEXT NOT NULL DEFAULT 'lead'
                        CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
    probability_pct   REAL NOT NULL DEFAULT 0,
    value             REAL NOT NULL DEFAULT 0,
    expected_start    TEXT,
    duration_months   INTEGER NOT NULL DEFAULT 6,
    owner             TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contracts_company ON contracts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_company  ON pipeline(company_id, stage);
```

Stage→probability defaults, stored in `app_settings` under key `pipeline_stage_probs`,
editable in Settings, merged over hardcoded fallbacks the same way `get_thresholds()`
(`server.py:1073`) does it:

```
lead 0.10 · qualified 0.25 · proposal 0.50 · negotiation 0.75 · won 1.00 · lost 0.00
```

Setting `stage` updates `probability_pct` to the default unless the user has overridden it.

## FORMULAS

```
Recognised(contract)  = Σ posted revenue on journal lines tagged to contract.project_id
Backlog(as of D)      = Σ (contract.value - recognised)  over status='active'
Weighted pipeline     = Σ (value * probability_pct)      over open stages only
                        (exclude 'won' and 'lost')

Backlog run-off:
  straight    → remaining value spread evenly over months from D to end_date
  poc         → remaining value × the project's planned POC curve
  milestone   → remaining value at end_date (conservative until milestones are modelled)

Pipeline spread:
  value * probability_pct spread evenly over duration_months from expected_start

Coverage = (Backlog + Weighted pipeline)
         ÷ (FY revenue plan - YTD actual revenue)
```

Guard the denominator: if `FY plan - YTD actual <= 0`, return `null` and label it
"plan already met", not infinity. If backlog and pipeline are both zero, return `0.0`.

Thresholds: `>= 1.20` healthy · `0.90–1.20` watch · `< 0.90` at risk.

## STEPS

1. Tables + settings key in `migrate_database()`.
2. `reports.backlog(conn, company_ids, as_of)` and `reports.pipeline_summary(conn, company_ids)`.
3. `reports.coverage(conn, company_ids, year)` — returns backlog, weighted pipeline,
   remaining plan, ratio, verdict.
4. `reports.forward_revenue(conn, company_ids, year, from_month)` — the monthly run-off
   array Phase 4 consumes as the `backlog` forecast method.
5. API:
   ```
   GET|POST /api/contracts      PUT|DELETE /api/contracts/<int:cid>
   GET|POST /api/pipeline       PUT|DELETE /api/pipeline/<int:pid>
   GET      /api/pipeline/summary?company_id=&year=
   GET      /api/forecast/coverage?company_id=&year=
   GET      /api/export/pipeline
   ```
6. `#/pipeline` screen (`pagePipeline`), plus `MENU_ROUTES` / `NAV_ITEMS` / `app.html`:
   - Kanban by stage, each column showing count, gross value, weighted value
   - Drag between stages updates `stage` and `probability_pct`
   - Backlog table: contract · client · value · recognised · remaining · run-off end
   - Coverage gauge, per company and consolidated
   - Win-rate by stage over the trailing 12 months, feeding back into the defaults
7. Coverage tile on `pageDashboard`. One tile. Do not add more.

## DONE WHEN

Tests in `tests/test_fpa_phase3.py`:

7. Coverage with zero backlog and zero pipeline returns `0.0`, not a `ZeroDivisionError`.
- Coverage returns `null` (not infinity) when the remaining plan is zero or negative.
- Backlog excludes cancelled and completed contracts.
- Weighted pipeline excludes `won` and `lost`.
- Straight-line run-off of a 12-month contract starting mid-year lands entirely inside
  its own months, summing to the remaining value within 0.01.

## NOTES FOR THE AGENT

- Seed a handful of demo contracts and pipeline rows into `TEST-SERVER` only, so the screen
  has something to show. Never seed `MORES-GROUP`.
- The stage probabilities are a business decision. Use the defaults, flag them in the notes,
  and ask the user to set real ones.
