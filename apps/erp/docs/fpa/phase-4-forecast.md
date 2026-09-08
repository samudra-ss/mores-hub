# Phase 4 — Forecasting

**Depends on:** Phase 0, 2, 3 · **Estimate:** 7–10 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §4

## GOAL

Produce a rolling forecast: closed months frozen as actual, open months re-driven, stored
as its own `plan_version` so its accuracy can be scored later.

**Must not break:** generating a forecast must never write to a `kind='budget'` version,
and must never overwrite a line a human marked `is_override`.

## DEFINITION

For company C, year Y, cut at month M:

```
FC_line(a, p, m) = Actual(a, p, m)              for m <= M   (frozen)
                   forecast_method(a, p, m)     for m >  M   (open)

FY_LE(a, p)      = Σ Actual(1..M) + Σ FC(M+1..12)
```

`plan_versions.as_of_month = M` is what makes this unambiguous.

## METHODS — stored per line in `plan_lines.method`

| method | formula | default for |
|---|---|---|
| `runrate` | `mean(Actual[M-2..M])` | opex 6xxx |
| `seasonal` | `Actual[m, Y-1] * (1 + g)`, `g = YTD_Y / YTD_{Y-1} - 1` | seasonal revenue — needs ≥18 months history; you have 17, so warn |
| `trend_to_budget` | `Budget[m] * (YTD Actual / YTD Budget)` | when the budget shape is trusted, only the level is off |
| `driver` | evaluate `driver_mappings.expression` on forecast driver values | all revenue and direct cost |
| `backlog` | `reports.forward_revenue()` from Phase 3 | consulting revenue — preferred over `driver` for the next 2 quarters |
| `override` | manual, `is_override=1`, `source_note` **required** | anything a human insists on |

Enforce the source_note requirement at the API layer, not the UI.

## GENERATION — `POST /api/forecast/generate`

Body: `{company_id, year, as_of_month, methods: {account_code: method}}`

```
1. Create (or reuse, if draft) a plan_version: kind='forecast',
   code = 'FC-<year>-<MM>', basis_version_id = the locked budget, status='draft'
2. Actualise months 1..M from posted journal entries
   (reuse the actuals query in reports.budget_vs_actual)
3. For months M+1..12:
     revenue 4xxx  -> backlog, falling back to driver
     COGS    5xxx  -> driver; where no mapping exists, % of revenue from trailing 3 months
     opex    6xxx  -> runrate; except 6500 depreciation (schedule) and 6100 (headcount plan)
     7200          -> loan schedule, manual for now
4. Skip every existing line with is_override = 1
5. Recompute derived driver values for the same months into driver_values (version_id = this version)
6. Write plan_lines, status stays 'draft'
```

Idempotent and re-runnable **while draft**. Once `approved`, regenerating must create a new
version rather than mutate this one — return 409 if asked to regenerate an approved or
locked version.

## API

```
POST /api/forecast/generate
GET  /api/forecast/current?company_id=&year=      the is_current version + FY LE
GET  /api/forecast/accuracy?company_id=&year=&lag=   (stub here, filled in Phase 7)
GET  /api/export/forecast
```

Reuse `/api/plan/versions/*` from Phase 0 for lifecycle. Do not build a second version API.

## SCREEN — `#/forecast`

New `pageForecast(el)`. Remember `MENU_ROUTES` / `NAV_ITEMS` / `app.html`.

- Header: version selector, status pill, `as_of_month` cut marker, **Generate** and **Lock**
- KPI row: FY Latest Estimate · vs Budget · vs Prior Forecast · Coverage · MAPE (last 3 months)
- Grid: account rows × 12 months. Months ≤ M greyed and labelled *Actual*; months > M
  editable, method chip per cell, overridden cells flagged
- Chart: Actual solid → Forecast dashed → Budget grey, cut month marked
- Driver panel: embed the Phase 2 grid; editing a driver recalculates the affected rows live
- Tabs: Company level / Per project — mirror the two-mode pattern in `pageBudgets`
  (`app.js:2313`) so it feels native

Then light up `base=forecast` in the Phase 1 variance screen, and add an
LE-vs-Budget tile to the dashboard.

## DONE WHEN

Tests in `tests/test_fpa_phase4.py`:

4. A forecast with `as_of_month=6` has months 1–6 equal to posted actuals to the rupiah.
5. Regenerating a draft forecast leaves every `is_override=1` line byte-identical.
6. `FY_LE == Σ actuals(1..M) + Σ forecast(M+1..12)` for every account.
- Generating against an `approved` or `locked` version returns 409.
- `POST /api/plan/lines` with `method='override'` and an empty `source_note` returns 400.
- Two forecasts for the same company-year cannot both have `is_current=1`.

## NOTES FOR THE AGENT

- Cadence is an open business decision (§13 of the spec). Monthly generation is heavier than
  quarterly. Build the endpoint the same either way; do not hardcode a schedule.
- With 17 months of history the `seasonal` method has one prior year at best. Emit a warning
  in the response when it is selected with insufficient history rather than silently
  producing a confident-looking number.
