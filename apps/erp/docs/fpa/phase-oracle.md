# Phase O — The Oracle (*Ahli Nujum*)

**Depends on:** Phase 0, Phase 3 · **Estimate:** 8–12 days
**Read first:** `AGENT.md`, then `ORACLE.md` in full — it is the spec, this file is the build order.

**Sequence note:** this phase owns `fpa_cash.py`. Phase 6 (Scenario Lab) must import it
rather than write a second cash bridge. If Phase 6 is already built, reuse its bridge here
and skip step 4. Never build both.

## GOAL

A going-concern gate on project budgets: dated commitments → a daily cash ledger → a verdict
naming the breach date, the shortfall, the items that caused it, and the smallest set of
deferrals that fixes it. Reported through the CFO / CFI / CFF split.

**Must not break:** `consult` is read-only. It must not write `plan_lines` or
`commitment_items`. `reports.cash_flow()` and `reports.weekly_cash_flow()` keep their current
public shape.

---

## STEP 0 — Fix the cash definition first. Nothing else is valid until this is done.

**0a. `1170 CC BCA VISA CARD` is an asset under `1100 Cash & Bank`** (`database.py:110`).
A credit card is a liability. Both cash reports sweep `type='asset' AND code LIKE '11%'`, so
card balances count as cash today.

- Ask the user which they want: reclassify to `2xxx`, or keep it and exclude it from the cash
  set. **Do not decide this alone** — reclassifying moves historical balances.
- Whichever they choose, `1170` must not be in the Oracle's cash set.

**0b. Two definitions of "cash" exist.** `dashboard()` honours `get_cash_codes()`
(`server.py:1134`); `reports.cash_flow()` (`:696`) and `reports.weekly_cash_flow()` (`:920`)
hardcode `code LIKE '11%'`.

- Move `get_cash_codes()` into `reports.py` as `cash_account_codes(conn)`.
- Have all three call it. Keep `server.get_cash_codes()` as a thin wrapper so existing
  callers do not break.
- Regression-check the dashboard cash tile against the cash-flow report closing balance on
  seeded `TEST-SERVER` — they should now agree. If they did not before, say by how much.

**0c. Add the missing financing accounts** to `STANDARD_COA` in `database.py`:

```python
("2400", "Dividends Payable",  "liability", "2000", 0),
("3300", "Dividends Declared", "equity",    "3000", 0),
```

`apply_standard_coa()` already runs for every company on every startup, so this backfills.

---

## STEP 1 — Cash-flow classification

```python
_add_column(conn, "accounts", "cash_flow_class", "TEXT NOT NULL DEFAULT ''")
```

Seed idempotently from the map in `ORACLE.md` §2 — `UPDATE accounts SET cash_flow_class=?
WHERE code=? AND cash_flow_class=''` so an admin override is never clobbered.

Critical: `6500` and `1510` are **`noncash`**. Getting these wrong makes the Oracle
optimistic, which is the one direction it must never fail in.

`GET|POST /api/settings/cash-flow-classes` — admin only, per-account override.
An account left `''` reports in an **Unclassified** bucket and counts as `operating`.

## STEP 2 — `commitment_items`

DDL is in `ORACLE.md` §3. Then the materialisers — each idempotent, each tagged with
`source` + `source_id` so re-running replaces rather than duplicates:

| From | Direction | Certainty | Date |
|---|---|---|---|
| `payables` | out | `committed` | `due_date` |
| `receivables` | in | `committed` | `due_date` + client lag |
| `contracts` | in | `expected` | recognition schedule |
| `pipeline` | in | `speculative` | `expected_start` + duration spread |
| `plan_lines` (version under review) | out | `planned` | per-account default due day |
| `investment_events` | in/out | `planned` | `date` |

**Client collection lag** — from `receivables` history:

```
lag(client) = median(paid_date − due_date) over that client's settled invoices
              default 14 days when fewer than 3 settled invoices exist
```

`receivables` has no `paid_date` column, only `paid` (an amount). Add
`_add_column(conn, "receivables", "paid_date", "TEXT")` and backfill `NULL`; where it is
null, fall back to the default lag and mark the item `lag_source: "default"` so the
assumptions panel can show how much of the forecast rests on a guess.

**Per-account default due day** — a small `app_settings` map
(`{"6100": {"day": 25}, "2100": {"days_after": 30}, "2300": {"day": 10}}`), editable in
Settings. This is what makes `from-version` one click instead of 200 rows of typing.

`POST /api/commitments/from-version/<int:vid>` writes into a **draft** version only — 409
on approved or locked (reuse `check_version_writable()` from Phase 0).

## STEP 3 — Buffer policy

`app_settings.oracle_buffer_policy`, merged over fallbacks exactly the way
`get_thresholds()` (`server.py:1073`) does it:

```json
{"months_cover": 2.0,
 "absolute_floor": {"MDA": 0, "SBR": 0, "MLT": 0, "KMA": 0, "MRS": 0},
 "cash_pooling": false,
 "interest_class": "operating",
 "horizon_days": 180}
```

```
monthly_fixed_cash_opex = trailing 3-month average of posted 6xxx
                          where cash_flow_class='operating', excluding 6500
buffer_floor(entity, m)  = max(absolute_floor[entity], months_cover * monthly_fixed_cash_opex)
group floor              = Σ entity floors        unless cash_pooling
```

`absolute_floor` defaults to 0 deliberately — **0 is visibly wrong, so someone will set it.**
Surface "buffer floor not configured for <entity>" as a warning on every consult until it is.

## STEP 4 — `fpa_cash.py`, the daily ledger

Pure functions, no Flask, no globals — Phase 6 imports this module.

```python
def daily_ledger(items, opening_cash, start_date, horizon_days, run): ...
def buffer_floors(conn, company_ids, policy, months): ...
def headroom(ledger, floors): ...
def verdict(headroom_series, floors): ...          # LULUS | WASPADA | TOLAK
def contributors(items, worst_date, n=5): ...
def remedy(items, ledger_fn, floors): ...
```

Run filters (`ORACLE.md` §5):

| run | inflows | outflows |
|---|---|---|
| `bound` | `committed` | `committed` + `planned` |
| `base` | `committed` + `expected` + weighted `speculative` | all |
| `optimistic` | all at face value | `committed` + `planned` |

**The verdict is taken from `bound`.** Hardcode that. Do not make it a parameter.

Verdict thresholds:

```
TOLAK    min headroom < 0 in BOUND
WASPADA  bound ok, but min monthly headroom < 0.25 * buffer_floor, OR headroom < 0 in BASE
LULUS    headroom >= 0.25 * buffer_floor every day in BOUND
```

## STEP 5 — The remedy engine

Greedy, per `ORACLE.md` §6: candidates are `deferrable=1 AND certainty != 'committed'`,
ordered `investing` first then amount descending; shift by
`min(defer_limit_days, days_needed)`; recompute; stop when min headroom ≥ 0.

Cap at 200 recomputations. If no set works, return the best achievable headroom and the
residual shortfall — **never return "no remedy" without a number**; the size of the gap is
what tells the CEO whether to raise financing or refuse the project.

`POST /api/commitments/apply-remedy` writes the shifted `due_date` values into a **draft**
version only.

## STEP 6 — Activities and flags

`reports.cash_activities(conn, company_ids, year)` — monthly CFO / CFI / CFF from posted
entries via `cash_flow_class`, honouring `_consolidated()` so intercompany is eliminated at
group level.

The five flags from `ORACLE.md` §7. **Financing dependence** (CFO < 0 while CFF > 0 covers
it) is the one that matters most — make sure it is computed on a rolling 3-month basis, not
a single month, or it will cry wolf every time a loan lands.

## STEP 7 — Gate

Add to `plan_versions`:

```python
_add_column(conn, "plan_versions", "oracle_verdict", "TEXT NOT NULL DEFAULT ''")
_add_column(conn, "plan_versions", "oracle_consulted_at", "TEXT")
```

`app_settings.oracle_gate_mode` = `advisory` (**default — ship this**) | `blocking`.

In `blocking`, `POST /api/plan/versions/<vid>/status` → `approved` returns 409 on a stored
`TOLAK` unless an admin passes `override_reason`, which is written to an audit note.

## STEP 8 — `#/oracle` screen

Per `ORACLE.md` §9. Route `oracle`, nav glyph `☾` (`◈` is taken by Forecast).
`MENU_ROUTES` + `NAV_ITEMS` + `app.html` — all three.

Bilingual labels through the existing `t()`: *Ahli Nujum* · *Lulus* / *Waspada* / *Tolak* ·
*Terikat* / *Dasar* / *Cerah* · *Bantalan Kas* · *Tanggal Jatuh Tempo*.

Five rows: verdict header (date as the headline, not the colour) · daily cash line with the
buffer band and three runs · CFO/CFI/CFF bars with flag pills · top contributors ·
the remedy in plain sentences with **Apply to draft** · assumptions, auto-expanded on `TOLAK`.

Chart: extend `chartBars()` or add a small `chartLine()` — no chart library, no build step.

---

## DONE WHEN

Tests in `tests/test_fpa_oracle.py`:

- **O1** `1170` is not in the cash set returned by `reports.cash_account_codes()`.
- **O2** `dashboard()` cash and `cash_flow()` closing balance agree to the rupiah on seeded
  `TEST-SERVER`.
- **O3** `6500 Depreciation` and `1510` contribute exactly 0 to CFO. A ledger with only a
  depreciation entry produces zero cash movement.
- **O4** CFO + CFI + CFF == the net movement of the cash accounts for the same period, to
  0.01 IDR. **This is the identity check — if it does not hold, the classification is wrong.**
- **O5** A `bound` run counts no `speculative` inflow.
- **O6** A commitment set whose worst headroom is exactly 0 returns `WASPADA`, not `TOLAK`
  (boundary).
- **O7** The remedy never shifts an item with `certainty='committed'` or `deferrable=0`.
- **O8** `POST /api/oracle/consult` writes nothing — assert row counts in `plan_lines` and
  `commitment_items` are unchanged before and after.
- **O9** `from-version` against an approved or locked version returns 409.
- **O10** Running `from-version` twice produces the same item count, not double.
- **O11** With `cash_pooling: false`, an entity below its floor produces a breach even when
  the group total is above the summed floor.
- **O12** An account left at `cash_flow_class=''` appears in the Unclassified bucket and is
  counted, not dropped — assert the O4 identity still holds.

Plus: intercompany elimination survives into `cash_activities()` at group level
(the Phase 7 test 17 pattern).

---

## NOTES FOR THE AGENT

- **Fail pessimistic.** Everywhere there is a choice — an unknown lag, an unclassified
  account, a missing floor — round against the company. An Oracle that is wrong in the
  optimistic direction once will never be trusted again.
- Steps 0a and the five questions in `ORACLE.md` §12 are the user's decisions, not yours.
  Do the build, surface the warnings, and list what is still unset in your notes.
- Do not implement blocking mode as the default, even if asked mid-build. Ship advisory,
  earn the track record, then turn it on.
