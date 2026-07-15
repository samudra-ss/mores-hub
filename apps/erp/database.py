"""MORES HV - database layer: schema, standard COA template, seed data.

Supports MULTIPLE named databases, each a self-contained SQLite file under
databases/. The live group data is "MORES-GROUP"; "TEST-SERVER" is a sandbox.
"""
import json
import os
import random
import re
import shutil
import sqlite3

from werkzeug.security import generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# All data lives in ONE dedicated folder, separate from the code, so it is easy
# to back up. Override with MORES_HV_DATA_DIR (e.g. a OneDrive/Drive-synced path).
# Default: <repo-root>/data  (the repo is inside OneDrive, so it auto-syncs).
DATA_DIR = os.environ.get("MORES_HV_DATA_DIR") or os.path.abspath(
    os.path.join(BASE_DIR, os.pardir, os.pardir, "data"))
DATABASES_DIR = DATA_DIR
LEGACY_DATABASES_DIR = os.path.join(BASE_DIR, "databases")  # previous multi-db location
LEGACY_DB_PATH = os.path.join(BASE_DIR, "erp.db")           # original single file
DEFAULT_DB = "MORES-GROUP"
SANDBOX_DB = "TEST-SERVER"
DB_PATH = LEGACY_DB_PATH  # kept for backward-compat references


def _safe_name(name):
    """Sanitise a database name to a safe display/file token."""
    name = re.sub(r"[^A-Za-z0-9 _-]", "", str(name or "")).strip()
    return name[:40]


def db_file(name):
    return os.path.join(DATABASES_DIR, _safe_name(name).replace(" ", "_") + ".db")


def list_databases():
    """Names of existing databases (default first), derived from the files."""
    if not os.path.isdir(DATABASES_DIR):
        return []
    names = []
    for fn in os.listdir(DATABASES_DIR):
        if fn.endswith(".db"):
            names.append(fn[:-3].replace("_", " "))
    names.sort(key=lambda n: (n != DEFAULT_DB, n.lower()))
    return names


DB_ROLES = ("admin", "finance", "viewer")
DEFAULT_DB_PROFILE = {
    "icon": "", "color": "#00a2b6", "frozen": False,
    "enter_roles": ["admin", "finance", "viewer"],
    "edit_roles": ["admin", "finance"],
}


def get_db_profile(conn):
    """Per-database profile (tile icon/colour, frozen flag, and which roles may
    enter / edit) stored in the database's own app_settings. Admin is always
    allowed. Missing/corrupt data falls back to the defaults."""
    prof = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULT_DB_PROFILE.items()}
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key='db_profile'").fetchone()
        if row and row["value"]:
            stored = json.loads(row["value"])
            if isinstance(stored, dict):
                for k in prof:
                    if k in stored and stored[k] is not None:
                        prof[k] = stored[k]
    except Exception:
        pass
    prof["frozen"] = bool(prof.get("frozen"))
    prof["icon"] = str(prof.get("icon") or "")[:8]
    prof["color"] = str(prof.get("color") or "#00a2b6")[:16]
    prof["enter_roles"] = [r for r in DB_ROLES if r in set(prof.get("enter_roles") or []) | {"admin"}]
    prof["edit_roles"] = [r for r in DB_ROLES if r in set(prof.get("edit_roles") or []) | {"admin"}]
    return prof


def set_db_profile(conn, updates):
    """Merge updates into the database's profile and persist it. Returns the
    saved profile. The app_settings table is created if it doesn't exist yet."""
    conn.execute("CREATE TABLE IF NOT EXISTS app_settings ("
                 "key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
    prof = get_db_profile(conn)
    for k in DEFAULT_DB_PROFILE:
        if k in updates and updates[k] is not None:
            prof[k] = updates[k]
    prof["frozen"] = bool(prof.get("frozen"))
    prof["icon"] = str(prof.get("icon") or "")[:8]
    prof["color"] = str(prof.get("color") or "#00a2b6")[:16]
    prof["enter_roles"] = [r for r in DB_ROLES if r in set(prof.get("enter_roles") or []) | {"admin"}]
    prof["edit_roles"] = [r for r in DB_ROLES if r in set(prof.get("edit_roles") or []) | {"admin"}]
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('db_profile', ?)"
                 " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(prof),))
    conn.commit()
    return prof

ACCOUNT_TYPES = ("asset", "liability", "equity", "revenue", "expense")

# Standard chart of accounts applied to every company (code, name, type, parent, intercompany)
STANDARD_COA = [
    ("1000", "Assets", "asset", None, 0),
    ("1100", "Cash & Bank", "asset", "1000", 0),
    ("1110", "Cash on Hand", "asset", "1100", 0),
    ("1120", "Bank Accounts", "asset", "1100", 0),
    ("1130", "Petty Cash Monit", "asset", "1100", 0),
    ("1200", "Accounts Receivable", "asset", "1000", 0),
    ("1300", "Inventory", "asset", "1000", 0),
    ("1400", "Prepaid Expenses", "asset", "1000", 0),
    ("1500", "Fixed Assets", "asset", "1000", 0),
    ("1510", "Accumulated Depreciation", "asset", "1500", 0),
    ("1900", "Intercompany Receivable", "asset", "1000", 1),
    ("2000", "Liabilities", "liability", None, 0),
    ("2100", "Accounts Payable", "liability", "2000", 0),
    ("2200", "Accrued Expenses", "liability", "2000", 0),
    ("2300", "Taxes Payable", "liability", "2000", 0),
    ("2500", "Bank Loans", "liability", "2000", 0),
    ("2900", "Intercompany Payable", "liability", "2000", 1),
    ("3000", "Equity", "equity", None, 0),
    ("3100", "Share Capital", "equity", "3000", 0),
    ("3200", "Retained Earnings", "equity", "3000", 0),
    # --- Revenue: exactly three lines -----------------------------------
    ("4000", "Revenue", "revenue", None, 0),
    ("4100", "Consulting Revenue", "revenue", "4000", 0),
    ("4200", "Contractor Revenue", "revenue", "4000", 0),
    ("4900", "Others Revenue", "revenue", "4000", 0),
    # --- COGS: one header with four clear states ------------------------
    ("5000", "Cost of Goods Sold (COGS)", "expense", None, 0),
    ("5100", "COGS", "expense", "5000", 0),
    ("5100-01", "Direct Labor / Consultant Fees", "expense", "5100", 0),
    ("5100-02", "Indirect Labor / Technical Support", "expense", "5100", 0),
    ("5100-03", "Material / Vendoring Materials", "expense", "5100", 0),
    ("5100-04", "Fixed / Misc Items", "expense", "5100", 0),
    # --- Operating expenses ---------------------------------------------
    ("6000", "Operating Expenses", "expense", None, 0),
    ("6100", "Salaries & Benefits", "expense", "6000", 0),
    ("6200", "Rent & Facilities", "expense", "6000", 0),
    ("6300", "Utilities & Communication", "expense", "6000", 0),
    ("6400", "Marketing & Promotion", "expense", "6000", 0),
    ("6500", "Depreciation Expense", "expense", "6000", 0),
    ("6600", "Office & Administration", "expense", "6000", 0),
    ("6610", "Bank Admin Fees (Biaya Admin Bank)", "expense", "6600", 0),
    ("6700", "Professional Fees", "expense", "6000", 0),
    ("6900", "Miscellaneous Expense", "expense", "6000", 0),
    ("7200", "Interest Expense", "expense", None, 0),
]

# Extra cost accounts that exist only in MDA (Consulting): the "C-AKUN" group (7300).
MDA_EXTRA_COA = [
    ("7300", "C-AKUN", "expense", None, 0),
    ("7300-01", "C-1 BDKR", "expense", "7300", 0),
    ("7300-02", "C-2 FRK", "expense", "7300", 0),
    ("7300-03", "C-NB", "expense", "7300", 0),
    ("7300-04", "C-SKWN", "expense", "7300", 0),
]

# Operating profile per entity: primary revenue account + how direct cost (COGS)
# splits across the four COGS states.
ENTITY_CFG = {
    "MDA":  {"rev": "4100", "cogs": [("5100-01", 0.7), ("5100-02", 0.3)]},   # consulting
    "SBR":  {"rev": "4900", "cogs": [("5100-01", 0.5), ("5100-03", 0.5)]},   # media / Mores NX
    "MLT":  {"rev": "4200", "cogs": [("5100-03", 0.6), ("5100-04", 0.2), ("5100-01", 0.2)]},  # construction
    "KMA":  {"rev": "4900", "cogs": [("5100-01", 0.5), ("5100-03", 0.5)]},   # media
    "MRS":  {"rev": "4100", "cogs": [("5100-01", 0.8), ("5100-02", 0.2)]},   # creative consulting
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','finance','viewer')),
    company_access TEXT NOT NULL DEFAULT 'all',
    menu_access TEXT NOT NULL DEFAULT 'all',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_holding INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER REFERENCES companies(id),
    currency TEXT NOT NULL DEFAULT 'IDR',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
    parent_code TEXT,
    is_intercompany INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','on_hold')),
    start_date TEXT,
    end_date TEXT,
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    entry_no TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
    source TEXT NOT NULL DEFAULT 'manual',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, entry_no)
);

CREATE TABLE IF NOT EXISTS journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    project_id INTEGER REFERENCES projects(id),
    description TEXT NOT NULL DEFAULT '',
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    project_id INTEGER REFERENCES projects(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    amount REAL NOT NULL DEFAULT 0,
    UNIQUE (company_id, account_id, project_id, year, month)
);

CREATE TABLE IF NOT EXISTS custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),
    entity TEXT NOT NULL CHECK (entity IN ('journal','project')),
    label TEXT NOT NULL,
    field_key TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date','select')),
    options TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS custom_field_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    UNIQUE (field_id, entity_id)
);

CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'strategic'
        CHECK (category IN ('scholarship','partnership','rnd','csr','strategic','other')),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','on_hold')),
    start_date TEXT,
    horizon_years INTEGER NOT NULL DEFAULT 3,
    committed_amount REAL NOT NULL DEFAULT 0,
    linked_project_id INTEGER REFERENCES projects(id),
    cm_pic_cost REAL NOT NULL DEFAULT 0,
    cm_other_cost REAL NOT NULL DEFAULT 0,
    cm_total_benefit REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investment_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('outflow','benefit')),
    description TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS receivables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    client TEXT NOT NULL DEFAULT '',
    invoice_no TEXT NOT NULL DEFAULT '',
    invoice_date TEXT,
    due_date TEXT,
    amount REAL NOT NULL DEFAULT 0,
    paid REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cash_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    year INTEGER NOT NULL,
    week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 52),
    cash_in REAL NOT NULL DEFAULT 0,
    cash_out REAL NOT NULL DEFAULT 0,
    UNIQUE (company_id, year, week)
);

CREATE TABLE IF NOT EXISTS payables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    vendor TEXT NOT NULL DEFAULT '',
    bill_no TEXT NOT NULL DEFAULT '',
    bill_date TEXT,
    due_date TEXT,
    amount REAL NOT NULL DEFAULT 0,
    paid REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_format_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    format_type TEXT NOT NULL DEFAULT 'csv',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_receivables_company ON receivables(company_id);
CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_lines_project ON journal_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_company_date ON journal_entries(company_id, date);
CREATE INDEX IF NOT EXISTS idx_budgets_lookup ON budgets(company_id, year);
"""


def get_db(name=None):
    """Open the named database (defaults to MORES-GROUP)."""
    path = db_file(name) if name else db_file(DEFAULT_DB)
    conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # wait up to 15s for a lock instead of failing instantly — matters when
    # several web workers run the startup migration on the same file at once
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def apply_standard_coa(conn, company_id):
    """Insert any missing standard accounts for a company. Returns number added."""
    added = 0
    for code, name, typ, parent, ic in STANDARD_COA:
        cur = conn.execute(
            "INSERT OR IGNORE INTO accounts (company_id, code, name, type, parent_code, is_intercompany)"
            " VALUES (?,?,?,?,?,?)",
            (company_id, code, name, typ, parent, ic),
        )
        added += cur.rowcount
    return added


def apply_mda_extra_coa(conn, company_id):
    """Insert the MDA-only C-AKUN (7300) cost accounts. Returns number added."""
    added = 0
    for code, name, typ, parent, ic in MDA_EXTRA_COA:
        cur = conn.execute(
            "INSERT OR IGNORE INTO accounts (company_id, code, name, type, parent_code, is_intercompany)"
            " VALUES (?,?,?,?,?,?)",
            (company_id, code, name, typ, parent, ic),
        )
        added += cur.rowcount
    return added


def account_id(conn, company_id, code):
    row = conn.execute(
        "SELECT id FROM accounts WHERE company_id=? AND code=?", (company_id, code)
    ).fetchone()
    return row["id"] if row else None


def _add_entry(conn, company_id, seq, date, description, lines, status="posted",
               reference="", source="manual"):
    """lines: list of (account_code, project_id, debit, credit)."""
    entry_no = "JV-%s-%04d" % (date[:7].replace("-", ""), seq)
    cur = conn.execute(
        "INSERT INTO journal_entries (company_id, entry_no, date, description, reference, status, source, created_by)"
        " VALUES (?,?,?,?,?,?,?,1)",
        (company_id, entry_no, date, description, reference, status, source),
    )
    entry_id = cur.lastrowid
    for code, project_id, debit, credit in lines:
        acc = account_id(conn, company_id, code)
        conn.execute(
            "INSERT INTO journal_lines (entry_id, account_id, project_id, description, debit, credit)"
            " VALUES (?,?,?,?,?,?)",
            (entry_id, acc, project_id, description, round(debit, 2), round(credit, 2)),
        )
    return entry_id


# Operating entities (code, name) — each is an independent company; no holding parent.
COMPANY_DEFS = [
    ("MDA", "MORES Data Analitika (Consulting)"),
    ("SBR", "Sibernetika MA (Mores NX)"),
    ("MLT", "Mores Lintas Teknika (Construction)"),
    ("KMA", "Kultura Media Antara"),
    ("MRS", "Modus Reform Studio"),
]

PROJECT_DEFS = {
    "MDA": [("PRJ-CDA", "Corporate Data Advisory"), ("PRJ-OJL", "OJL Engagement")],
    "SBR": [("PRJ-NX", "Mores NX Platform"), ("PRJ-LIC", "Media Licensing")],
    "MLT": [("PRJ-CDA-K", "CDA Construction"), ("PRJ-PRISMA", "Prisma Harapan Project")],
    "KMA": [("PRJ-KMA", "Cultural Media Production")],
    "MRS": [("PRJ-MRS", "Reform Studio Creative")],
}

# monthly revenue base per (company_code, project_code)
REVENUE_BASE = {
    ("MDA", "PRJ-CDA"): 600_000_000,
    ("MDA", "PRJ-OJL"): 400_000_000,
    ("SBR", "PRJ-NX"): 380_000_000,
    ("SBR", "PRJ-LIC"): 500_000_000,
    ("MLT", "PRJ-CDA-K"): 950_000_000,
    ("MLT", "PRJ-PRISMA"): 780_000_000,
    ("KMA", "PRJ-KMA"): 440_000_000,
    ("MRS", "PRJ-MRS"): 500_000_000,
}
PAYROLL_BASE = {"MDA": 220_000_000, "SBR": 160_000_000,
                "MLT": 280_000_000, "KMA": 120_000_000, "MRS": 140_000_000}
RENT_BASE = {"MDA": 60_000_000, "SBR": 40_000_000,
             "MLT": 55_000_000, "KMA": 30_000_000, "MRS": 35_000_000}
CAPITAL = {"MDA": 4_000_000_000, "SBR": 3_000_000_000,
           "MLT": 5_000_000_000, "KMA": 2_000_000_000, "MRS": 2_000_000_000}


def seed(conn):
    rng = random.Random(42)

    # --- users -------------------------------------------------------------
    users = [
        ("admin", "MoresMores2018", "System Administrator", "admin"),
        ("finance", "finance123", "Finance Manager", "finance"),
        ("viewer", "viewer123", "Report Viewer", "viewer"),
    ]
    for username, pw, full_name, role in users:
        conn.execute(
            "INSERT INTO users (username, password_hash, full_name, role, company_access) VALUES (?,?,?,?, 'all')",
            (username, generate_password_hash(pw), full_name, role),
        )

    # --- companies (independent operating entities; no holding parent) -------
    for code, name in COMPANY_DEFS:
        conn.execute(
            "INSERT INTO companies (code, name, currency) VALUES (?,?, 'IDR')",
            (code, name))
    companies = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM companies").fetchall()}
    for code, cid in companies.items():
        apply_standard_coa(conn, cid)
    apply_mda_extra_coa(conn, companies["MDA"])

    # --- projects -----------------------------------------------------------
    projects = {}  # (company_code, project_code) -> id
    for ccode, defs in PROJECT_DEFS.items():
        for pcode, pname in defs:
            cur = conn.execute(
                "INSERT INTO projects (company_id, code, name, status, start_date) VALUES (?,?,?,'active','2025-01-01')",
                (companies[ccode], pcode, pname))
            projects[(ccode, pcode)] = cur.lastrowid

    # --- custom fields -------------------------------------------------------
    conn.execute(
        "INSERT INTO custom_fields (company_id, entity, label, field_key, field_type, options)"
        " VALUES (NULL, 'project', 'Project Manager', 'project_manager', 'text', '')")
    conn.execute(
        "INSERT INTO custom_fields (company_id, entity, label, field_key, field_type, options)"
        " VALUES (NULL, 'project', 'Risk Level', 'risk_level', 'select', 'Low,Medium,High')")
    conn.execute(
        "INSERT INTO custom_fields (company_id, entity, label, field_key, field_type, options)"
        " VALUES (NULL, 'journal', 'Cost Center', 'cost_center', 'text', '')")

    # --- opening capital (Jan 2025) ------------------------------------------
    for ccode, amount in CAPITAL.items():
        _add_entry(conn, companies[ccode], 1, "2025-01-02",
                   "Opening share capital injection",
                   [("1120", None, amount, 0), ("3100", None, 0, amount)])

    months = [(2025, m) for m in range(1, 13)] + [(2026, m) for m in range(1, 6)]

    for ccode, cid in companies.items():
        cfg = ENTITY_CFG[ccode]
        rev_code = cfg["rev"]
        seq = 10
        for (year, month) in months:
            growth = 1.0 + 0.015 * months.index((year, month))
            d = lambda day: "%04d-%02d-%02d" % (year, month, day)

            for (pc_code, pcode), base in REVENUE_BASE.items():
                if pc_code != ccode:
                    continue
                pid = projects[(ccode, pcode)]
                rev = base * growth * rng.uniform(0.85, 1.18)
                _add_entry(conn, cid, seq, d(8), "Invoice %s %04d-%02d" % (pcode, year, month),
                           [("1200", pid, rev, 0), (rev_code, pid, 0, rev)])
                seq += 1
                collected = rev * rng.uniform(0.75, 0.98)
                _add_entry(conn, cid, seq, d(22), "Customer payment %s" % pcode,
                           [("1120", pid, collected, 0), ("1200", pid, 0, collected)])
                seq += 1
                # direct cost (COGS) split across the four states per entity profile;
                # last split line is a plug so debits sum exactly to the credit
                cost = round(rev * rng.uniform(0.38, 0.50), 2)
                lines, allocated = [], 0.0
                for i, (code, w) in enumerate(cfg["cogs"]):
                    amt = round(cost - allocated, 2) if i == len(cfg["cogs"]) - 1 else round(cost * w, 2)
                    allocated = round(allocated + amt, 2)
                    lines.append((code, pid, amt, 0))
                lines.append(("2100", pid, 0, cost))
                _add_entry(conn, cid, seq, d(15), "Direct cost %s" % pcode, lines)
                seq += 1
                paid = cost * rng.uniform(0.70, 0.95)
                _add_entry(conn, cid, seq, d(27), "Supplier payment %s" % pcode,
                           [("2100", pid, paid, 0), ("1120", pid, 0, paid)])
                seq += 1

            pay = PAYROLL_BASE[ccode] * growth * rng.uniform(0.97, 1.05)
            _add_entry(conn, cid, seq, d(25), "Monthly payroll",
                       [("6100", None, pay, 0), ("1120", None, 0, pay)])
            seq += 1
            _add_entry(conn, cid, seq, d(1), "Office rent",
                       [("6200", None, RENT_BASE[ccode], 0), ("1120", None, 0, RENT_BASE[ccode])])
            seq += 1
            util = RENT_BASE[ccode] * 0.25 * rng.uniform(0.8, 1.3)
            _add_entry(conn, cid, seq, d(18), "Utilities & internet",
                       [("6300", None, util, 0), ("1120", None, 0, util)])
            seq += 1
            mkt = (70_000_000 if ccode in ("SBR", "KMA") else 25_000_000) * rng.uniform(0.6, 1.4)
            _add_entry(conn, cid, seq, d(12), "Marketing campaigns",
                       [("6400", None, mkt, 0), ("1120", None, 0, mkt)])
            seq += 1
            adm = 25_000_000 * rng.uniform(0.7, 1.3)
            _add_entry(conn, cid, seq, d(20), "Office & administration",
                       [("6600", None, adm, 0), ("1120", None, 0, adm)])
            seq += 1

            # MDA (Consulting) C-AKUN cost spending (7300 group)
            if ccode == "MDA":
                cакun = [("7300-01", 60_000_000), ("7300-02", 45_000_000),
                         ("7300-03", 35_000_000), ("7300-04", 30_000_000)]
                lines, total = [], 0.0
                for code, amt in cакun:
                    a = round(amt * growth * rng.uniform(0.8, 1.2), 2)
                    lines.append((code, None, a, 0))
                    total = round(total + a, 2)
                lines.append(("1120", None, 0, total))
                _add_entry(conn, cid, seq, d(10), "C-AKUN cost accounts", lines)
                seq += 1

    # --- budgets for 2026 (company-level + project-level) --------------------
    seed_company_budgets(conn, companies)
    seed_project_budgets(conn, companies, projects)
    seed_investments(conn)
    conn.commit()


def seed_company_budgets(conn, companies):
    """Annual 2026 budgets per entity: primary revenue + key opex lines."""
    for ccode, cid in companies.items():
        cfg = ENTITY_CFG[ccode]
        rev_base = sum(b for (cc, _), b in REVENUE_BASE.items() if cc == ccode) or 100_000_000
        plan = {
            cfg["rev"]: rev_base * 12 / 12 * 1.1,            # revenue target / month
            cfg["cogs"][0][0]: rev_base * 0.30,              # COGS budget (entity's primary cost line)
            "6100": PAYROLL_BASE[ccode] * 1.05,
            "6200": RENT_BASE[ccode],
            "6400": (70_000_000 if ccode in ("SBR", "KMA") else 25_000_000),
            "6600": 25_000_000,
        }
        for code, monthly in plan.items():
            acc = account_id(conn, cid, code)
            if not acc:
                continue
            for month in range(1, 13):
                ramp = 1.0 + 0.01 * month if code == cfg["rev"] else 1.0
                upsert_budget(conn, cid, acc, None, 2026, month, round(monthly * ramp, 2))


def seed_project_budgets(conn, companies, projects):
    """2026 per-project budgets (revenue target + direct cost cap)."""
    for (ccode, pcode), base in REVENUE_BASE.items():
        cid = companies[ccode]
        pid = projects[(ccode, pcode)]
        rev_code = ENTITY_CFG[ccode]["rev"]
        cogs_code = ENTITY_CFG[ccode]["cogs"][0][0]  # entity's primary COGS child
        for code, factor in ((rev_code, 1.15), (cogs_code, 0.30)):
            acc = account_id(conn, cid, code)
            if not acc:
                continue
            for month in range(1, 13):
                upsert_budget(conn, cid, acc, pid, 2026, month, round(base * factor, 2))


def upsert_budget(conn, company_id, account_id, project_id, year, month, amount):
    """NULL-safe budget upsert."""
    cur = conn.execute(
        "UPDATE budgets SET amount=? WHERE company_id=? AND account_id=?"
        " AND project_id IS ? AND year=? AND month=?",
        (round(amount, 2), company_id, account_id, project_id, year, month))
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO budgets (company_id, account_id, project_id, year, month, amount)"
            " VALUES (?,?,?,?,?,?)",
            (company_id, account_id, project_id, year, month, round(amount, 2)))


def seed_investments(conn):
    """Demo strategic investments (only when the table is empty)."""
    if conn.execute("SELECT COUNT(*) FROM investments").fetchone()[0]:
        return 0
    companies = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM companies")}
    projects = {}
    for r in conn.execute(
            "SELECT p.id, p.code, c.code AS ccode FROM projects p JOIN companies c ON c.id=p.company_id"):
        projects[(r["ccode"], r["code"])] = r["id"]
    if "MDA" not in companies:
        return 0
    demo = [
        {
            "company": "MDA", "name": "Scholarship Program - Future Leaders",
            "category": "scholarship", "status": "active", "start": "2025-03-01",
            "horizon": 5, "committed": 1_200_000_000, "project": ("MDA", "PRJ-CDA"),
            "description": "Scholarships for consultancy-track scholars; alumni host future "
                           "event talks and refer engagement opportunities.",
            "events": [
                ("2025-03-15", "outflow", "Scholarship batch 1 (4 awardees)", 200_000_000),
                ("2025-09-15", "outflow", "Scholarship batch 2 (4 awardees)", 200_000_000),
                ("2026-03-15", "outflow", "Scholarship batch 3 (5 awardees)", 250_000_000),
                ("2026-02-10", "benefit", "Alumni event talk led to advisory engagement", 250_000_000),
                ("2026-05-20", "benefit", "Referred consulting project won", 400_000_000),
            ],
        },
        {
            "company": "SBR", "name": "R&D - Mores NX Platform",
            "category": "rnd", "status": "active", "start": "2025-06-01",
            "horizon": 3, "committed": 800_000_000, "project": ("SBR", "PRJ-NX"),
            "description": "Internal platform R&D reused across media/licensing engagements.",
            "events": [
                ("2025-06-30", "outflow", "R&D sprint wave 1", 150_000_000),
                ("2025-10-31", "outflow", "R&D sprint wave 2", 150_000_000),
                ("2026-02-28", "outflow", "R&D sprint wave 3", 150_000_000),
                ("2026-04-30", "benefit", "Platform reuse licensed in NX delivery", 300_000_000),
            ],
        },
        {
            "company": "MDA", "name": "University Partnership Sponsorship",
            "category": "partnership", "status": "active", "start": "2025-08-01",
            "horizon": 2, "committed": 300_000_000, "project": None,
            "description": "Sponsorship of industry lab; pipeline for talks and junior talent.",
            "events": [
                ("2025-08-15", "outflow", "Annual sponsorship 2025/2026", 100_000_000),
                ("2026-04-15", "benefit", "Guest-lecture series converted to paid workshop", 150_000_000),
            ],
        },
    ]
    for inv in demo:
        pid = projects.get(inv["project"]) if inv["project"] else None
        cur = conn.execute(
            "INSERT INTO investments (company_id, name, category, description, status,"
            " start_date, horizon_years, committed_amount, linked_project_id)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (companies[inv["company"]], inv["name"], inv["category"], inv["description"],
             inv["status"], inv["start"], inv["horizon"], inv["committed"], pid))
        for date, kind, desc, amount in inv["events"]:
            conn.execute(
                "INSERT INTO investment_events (investment_id, date, kind, description, amount)"
                " VALUES (?,?,?,?,?)", (cur.lastrowid, date, kind, desc, amount))
    conn.commit()
    return len(demo)


def _init_one(name, do_seed):
    """Create schema (and optionally seed) for a single named database."""
    conn = get_db(name)
    conn.executescript(SCHEMA)
    if do_seed:
        seed(conn)
    seed_investments(conn)
    conn.commit()
    conn.close()


def create_database(name, seed_demo=True):
    """Create a brand-new database. Returns the cleaned name. Raises ValueError."""
    clean = _safe_name(name)
    if not clean:
        raise ValueError("Database name is required")
    if clean in list_databases():
        raise ValueError("A database named '%s' already exists" % clean)
    os.makedirs(DATABASES_DIR, exist_ok=True)
    _init_one(clean, seed_demo)
    return clean


def delete_database(name):
    """Delete a database file. Refuses to remove the default group database."""
    clean = _safe_name(name)
    if clean == DEFAULT_DB:
        raise ValueError("The %s database cannot be deleted" % DEFAULT_DB)
    path = db_file(clean)
    if not os.path.exists(path):
        raise ValueError("Database '%s' not found" % clean)
    os.remove(path)
    return clean


def remove_holding(conn):
    """Idempotent migration: drop the legacy 'MORES Holding' (HOLD) entity and
    all of its own books, leaving only the independent operating companies.

    Strategic investments that were booked under the holding are reassigned to
    MDA (fallback: any remaining company) so the Investments module keeps them;
    only the holding's own accounts, projects, journals and budgets are removed.
    Returns True if a holding entity was found and removed.
    """
    row = conn.execute("SELECT id FROM companies WHERE code='HOLD'").fetchone()
    if not row:
        return False
    hid = row["id"]
    # keep strategic investments — move them to MDA (or the next available company)
    keep = (conn.execute("SELECT id FROM companies WHERE code='MDA'").fetchone()
            or conn.execute("SELECT id FROM companies WHERE id<>? ORDER BY id LIMIT 1",
                            (hid,)).fetchone())
    if keep:
        conn.execute("UPDATE investments SET company_id=? WHERE company_id=?", (keep["id"], hid))
    delete_company_cascade(conn, hid)
    return True


def delete_company_cascade(conn, company_id):
    """Permanently delete a company and ALL of its data — accounts, projects,
    journal entries & lines, budgets, investments and custom fields. Any other
    company that pointed at it as a parent is detached. Order respects FKs."""
    cid = company_id
    conn.execute("UPDATE companies SET parent_id=NULL WHERE parent_id=?", (cid,))
    conn.execute("DELETE FROM investment_events WHERE investment_id IN "
                 "(SELECT id FROM investments WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM investments WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM receivables WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM payables WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM cash_budget WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM journal_lines WHERE entry_id IN "
                 "(SELECT id FROM journal_entries WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM journal_entries WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM budgets WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM custom_field_values WHERE field_id IN "
                 "(SELECT id FROM custom_fields WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM custom_fields WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM projects WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM accounts WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM companies WHERE id=?", (cid,))
    conn.commit()


def _ensure_source_column(conn):
    """Add journal_entries.source on pre-existing databases and backfill it from
    the reference/description left behind by earlier imports. Idempotent."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(journal_entries)")]
    if "source" in cols:
        return
    conn.execute("ALTER TABLE journal_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    # best-effort backfill from the reference prefixes / descriptions earlier
    # imports left behind (everything else stays 'manual')
    conn.execute("UPDATE journal_entries SET source='bca_csv' WHERE reference LIKE 'CSV-%'")
    conn.execute("UPDATE journal_entries SET source='bca_pdf' WHERE reference LIKE 'PDF-%'")
    conn.execute("UPDATE journal_entries SET source='monit_wallet' WHERE source='manual' AND reference LIKE 'WLT-%'")
    conn.execute(
        "UPDATE journal_entries SET source='monit_wallet' WHERE source='manual' AND "
        "(lower(description) LIKE '%monit%' OR lower(description) LIKE '%wallet%' "
        " OR lower(description) LIKE '%petty cash%')")
    conn.commit()


def _add_column(conn, table, column, decl):
    """Idempotently add a column to an existing table (additive migration)."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    if column not in cols:
        conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))


def migrate_database(conn):
    """Bring a single database to the current schema/data baseline. Idempotent —
    safe to run on every database on every startup."""
    _ensure_source_column(conn)
    conn.execute("CREATE TABLE IF NOT EXISTS app_settings ("
                 "key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS receivables ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "client TEXT NOT NULL DEFAULT '', invoice_no TEXT NOT NULL DEFAULT '',"
        "invoice_date TEXT, due_date TEXT, amount REAL NOT NULL DEFAULT 0,"
        "paid REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cash_budget ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "year INTEGER NOT NULL, week INTEGER NOT NULL,"
        "cash_in REAL NOT NULL DEFAULT 0, cash_out REAL NOT NULL DEFAULT 0,"
        "UNIQUE (company_id, year, week))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS payables ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "vendor TEXT NOT NULL DEFAULT '', bill_no TEXT NOT NULL DEFAULT '',"
        "bill_date TEXT, due_date TEXT, amount REAL NOT NULL DEFAULT 0,"
        "paid REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS bank_format_profiles ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,"
        "format_type TEXT NOT NULL DEFAULT 'csv', config_json TEXT NOT NULL DEFAULT '{}',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (name))")
    # per-user menu visibility (which left-nav items a user may see); 'all' = every menu
    _add_column(conn, "users", "menu_access", "TEXT NOT NULL DEFAULT 'all'")
    # Investment Center — contribution-margin manual inputs per investment
    for col in ("cm_pic_cost", "cm_other_cost", "cm_total_benefit"):
        _add_column(conn, "investments", col, "REAL NOT NULL DEFAULT 0")
    # Investment Center — per-user discussion comments
    conn.execute(
        "CREATE TABLE IF NOT EXISTS investment_comments ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,"
        "author TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    # drop the legacy holding first so the COA top-up only touches survivors
    remove_holding(conn)
    for r in conn.execute("SELECT id FROM companies").fetchall():
        apply_standard_coa(conn, r["id"])
    conn.commit()


def init_db(force=False):
    """Set up the data directory, migrate any older database locations into it
    (preserving all data), and ensure the TEST-SERVER sandbox."""
    os.makedirs(DATABASES_DIR, exist_ok=True)
    group_path = db_file(DEFAULT_DB)

    # migration 1: move every *.db from the previous apps/erp/databases/ folder
    # into the new dedicated data folder (skip files that already exist there)
    if os.path.normpath(LEGACY_DATABASES_DIR) != os.path.normpath(DATABASES_DIR) \
            and os.path.isdir(LEGACY_DATABASES_DIR):
        for fn in os.listdir(LEGACY_DATABASES_DIR):
            if fn.endswith(".db"):
                dest = os.path.join(DATABASES_DIR, fn)
                if not os.path.exists(dest):
                    shutil.move(os.path.join(LEGACY_DATABASES_DIR, fn), dest)

    # migration 2: original single erp.db -> MORES-GROUP.db
    if os.path.exists(LEGACY_DB_PATH) and not os.path.exists(group_path):
        shutil.move(LEGACY_DB_PATH, group_path)

    # ensure the group database exists & is schema-current (seed only if brand new)
    is_new = not os.path.exists(group_path)
    _init_one(DEFAULT_DB, do_seed=is_new)

    # ensure the sandbox exists (fresh demo data)
    if not os.path.exists(db_file(SANDBOX_DB)):
        _init_one(SANDBOX_DB, do_seed=True)

    # bring EVERY database up to the current baseline (idempotent): new standard
    # accounts (e.g. Petty Cash Monit, Bank Admin Fees), the journal-entry source
    # column + backfill, and removal of the legacy holding entity
    for name in list_databases():
        c = get_db(name)
        try:
            migrate_database(c)
        finally:
            c.close()
    return is_new


if __name__ == "__main__":
    import sys
    if "--force" in sys.argv:
        # reseed a specific db: python database.py --force [NAME]
        target = next((a for a in sys.argv[1:] if not a.startswith("-")), DEFAULT_DB)
        p = db_file(target)
        if os.path.exists(p):
            os.remove(p)
        create_database(target)
        print("Reseeded database:", target)
    else:
        seeded = init_db()
        print("Databases ready in", DATABASES_DIR, "->", list_databases())
