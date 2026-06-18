# MORES HV — Helicopter View

Web-based group finance & accounting ERP (Odoo/Oracle-ERP-Cloud style, scoped to
the finance core) for a multi-company / holding structure.

## Features

- **Web app with login** — session auth, roles: `admin`, `finance`, `viewer`,
  per-user company access.
- **Multi-company & holding consolidation** — book per company, report per
  company or consolidated; intercompany-flagged accounts are eliminated in
  consolidated reports.
- **Dashboard** — KPIs (revenue, expense, profit, cash, AR/AP, budget used),
  monthly revenue/expense/profit chart, expense breakdown, per-company and
  per-project summaries.
- **Double-entry accounting** — journal entries (draft → posted), standardized
  chart of accounts per company (one-click "Apply Standard COA").
- **Budgeting** — monthly budget grid per account per company, budget vs actual
  report with variance and % used.
- **Project performance** — revenue / cost / profit / margin per project per
  year, monthly drill-down.
- **Excel everywhere** — export every report to `.xlsx`; import journal
  entries, chart of accounts, and budgets from `.xlsx` (templates downloadable
  in-app).
- **Custom fields** — admin-defined extra fields on journal entries and
  projects (text / number / date / select).
- **Bank import (BCA)** — paste BCA transfer receipts (Tanggal / Jenis
  Transaksi / Jumlah Transfer / No Referensi / Status…); the system parses
  them, flags duplicates by reference number, and the Admin/Accountant assigns
  each transfer to a cost account (+ optional project) to book it as a journal
  entry (debit cost, credit bank).

## Run

```powershell
pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8000

| user    | password   | role           | access                          |
|---------|------------|----------------|---------------------------------|
| admin   | admin123   | Admin          | full access incl. users/settings|
| finance | finance123 | Accountant     | bookkeeping, budgets, bank import|
| viewer  | viewer123  | Viewer/Auditor | read-only                       |

New users are added in **Settings → Users** (Admin only): choose role
Admin, Accountant, or Viewer/Auditor and optionally restrict company access.

The SQLite database `erp.db` is created and seeded on first start
(MORES Holding + PT MORES Digital + PT MORES Konstruksi, 17 months of journals,
2026 budgets). Delete `erp.db` or run `python database.py --force` to reseed.

> Demo passwords above are seed data — change them in Settings → Users before
> any real use.

## Structure

| file          | purpose                                   |
|---------------|-------------------------------------------|
| `server.py`   | Flask app: auth, REST API, Excel endpoints |
| `database.py` | schema, standard COA template, seed data   |
| `reports.py`  | P&L, balance sheet, trial balance, budget vs actual, project performance, consolidation |
| `excel_io.py` | openpyxl exports, imports, templates       |
| `static/`     | single-page frontend (no build step)       |
