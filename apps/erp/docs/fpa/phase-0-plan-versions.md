# Phase 0 — Versioned plan facts

**Depends on:** nothing · **Estimate:** 3–5 days · **Read first:** `AGENT.md`, `FPA-FRAMEWORK.md` §2

## GOAL

Move the plan store from a single mutable `budgets` row per cell to a versioned fact table,
so a budget, several forecasts, and several scenarios can coexist without overwriting one
another.

**Must not break:** every existing budget report must return byte-identical numbers on a
freshly seeded `TEST-SERVER` after the migration.

## WHY THIS IS FIRST

`budgets` has `UNIQUE (company_id, account_id, project_id, year, month)` and
`excel_io.upsert_budget()` does `UPDATE ... SET amount=?` in place. One number per cell,
mutable, no history. Forecasting, variance-vs-budget and scenarios are all impossible on
top of that. Building them first means building them twice.

## CALL SITES — measured, not guessed

| File | Line | Kind |
|---|---|---|
| `reports.py` | 457, 538, 566, 639 | read |
| `server.py` | 692, 1020 | read |
| `server.py` | 791, 1045 | **write** |
| `excel_io.py` | 506, 512 (`upsert_budget`) | **write** |
| `database.py` | 636, 641, 784 | **write** |
| `migrate_cakun.py` | 83 (write), 91 (read) | **write** — retire it |

10 reads survive untouched behind the compatibility view. 5 writes get repointed. Verify
these line numbers before editing — the file may have moved since the spec was written.

## DDL

Drop into `database.migrate_database()`, after the existing `CREATE TABLE IF NOT EXISTS`
block and **before** the `remove_holding(conn)` call.

```sql
CREATE TABLE IF NOT EXISTS plan_versions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        INTEGER REFERENCES companies(id),
    year              INTEGER NOT NULL,
    code              TEXT NOT NULL,
    label             TEXT NOT NULL DEFAULT '',
    kind              TEXT NOT NULL DEFAULT 'budget'
                        CHECK (kind IN ('budget','forecast','scenario')),
    basis_version_id  INTEGER REFERENCES plan_versions(id),
    as_of_month       INTEGER,
    status            TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','locked','archived')),
    is_current        INTEGER NOT NULL DEFAULT 0,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    locked_at         TEXT,
    notes             TEXT NOT NULL DEFAULT '',
    UNIQUE (company_id, year, code)
);

CREATE TABLE IF NOT EXISTS plan_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id   INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
    company_id   INTEGER NOT NULL REFERENCES companies(id),
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    project_id   INTEGER REFERENCES projects(id),
    year         INTEGER NOT NULL,
    month        INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    amount       REAL NOT NULL DEFAULT 0,
    method       TEXT NOT NULL DEFAULT 'manual'
                   CHECK (method IN ('manual','runrate','seasonal','trend_to_budget',
                                     'driver','backlog','override','copy')),
    is_override  INTEGER NOT NULL DEFAULT 0,
    source_note  TEXT NOT NULL DEFAULT '',
    UNIQUE (version_id, company_id, account_id, project_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_plan_lines_lookup  ON plan_lines(version_id, company_id, year);
CREATE INDEX IF NOT EXISTS idx_plan_lines_project ON plan_lines(project_id, year);
CREATE INDEX IF NOT EXISTS idx_plan_versions_cur  ON plan_versions(company_id, year, kind, is_current);
```

Compatibility view — created **only after** the table has been renamed away:

```sql
CREATE VIEW IF NOT EXISTS budgets AS
SELECT pl.id, pl.company_id, pl.account_id, pl.project_id,
       pl.year, pl.month, pl.amount
FROM plan_lines pl
JOIN plan_versions pv ON pv.id = pl.version_id
WHERE pv.kind = 'budget' AND pv.status IN ('approved','locked');
```

## STEPS

1. **Create the tables.** Add the DDL above to `migrate_database()`. Boot, confirm the
   tables exist on `TEST-SERVER`, confirm a second boot changes nothing.

2. **Backfill.** Guard the whole block on
   `SELECT 1 FROM sqlite_master WHERE type='table' AND name='budgets'` so it is a no-op on
   an already-migrated database.
   - For each distinct `(company_id, year)` in `budgets`, insert a `plan_versions` row:
     `code = 'BUD-' || year`, `kind='budget'`, `status='locked'`, `is_current=0`,
     `label='Migrated from budgets'`.
   - `INSERT INTO plan_lines (version_id, company_id, account_id, project_id, year, month, amount, method)
      SELECT v.id, b.company_id, b.account_id, b.project_id, b.year, b.month, b.amount, 'copy'
      FROM budgets b JOIN plan_versions v
        ON v.company_id = b.company_id AND v.year = b.year AND v.kind = 'budget'`
   - Assert row counts match before continuing. If they do not, abort the migration and
     leave `budgets` alone.

3. **Rename and view.**
   `ALTER TABLE budgets RENAME TO budgets_legacy_<YYMMDD>` then create the view above.
   Never drop the legacy table.

4. **Repoint the 5 writes.**
   - `excel_io.upsert_budget(conn, version_id, company_id, account_id, project_id, year, month, amount)`
     — new first argument, same NULL-safe UPDATE-then-INSERT shape, target `plan_lines`.
   - `server.py:1045` `DELETE /api/budgets` → delete from `plan_lines` scoped by `version_id`.
   - `server.py:791` (cascade on project delete) → `DELETE FROM plan_lines WHERE project_id=?`.
   - `database.py:636/641` → call the new `upsert_budget`.
   - `database.py:784` → `DELETE FROM plan_lines WHERE company_id=?`.
   - `migrate_cakun.py:83` — a view is not writable. Retire the script (rename to
     `migrate_cakun.py.retired`) or repoint it at `plan_lines`. It is a historical C-AKUN
     account remap; retiring is the recommendation.

5. **Lock guard.** Next to `check_company_access()` in `server.py`:
   ```python
   def check_version_writable(version_id):
       row = db().execute("SELECT status FROM plan_versions WHERE id=?", (version_id,)).fetchone()
       if not row:
           raise ValueError("unknown plan version")
       if row["status"] in ("locked", "archived"):
           abort(409, "plan version is locked")
   ```
   Call it from every plan write endpoint.

6. **Version API.**
   ```
   GET    /api/plan/versions?company_id=&year=&kind=
   POST   /api/plan/versions                        create, optionally copy from basis_version_id
   PUT    /api/plan/versions/<int:vid>              label / notes only
   POST   /api/plan/versions/<int:vid>/status       draft|submitted|approved|locked|archived
   POST   /api/plan/versions/<int:vid>/set-current  sets is_current=1, clears siblings in one txn
   DELETE /api/plan/versions/<int:vid>              409 if locked
   GET    /api/plan/lines?version_id=&company_id=
   PUT    /api/plan/lines                           bulk upsert, 409 if version locked
   ```
   Writes: `@role_required("admin", "finance")`. Reads: `@login_required`.
   `check_company_access()` on all of them.

7. **UI.** Add a version `<select>` to the header of `pageBudgets` (`app.js:2313`), beside
   the existing company selector. Selecting a version reloads the grid from
   `/api/plan/lines`. A locked version renders read-only (reuse the `canWrite()` pattern)
   with a small lock pill. Do **not** build the forecast screen here.

## DONE WHEN

Tests in `tests/test_fpa_phase0.py`:

1. **Migration fidelity** — seed `TEST-SERVER`, count `budgets` rows as N, run the
   migration, assert `plan_lines` count == N and `SELECT * FROM budgets ORDER BY id` (the
   view) returns rows identical to the pre-migration snapshot.
2. **Lock enforcement** — `PUT /api/plan/lines` against a `locked` version returns 409 and
   `plan_lines` is unchanged.
3. **Single current** — `set-current` on one forecast clears `is_current` on every sibling
   with the same `(company_id, year)`.
4. **Idempotence** — running `migrate_database()` twice produces no additional rows.

Plus the four baseline reports from `AGENT.md` returning unchanged numbers.

## ROLLBACK

```sql
DROP VIEW budgets;
ALTER TABLE budgets_legacy_<YYMMDD> RENAME TO budgets;
DROP TABLE plan_lines;
DROP TABLE plan_versions;
```

## NOTES FOR THE AGENT

- Write the notes section of this file when you finish: what you deviated from and why.
