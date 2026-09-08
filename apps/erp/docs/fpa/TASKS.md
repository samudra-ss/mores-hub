# TASKS.md — MORES HV FP&A build checklist

Point an agent at **one phase file**. It reads `AGENT.md`, does that phase only, ticks the
boxes here, stops.

**Dependency order is not negotiable.** Phase 0 and Phase 3 have no dependencies and can run
in either order. Everything else waits.

```
0 ─┬─► 1 ─────────────────────────────► 7
   ├─► 2 ─┬─► 4 ─► 6 ──────────────────► 7
   │      └─► 5        ▲
   │                   │ imports fpa_cash.py
3 ─┴─► O (Oracle) ─────┘
```

| Phase | File | Depends on | Days | Status |
|---|---|---|---|---|
| 0 | `phase-0-plan-versions.md` | — | 3–5 | ☐ not started |
| 1 | `phase-1-variance.md` | 0 | 5–7 | ☐ not started |
| 2 | `phase-2-drivers.md` | 0 | 7–10 | ☐ not started |
| 3 | `phase-3-pipeline.md` | — | 5–7 | ☐ not started |
| **O** | **`phase-oracle.md`** · spec in `ORACLE.md` | **0, 3** | **8–12** | ☐ not started |
| 4 | `phase-4-forecast.md` | 0, 2, 3 | 7–10 | ☐ not started |
| 5 | `phase-5-project-eac.md` | 2 | 3–4 | ☐ not started |
| 6 | `phase-6-scenarios.md` | 0, 2, 4 | 10–14 | ☐ not started |
| 7 | `phase-7-polish.md` | 1, 4, 6 | 5–7 | ☐ not started |

**Three-week cut:** 0 + 1 + 3. That is versioned plans, real variance with commentary, and
the coverage ratio — a defensible FP&A function. Forecasting without Phase 2 is theatre.

**If going-concern safety at budget-commit time is the live worry, run 0 → 3 → O instead**,
ahead of variance and forecasting. The Oracle is the only phase that can stop the group from
signing something that kills it.

**Cash engine ownership:** Phase O writes `fpa_cash.py` (daily ledger, collection curve,
buffer policy) and Phase 6 imports it. Whichever is built first owns it. **Never build both.**

---

## Phase 0 — Versioned plan facts

- [ ] `plan_versions` + `plan_lines` + indexes created in `migrate_database()`
- [ ] Existing `budgets` rows backfilled into a `BUD-<year>` version per company-year
- [ ] `budgets` table renamed to `budgets_legacy_<YYMMDD>`, compatibility VIEW created
- [ ] 5 write sites repointed at `plan_lines` (`excel_io.py:503`, `server.py:791`, `:1045`, `database.py:636`, `:784`)
- [ ] `check_version_writable()` guard added; writes to a locked version return 409
- [ ] `/api/plan/versions` CRUD + `/status` + `/set-current` live
- [ ] Version selector on `#/budgets`
- [ ] `migrate_cakun.py` repointed or retired
- [ ] Tests 1–3 pass · no regression on the four baseline reports

## Phase 1 — Variance layer

- [ ] `SIGN_FAV` + `favourable()` in `reports.py`
- [ ] `variance_rules` + `variance_notes` tables
- [ ] `budget_vs_actual()` and `project_budget_vs_actual()` return `variance_fav`, `is_favourable`, `is_material`
- [ ] `/api/variance` with `base=budget|forecast|prior_year`
- [ ] `/api/variance/notes` CRUD + `/api/variance/completion`
- [ ] `/api/settings/variance-rules`
- [ ] `#/variance` screen: table, F/U pills, inline commentary, completion gauge, drill to ledger
- [ ] Ad-hoc sign logic deleted from `app.js` Project HV, replaced by the API flag
- [ ] Tests 8, 10, 11 pass

## Phase 2 — Driver engine

- [ ] `drivers`, `driver_values`, `driver_mappings` tables
- [ ] `journal_lines.quantity` + `.uom` columns via `_add_column()`
- [ ] `fpa_calc.py` — whitelisted expression evaluator (**no `eval()`**)
- [ ] Standard driver set seeded per entity (MDA/MRS consulting, MLT construction, SBR/KMA media)
- [ ] `/api/drivers` + `/values` + `/mappings` + `/actuals`
- [ ] Driver grid panel, reusable by the forecast screen
- [ ] Tests: evaluator rejects every non-whitelisted token; derived drivers recompute

## Phase 3 — Contracts, pipeline, coverage

- [ ] `contracts` + `pipeline` tables
- [ ] Stage→probability defaults, editable in Settings
- [ ] Backlog run-off + weighted-pipeline spread
- [ ] `/api/contracts`, `/api/pipeline`, `/api/pipeline/summary`, `/api/forecast/coverage`
- [ ] `#/pipeline` screen: kanban, backlog table, coverage gauge
- [ ] Coverage tile on the dashboard
- [ ] Test 7 passes (zero backlog and zero pipeline → 0, not a division error)

## Phase O — The Oracle (*Ahli Nujum*)

**Step 0 is a blocker. Do not skip it — the cash definition is wrong today.**

- [ ] `1170 CC BCA VISA CARD` resolved — reclassified to `2xxx` or excluded from the cash set (**ask the user**)
- [ ] One definition of cash: `reports.cash_account_codes()` used by `dashboard()`, `cash_flow()` and `weekly_cash_flow()`
- [ ] `2400 Dividends Payable` + `3300 Dividends Declared` added to `STANDARD_COA`
- [ ] `accounts.cash_flow_class` column + idempotent seed (`6500` and `1510` = `noncash`)
- [ ] `commitment_items` table + the six materialisers, each idempotent by `source`/`source_id`
- [ ] `receivables.paid_date` column + per-client median collection lag
- [ ] Per-account default due-day map in Settings
- [ ] `oracle_buffer_policy` in `app_settings`; unset `absolute_floor` warns on every consult
- [ ] `fpa_cash.py` — daily ledger, three runs, verdict, contributors, remedy
- [ ] Remedy engine — never touches `committed` or `deferrable=0`; always returns a number
- [ ] `reports.cash_activities()` — CFO / CFI / CFF + the five going-concern flags
- [ ] Gate stamped onto `plan_versions`; **advisory mode shipped**, blocking left off
- [ ] `#/oracle` screen, bilingual (ID/EN) through `t()`
- [ ] `GET /api/export/pdf/oracle` — the consult as a one-page memo
- [ ] Tests O1–O12 pass, **especially O4** (CFO + CFI + CFF == net cash movement)

## Phase 4 — Forecasting

- [ ] Six methods implemented, stored per line
- [ ] `POST /api/forecast/generate` — idempotent while draft, preserves overrides
- [ ] `/api/forecast/current` returns the `is_current` version + FY Latest Estimate
- [ ] `#/forecast` screen: version selector, cut marker, method chips, driver panel, LE chart
- [ ] `base=forecast` axis lit up in the variance screen
- [ ] LE-vs-Budget tile on the dashboard
- [ ] Tests 4, 5, 6 pass

## Phase 5 — Project EAC

- [ ] `poc_physical` monthly PM input (stored in `driver_values`)
- [ ] BAC / ACWP / BCWP / CPI / EAC / ETC / VAC computed in `reports.py`
- [ ] `/api/projects/<pid>/eac` + `PUT /api/projects/<pid>/poc`
- [ ] EAC columns and erosion alert on `#/projecthv`
- [ ] Alert fires at margin erosion > 5pp or CPI < 0.90

## Phase 6 — Scenario Lab

- [ ] `scenarios`, `scenario_assumptions`, `scenario_results` tables
- [ ] Seven assumption types implemented in `seq` order
- [ ] Cash bridge with collection curve; feeds `cash_budget` so `weekly_cash_flow()` reuses it
- [ ] `input_hash` staleness detection
- [ ] `/api/scenarios` CRUD, `/run`, `/results`, `/compare`
- [ ] `#/scenarios` screen: assumption builder, live results, compare tab
- [ ] Promote-to-forecast writes a new `plan_version`
- [ ] Tests 12–16 pass

## Phase 7 — Sensitivity, accuracy, exports

- [ ] Tornado + two-way sensitivity grid
- [ ] Forecast accuracy: MAPE, bias, hit rate at lag 1/3/6
- [ ] Excel exports: forecast, variance pack, scenario
- [ ] PDF exports: variance pack, scenario summary
- [ ] `/api/templates/driver-values`
- [ ] Test 17 passes (intercompany elimination survives into forecast and scenario output)
