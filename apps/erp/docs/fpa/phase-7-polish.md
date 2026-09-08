# Phase 7 — Sensitivity, forecast accuracy, exports

**Depends on:** Phase 1, 4, 6 · **Estimate:** 5–7 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §4.5, §6.5

## GOAL

The three things that make the system stick: know which lever actually matters, know whether
the forecaster is any good, and get every pack out of the app as Excel or PDF.

No new tables. This phase is computation and I/O only.

## 1. SENSITIVITY

**Tornado** — flex each driver ±10% independently, hold everything else at base, sort by
absolute effect on FY profit.

```
for each driver d:
    low  = run(base with d * 0.90)
    high = run(base with d * 1.10)
    impact[d] = |high.fy_profit - low.fy_profit|
sort desc, render as a horizontal diverging bar chart
```

Usually rate and utilization dominate, and usually not the driver management is arguing
about. That is the point of the chart.

**Two-way grid** — the top two drivers by tornado impact, 5×5, each cell a full scenario
run, coloured by FY profit or min cash (selectable). 25 runs; cache by `input_hash`.

**Expected value** across named scenarios:

```
EV = Σ (scenario FY profit × probability_pct)
```

Warn in the response when the probabilities of the scenarios in scope do not sum to 1.0
(±0.01). Do not silently normalise.

```
GET /api/scenarios/<int:sid>/sensitivity?mode=tornado|grid&drivers=code1,code2
GET /api/scenarios/expected-value?company_id=&year=
```

Both render in a **Sensitivity** tab on `#/scenarios`.

## 2. FORECAST ACCURACY

Every locked `kind='forecast'` version becomes a scoring candidate.

```
Error_m   = Actual_m - FC_m
APE_m     = |Error_m| / max(|Actual_m|, eps)      eps = 1.0 IDR
MAPE      = mean(APE over scored months)
Bias      = mean(Error_m) / mean(Actual_m)        persistent sign = systematic optimism
Hit rate  = share of months where |Error_m| <= 0.10 * |Actual_m|
```

Score at **lag 1, 3 and 6** months past `as_of_month`. Only score months that are now closed.
Report per company, per account group, and per `created_by` user.

```
GET /api/forecast/accuracy?company_id=&year=&lag=1|3|6
```

Surface on `#/forecast` as a small KPI plus a per-forecaster table under Settings.

Publishing bias internally is the point — it cuts sandbagging faster than any policy. If the
user objects to naming forecasters, make the per-user table admin-only rather than dropping it.

## 3. EXPORTS

Follow the existing patterns exactly: `excel_io.py` (openpyxl) and `pdf_export.py`. Match the
sheet styling of the current `/api/export/budget-vs-actual` output so the packs look like one
family. Do **not** use `pypdf`.

```
GET /api/export/forecast?company_id=&year=&version_id=
GET /api/export/variance?company_id=&year=&base=&month=
GET /api/export/scenario?scenario_id=
GET /api/export/pdf/variance-pack?company_id=&year=&month=
GET /api/export/pdf/scenario?scenario_id=
GET /api/templates/driver-values?company_id=&year=
```

**Forecast workbook:** one sheet per company — accounts × 12 months, actual months shaded,
method in a comment or an adjacent column, Budget and LE totals in a summary block.

**Variance pack:** the table plus every commentary line, root cause, owner and status.
The pack is the deliverable for the WD+7 meeting — it must be readable without the app.

**Scenario:** assumptions listed in `seq` order in plain language, then the P&L bridge and
the cash bridge.

Add a `POST /api/import/driver-values` to match the template, mirroring
`server.py:1835 import_budget`.

## DONE WHEN

Tests in `tests/test_fpa_phase7.py`:

17. **Regression, and the important one:** intercompany accounts (`is_intercompany = 1`) are
    still eliminated in consolidated forecast and scenario output, matching
    `reports._consolidated()` (`reports.py:59`). Assert the consolidated group total for an
    intercompany account is zero across budget, forecast and scenario.
- Tornado on a fixture where one driver is dominant ranks it first.
- Expected value warns when probabilities sum to 0.8.
- MAPE against a perfect forecast is 0.0; bias against a forecast that is 10% low is -0.10
  (sign convention documented in the response).
- Every export endpoint returns a non-empty file with the right content type and a filename
  containing the company code and year.

## NOTES FOR THE AGENT

- If any earlier phase was descoped, say here which tests could not be run and why. A green
  Phase 7 on top of a hollow Phase 4 is worse than an honest amber.
