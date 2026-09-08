# AGENT.md — house rules for the FP&A build

You are working inside `apps/erp` of the `mores-hub` monorepo — the **MORES HV (Helicopter View)**
group finance ERP: Flask + SQLite + a no-build-step vanilla-JS SPA.

Read this file before every phase. Read `FPA-FRAMEWORK.md` for the reasoning behind any
decision; read the phase file for what to do.

---

## Prime directives

1. **One phase per session.** Do the phase file you were pointed at. Do not start the next
   one. When it is done, tick its boxes in `TASKS.md` and stop.
2. **Never touch `MORES-GROUP.db`.** That is live group data — 5 entities, 17+ months of
   posted journals. Develop and test against `TEST-SERVER`. Reseed it with
   `python database.py --force TEST-SERVER` whenever you need a clean slate.
3. **Migrations are additive and idempotent.** They live in `database.migrate_database()`
   (`database.py:820`) and run on **every** database on **every** startup. Only
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE VIEW IF NOT EXISTS`,
   and the existing `_add_column()` helper. **Never `DROP TABLE`.** To retire a table,
   `ALTER TABLE ... RENAME TO <name>_legacy_YYMMDD`.
4. **No new dependencies, no new framework, no build step.** The stack is Flask, sqlite3,
   openpyxl, and hand-written JS. `requirements.txt` should not grow. If a phase seems to
   need a library, say so and stop rather than adding one.
5. **Ask before deleting or rewriting anything you were not asked to change.** This
   codebase has a live user.

---

## Conventions to copy, not reinvent

### Python / Flask (`server.py`)

- Routes are `@app.get("/api/...")` / `@app.post` / `@app.put` / `@app.delete`.
- Auth: `@login_required`, or `@role_required("admin", "finance")` for writes.
  Viewers are read-only; enforce it in the decorator, never in the UI.
- Tenant guard: call `check_company_access(company_id)` on **every** endpoint that takes a
  `company_id`. Call `project_in_company(project_id, company_id)` before writing anything
  keyed to a project.
- Year parameter: use the existing `year_param()` helper.
- The DB handle is `db()`; it is per-request and torn down in `close_db`.
- Raise `ValueError("message")` for a 400 — there is already an `@app.errorhandler(ValueError)`.

### SQL / SQLite (`database.py`, `reports.py`)

- Dates are `TEXT` in `YYYY-MM-DD`. Amounts are `REAL`. Booleans are `INTEGER NOT NULL DEFAULT 0`.
- Enums are `TEXT ... CHECK (col IN (...))`.
- **`UNIQUE` with a nullable column does not work the way you expect in SQLite** — NULLs
  compare distinct, so `UNIQUE(..., project_id, ...)` does not stop duplicate NULL-project
  rows. Copy the existing upsert pattern from `excel_io.py:503 upsert_budget()`:
  `UPDATE ... WHERE project_id IS ?` first, then `INSERT` only if `rowcount == 0`.
  Do **not** use `ON CONFLICT` on those keys.
- Multi-company queries use `reports._company_filter(company_ids)` → `(placeholders, ids)`.
- Consolidated scope drops intercompany accounts: `reports._consolidated(company_ids)` is
  the test, `AND a.is_intercompany = 0` is the clause. Every new consolidated report must
  honour this or the group numbers double-count.
- Natural sign for a P&L account is `reports.SIGN[type]` applied to `SUM(debit - credit)`.

### Frontend (`static/app.js`, `static/app.html`)

- Single file, no bundler, no framework. Pages are `async function pageX(el)` registered in
  the `routes` object (`app.js:588`), dispatched by `render()` on `hashchange`.
- Scope helpers: `state.companyId`, `state.year`, `scopeQS()`, `canWrite()`, `isAdmin()`.
- Money renders with `fmt()` / `fmtRp()` / `fmtShort()`. Always escape user text with `esc()`.
- **Adding a screen means editing three places or the menu silently vanishes for
  non-admin users:**
  1. `MENU_ROUTES` in `server.py:2444`
  2. `NAV_ITEMS` in `static/app.js:464`
  3. the `<nav>` block in `static/app.html`

### Exports

- Excel goes through `excel_io.py` (openpyxl), PDF through `pdf_export.py`. Follow the
  existing `/api/export/...` route shape. Do not use `pypdf`.

---

## Definition of done

A phase is done when **all** of the following hold:

- [ ] `python database.py --force TEST-SERVER` succeeds, then `python server.py` boots clean
- [ ] Running the migration twice in a row changes nothing the second time
- [ ] Every test named in the phase file's **DONE WHEN** section passes
- [ ] No regression: `/api/reports/budget-vs-actual`, `/api/reports/pnl`,
      `/api/reports/balance-sheet` and `/api/projects/performance` return the same numbers
      as before the change on a freshly seeded `TEST-SERVER`
- [ ] `TASKS.md` boxes ticked, with a one-line note of anything you deviated from

## Tests

Put them in `apps/erp/tests/test_fpa_<phase>.py`, plain `pytest`, no fixtures framework
beyond a `conn` helper that opens `TEST-SERVER`. If `pytest` is not installed, write the
tests anyway and say so — do not add it to `requirements.txt` without asking.

## When you disagree with the spec

Say so, in the phase's notes, with the reason. Do not silently do something else. The spec
was written from a read of the code, not from running it — if the code says otherwise, the
code wins, and the spec gets corrected.
