# Phase 5 — Project EAC on Project HV

**Depends on:** Phase 2 · **Estimate:** 3–4 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §5.6

## GOAL

Tell the group where each project will *land*, not where it has *been*. Highest payoff per
day of anything in the plan for a project business.

**Must not break:** `reports.project_performance()` (`reports.py:616`) and the existing
Project HV scoreboard keep their current keys and numbers. EAC columns are additive.

## FORMULAS

```
BAC   = Σ plan_lines expense for the project, locked budget version
ACWP  = Σ posted expense on journal lines tagged to the project, to date
BCWP  = poc_physical * BAC                    (earned value; poc_physical from the PM, 0..1)
CPI   = BCWP / ACWP                           (< 1.0 = burning faster than earning)
EAC   = ACWP + (BAC - BCWP) / CPI
ETC   = EAC - ACWP
VAC   = BAC - EAC                             (negative = overrun)

margin_at_completion     = contract_value - EAC
margin_at_completion_pct = margin_at_completion / contract_value
budget_margin_pct        = (contract_value - BAC) / contract_value
margin_erosion_pp        = (budget_margin_pct - margin_at_completion_pct) * 100
```

`contract_value` comes from `contracts` (Phase 3) where a contract is linked to the
project; otherwise fall back to the project's budgeted revenue and label the source in the
response so the UI can say which it used.

**Guards:** `ACWP == 0` → CPI is undefined, return `null` and skip EAC (a project that has
spent nothing cannot be forecast to overrun). `poc_physical` missing for the month → fall
back to cost-based POC (`ACWP / BAC`) and flag `poc_source: "cost"`, because cost-based POC
makes CPI identically 1.0 and hides exactly the problem this feature exists to find. Say so
in the UI, do not hide it.

**Alert:** `margin_erosion_pp > 5` **or** `CPI < 0.90`.

## STEPS

1. `poc_physical` is already seeded as a driver in Phase 2. Add a monthly input path:
   `PUT /api/projects/<int:pid>/poc` body `{year, month, poc_physical}` → writes
   `driver_values` with `version_id IS NULL` (actual). `@role_required("admin","finance")`,
   `project_in_company()` guard.
2. `reports.project_eac(conn, company_ids, year, project_id=None)` — returns one row per
   project with every quantity above plus `poc_source` and `alert`.
3. `GET /api/projects/<int:pid>/eac?year=` and a list variant
   `GET /api/projects/eac?company_id=&year=`.
4. Extend `pageProjectHV` (`app.js:888`):
   - New scoreboard columns: **POC** · **CPI** · **EAC** · **VAC** · **Margin @ completion**
   - Red row styling when `alert` is true; keep the existing `projectHealth()` verdict pill
   - A `poc_physical` inline editor per project per month for finance/admin
   - One extra KPI tile: **Projects with negative VAC**
5. Dashboard: add the same count as a third tile. Nothing more — `pageDashboard` is already dense.

## DONE WHEN

Tests in `tests/test_fpa_phase5.py`:

- A project with `ACWP = 0` returns `cpi: null`, `eac: null`, `alert: false` — no exception.
- `CPI = 1.0` exactly → `EAC == BAC` and `VAC == 0`.
- `poc_physical` absent → `poc_source == "cost"` and the response says CPI is not meaningful.
- A project at 50% physical complete having spent 70% of BAC produces `CPI < 1`, `EAC > BAC`,
  `VAC < 0`, and `alert: true`.
- `project_performance()` returns unchanged numbers on seeded `TEST-SERVER`.

## NOTES FOR THE AGENT

- Who enters `poc_physical` is an open decision (§13 of the spec). It must not be the person
  whose bonus depends on it. Flag this in your notes; do not pick for them.
- Resist adding a milestone/WBS model here. One number per project per month is enough to
  make EAC useful, and it is the difference between shipping this in four days and four weeks.
