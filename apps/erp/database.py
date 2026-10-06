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
    # data_as_of: the date the figures in this database are complete TO. A ledger
    # that stops in July is not the same claim as a ledger that is current, and
    # every report drawn off it should say which one it is.
    "icon": "", "color": "#00a2b6", "frozen": False, "data_as_of": "",
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
    prof["data_as_of"] = str(prof.get("data_as_of") or "")[:10]
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
    prof["data_as_of"] = str(prof.get("data_as_of") or "")[:10]
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
    ("1170", "CC BCA VISA CARD", "asset", "1100", 0),
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
    cash_flow_class TEXT NOT NULL DEFAULT '',
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
    week INTEGER NOT NULL DEFAULT 1 CHECK (week BETWEEN 1 AND 4),
    amount REAL NOT NULL DEFAULT 0,
    certainty TEXT NOT NULL DEFAULT 'planned'
        CHECK (certainty IN ('committed','planned','expected','speculative')),
    cf_class TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (company_id, account_id, project_id, year, month, week)
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

CREATE TABLE IF NOT EXISTS investment_commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),
    amount REAL NOT NULL DEFAULT 0,
    certainty TEXT NOT NULL DEFAULT 'committed',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ic_inv ON investment_commitments(investment_id, year);

CREATE TABLE IF NOT EXISTS investment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('outflow','benefit')),
    description TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0
);

-- What an investment promised to deliver, so progress is tracked rather than
-- guessed from how much money has left. Weighted: 'pilot done' and 'rolled out
-- everywhere' are not the same fraction of the job.
CREATE TABLE IF NOT EXISTS investment_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    done_at TEXT,
    weight REAL NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
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
    paid_date TEXT,
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

CREATE TABLE IF NOT EXISTS plan_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),   -- NULL = group-wide
    year INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'budget',
    status TEXT NOT NULL DEFAULT 'draft',
    base_version_id INTEGER REFERENCES plan_versions(id),
    oracle_verdict TEXT NOT NULL DEFAULT '',
    oracle_consulted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The cash plan at (year, month, week-in-month) grain. No UNIQUE involving
-- project_id: SQLite treats NULLs as distinct, so a unique index would not stop
-- duplicate group-level rows. Write through the NULL-safe upsert instead.
CREATE TABLE IF NOT EXISTS plan_weeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    project_id INTEGER REFERENCES projects(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),  -- 4 in use; 5 folded into 4
    flow TEXT NOT NULL CHECK (flow IN ('in','out')),
    amount REAL NOT NULL DEFAULT 0,
    certainty TEXT NOT NULL DEFAULT 'planned',
    cf_class TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pw_version ON plan_weeks(version_id, company_id, year, month);
CREATE INDEX IF NOT EXISTS idx_pw_project ON plan_weeks(version_id, project_id);

CREATE TABLE IF NOT EXISTS money_tracker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    project_id INTEGER REFERENCES projects(id),
    title TEXT NOT NULL DEFAULT '',
    invoice_no TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    phase_key TEXT NOT NULL DEFAULT 'p1',
    -- status is validated in server.MONEY_STATUSES (prospectus/active/done/
    -- on_hold/cancelled). Deliberately no CHECK: SQLite cannot widen one without
    -- rebuilding the table, and this list grows.
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    cancel_reason TEXT NOT NULL DEFAULT '',
    is_hot INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS money_tracker_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES money_tracker(id) ON DELETE CASCADE,
    phase_key TEXT NOT NULL,
    plan_days INTEGER NOT NULL DEFAULT 0,
    entered_at TEXT,
    completed_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- discussion on an invoice track: phase_key '' = general, otherwise per-phase
CREATE TABLE IF NOT EXISTS money_tracker_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES money_tracker(id) ON DELETE CASCADE,
    phase_key TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_receivables_company ON receivables(company_id);
CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_lines_project ON journal_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_company_date ON journal_entries(company_id, date);
CREATE INDEX IF NOT EXISTS idx_budgets_lookup ON budgets(company_id, year, month, week);
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
    seed_mock_extras(conn, companies, projects)
    conn.commit()


def seed_company_budgets(conn, companies):
    """Annual 2026 company-level budgets: OVERHEADS ONLY.

    Revenue and direct cost are budgeted per project (seed_project_budgets), and
    budgeting the same account at both levels would have the Oracle count the
    money twice - a company-level line is spending that belongs to no project,
    not a summary of the projects.

    Week placement is deliberate rather than decorative, because settlement is
    pessimistic: an outflow leaves on the FIRST day of its week bucket. Rent is
    due at the start of the month (W1), payroll at the end (W4).
    """
    week_of = {"6100": 4, "6200": 1, "6400": 2, "6600": 3}
    for ccode, cid in companies.items():
        plan = {
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
                upsert_budget(conn, cid, acc, None, 2026, month, round(monthly, 2),
                              week=week_of.get(code, 1), certainty="planned",
                              cf_class="operating")


def seed_project_budgets(conn, companies, projects):
    """2026 per-project budgets: revenue target + direct cost cap.

    Certainty is what makes this demo worth looking at. The Oracle's Bound run
    counts only 'committed' money IN, so a budget that is 100% 'planned' reads
    KRITIS no matter how healthy it is. Here the first three quarters are under
    contract and Q4 is not, which is what a real consulting year looks like -
    and it leaves the verdict somewhere a user can then stress.

    Collections land mid-month (W3); direct cost is paid earlier (W2), so the
    money goes out before it comes in inside the same month.
    """
    for (ccode, pcode), base in REVENUE_BASE.items():
        cid = companies[ccode]
        pid = projects[(ccode, pcode)]
        rev_code = ENTITY_CFG[ccode]["rev"]
        cogs_code = ENTITY_CFG[ccode]["cogs"][0][0]  # entity's primary COGS child
        # 0.55 direct cost: what a consulting + construction group actually runs at.
        # It also matters for the demo - at 0.30 the year threw off so much cash
        # that no amount of stress could move the verdict, and a sensitivity grid
        # that is green in every cell teaches nobody anything.
        for code, factor, week, cls in ((rev_code, 1.15, 3, "operating"),
                                        (cogs_code, 0.55, 2, "operating")):
            acc = account_id(conn, cid, code)
            if not acc:
                continue
            for month in range(1, 13):
                certainty = "planned"
                if code == rev_code:
                    certainty = "committed" if month <= 9 else "expected"
                upsert_budget(conn, cid, acc, pid, 2026, month,
                              round(base * factor, 2), week=week,
                              certainty=certainty, cf_class=cls)


def upsert_budget(conn, company_id, account_id, project_id, year, month, amount,
                  week=1, certainty=None, cf_class=None, note=None,
                  default_certainty=None):
    """NULL-safe budget upsert at week grain.

    NULL-safe because project_id is nullable and SQLite treats NULLs as DISTINCT
    in a UNIQUE index - a plain INSERT OR REPLACE would duplicate every
    company-level row instead of updating it. Passing None for certainty /
    cf_class / note leaves whatever is already stored alone, so a plain amount
    edit never silently resets a line's certainty. default_certainty is used only
    when a cell has to be CREATED - typing a figure into an empty week of a line
    that is otherwise contracted should not quietly produce uncontracted money.
    """
    sets = ["amount=?"]
    params = [round(amount, 2)]
    if certainty is not None:
        sets.append("certainty=?"); params.append(certainty)
    if cf_class is not None:
        sets.append("cf_class=?"); params.append(cf_class)
    if note is not None:
        sets.append("note=?"); params.append(note)
    cur = conn.execute(
        "UPDATE budgets SET %s WHERE company_id=? AND account_id=?"
        " AND project_id IS ? AND year=? AND month=? AND week=?" % ", ".join(sets),
        params + [company_id, account_id, project_id, year, month, week])
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO budgets (company_id, account_id, project_id, year, month, week,"
            " amount, certainty, cf_class, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (company_id, account_id, project_id, year, month, week, round(amount, 2),
             certainty or default_certainty or "planned", cf_class or "", note or ""))


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


PRODUCT_DDL = (
    "CREATE TABLE IF NOT EXISTS products ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "company_id INTEGER NOT NULL REFERENCES companies(id),"
    "code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,"
    "stage TEXT NOT NULL DEFAULT 'build',"
    "launch_month TEXT, actual_through TEXT, horizon_end TEXT, target_year INTEGER,"
    "burn_budget REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',"
    "assumptions TEXT NOT NULL DEFAULT '{}', sort INTEGER NOT NULL DEFAULT 0,"
    "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS product_projects ("
    "product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,"
    "project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,"
    "PRIMARY KEY (product_id, project_id))",
    "CREATE TABLE IF NOT EXISTS product_cost_lines ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,"
    "label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'other',"
    "monthly_amount REAL NOT NULL DEFAULT 0, basis TEXT NOT NULL DEFAULT 'fixed',"
    "start_month TEXT, end_month TEXT, escalation_annual REAL NOT NULL DEFAULT 0,"
    "sort INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS product_oneoffs ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,"
    "month TEXT NOT NULL, flow TEXT NOT NULL DEFAULT 'out' CHECK (flow IN ('in','out')),"
    "label TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS product_capex ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,"
    "month TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',"
    "amount REAL NOT NULL DEFAULT 0, life_months INTEGER NOT NULL DEFAULT 48)",
    "CREATE INDEX IF NOT EXISTS idx_pcl_product ON product_cost_lines(product_id)",
    "CREATE INDEX IF NOT EXISTS idx_pp_project ON product_projects(project_id)",
)


def ensure_product_tables(conn):
    """Product Finance Analysis tables. Additive and idempotent: nothing that
    already exists is touched."""
    for ddl in PRODUCT_DDL:
        conn.execute(ddl)
    # the SBU finance report's own settings (targets, SaaS actuals, project
    # tracker notes, director actions) - JSON on the SBU row, so an Excel model
    # import, which replaces lines and projects, can never wipe it
    _add_column(conn, "products", "report", "TEXT NOT NULL DEFAULT '{}'")
    # (v1.11) the painted scene that stands for the SBU when no picture is uploaded
    _add_column(conn, "products", "art", "TEXT")
    # (v1.11) what kind of SBU it is - SaaS / Event Based (INTEL) / Media Owned
    # (Creative) / SEAL - SECTIONS (server.SBU_TYPES); blank = not typed yet
    _add_column(conn, "products", "sbu_type", "TEXT")


GRAB_ACCOUNT_NAME = "CORP PAY - GRAB"

# the starting list of project types (sectors); renamed, recoloured or removed in Settings
DEFAULT_PROJECT_TYPES = (
    ("Infrastructure", "#c87a08"), ("Consulting & Research", "#00a2b6"),
    ("Technology & SaaS", "#6b46e5"), ("Media & Advertising", "#bd362f"),
    ("Event & Creative", "#1f9d57"), ("Other", "#5b6b80"),
)


def ensure_grab_account(conn, company_id):
    """The cash-side account Grab for Business bookings are charged to.

    Grab bills the company later, so every ride or order is money out of this
    account; paying Grab's invoice from the bank brings it back to zero. It sits
    under 1100 Cash & Bank at the first free code from 1160. Idempotent: an
    account already carrying the name is returned as it is."""
    row = conn.execute(
        "SELECT * FROM accounts WHERE company_id=? AND UPPER(TRIM(name))=?",
        (company_id, GRAB_ACCOUNT_NAME)).fetchone()
    if row:
        return row
    taken = {r[0] for r in conn.execute("SELECT code FROM accounts WHERE company_id=?", (company_id,))}
    code = next(c for c in ["1160", "1180", "1190"] + ["11%02d" % n for n in range(61, 100)]
                if c not in taken)
    parent = "1100" if "1100" in taken else None
    conn.execute("INSERT INTO accounts (company_id, code, name, type, parent_code)"
                 " VALUES (?,?,?,'asset',?)", (company_id, code, GRAB_ACCOUNT_NAME, parent))
    return conn.execute("SELECT * FROM accounts WHERE company_id=? AND code=?",
                        (company_id, code)).fetchone()


def apply_product_template(conn, product_id, template, company_ids=None, link_code=None):
    """Replace a product's drivers with a template, optionally linking a project
    by code. Returns the linked project id, or None."""
    import product_fa
    tpl = {"nx01": product_fa.NX01_TEMPLATE}.get(template)
    if not tpl:
        raise ValueError("Unknown product template '%s'" % template)
    conn.execute(
        "UPDATE products SET assumptions=?, launch_month=COALESCE(launch_month, ?),"
        " target_year=COALESCE(target_year, ?) WHERE id=?",
        (json.dumps(tpl["assumptions"]), tpl["launch_month"], tpl["target_year"], product_id))
    for t in ("product_cost_lines", "product_oneoffs", "product_capex"):
        conn.execute("DELETE FROM %s WHERE product_id=?" % t, (product_id,))
    for i, (label, cat, amt, basis, start, end) in enumerate(tpl["lines"]):
        conn.execute(
            "INSERT INTO product_cost_lines (product_id, label, category, monthly_amount, basis,"
            " start_month, end_month, sort) VALUES (?,?,?,?,?,?,?,?)",
            (product_id, label, cat, amt, basis, start, end, i))
    for month, flow, label, amt in tpl["oneoffs"]:
        conn.execute("INSERT INTO product_oneoffs (product_id, month, flow, label, amount)"
                     " VALUES (?,?,?,?,?)", (product_id, month, flow, label, amt))
    for month, label, amt, life in tpl["capex"]:
        conn.execute("INSERT INTO product_capex (product_id, month, label, amount, life_months)"
                     " VALUES (?,?,?,?,?)", (product_id, month, label, amt, life))
    linked = None
    if link_code:
        q = "SELECT id FROM projects WHERE code=?"
        params = [link_code]
        if company_ids:
            q += " AND company_id IN (%s)" % ",".join("?" * len(company_ids))
            params += list(company_ids)
        row = conn.execute(q, params).fetchone()
        if row:
            linked = row[0]
            conn.execute("INSERT OR IGNORE INTO product_projects (product_id, project_id)"
                         " VALUES (?,?)", (product_id, linked))
    return linked


def seed_mock_extras(conn, companies, projects):
    """Fill in the modules the original demo seed never knew about, so a fresh
    demo database can exercise the whole app rather than just the ledger:
    receivables, payables, investment commitments, the money tracker, and a
    buffer policy with a real minimum cash per company.
    """
    rng = random.Random(7)
    inv_ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM investments")}

    # --- receivables: some collected, some not, a couple with no paid date ---
    clients = ["Dinas Kominfo Prov.", "PT Nusantara Andalan", "Badan Riset Nasional",
               "PT Cipta Karya Mandiri", "Yayasan Pendidikan Bangsa"]
    n = 0
    for ccode, cid in companies.items():
        for k in range(3):
            n += 1
            amount = round(rng.uniform(180, 900) * 1_000_000, 2)
            month = 2 + k * 3
            paid = 0.0 if k == 2 else round(amount * rng.uniform(0.4, 1.0), 2)
            # a paid date on most of them: the Oracle only has to GUESS collection
            # timing where one is missing, and two missing is enough to show that
            paid_date = None
            if paid > 0 and n % 5 != 0:
                paid_date = "2026-%02d-%02d" % (month, rng.randint(20, 28))
            conn.execute(
                "INSERT INTO receivables (company_id, client, invoice_no, invoice_date,"
                " due_date, amount, paid, paid_date, notes) VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, clients[n % len(clients)], "INV-2026-%03d" % n,
                 "2026-%02d-05" % month, "2026-%02d-05" % min(12, month + 1),
                 amount, paid, paid_date, ""))

    # --- payables: dated bills the Oracle must treat as committed outflows ---
    vendors = ["CV Sumber Rejeki", "PT Media Cetak Nusantara", "PT Logistik Andalan",
               "CV Karya Teknik", "PT Solusi Digital"]
    n = 0
    for ccode, cid in companies.items():
        for k in range(2):
            n += 1
            amount = round(rng.uniform(90, 420) * 1_000_000, 2)
            month = 3 + k * 4
            conn.execute(
                "INSERT INTO payables (company_id, vendor, bill_no, bill_date, due_date,"
                " amount, paid, notes) VALUES (?,?,?,?,?,?,?,?)",
                (cid, vendors[n % len(vendors)], "BILL-2026-%03d" % n,
                 "2026-%02d-02" % month, "2026-%02d-25" % month, amount,
                 round(amount * 0.3, 2) if k == 0 else 0.0, ""))

    # --- investment commitments: most scheduled, one left deliberately not ---
    # The unscheduled remainder is the point: it makes the Oracle say out loud
    # that it had to assume a date, which is the behaviour worth demonstrating.
    sched = {"Scholarship Program - Future Leaders": [(3, 2, 0.25), (6, 1, 0.25), (9, 3, 0.20)],
             "R&D - Mores NX Platform": [(4, 1, 0.5), (10, 2, 0.3)]}
    # University Partnership Sponsorship is left with NO schedule on purpose, so
    # the Oracle has to spread it and say so - the assumption is the lesson.
    for name, parts in sched.items():
        iid = inv_ids.get(name)
        if not iid:
            continue
        total = conn.execute("SELECT committed_amount FROM investments WHERE id=?",
                             (iid,)).fetchone()[0] or 0
        for month, week, share in parts:
            conn.execute(
                "INSERT INTO investment_commitments (investment_id, year, month, week,"
                " amount, certainty, note) VALUES (?,?,?,?,?,?,?)",
                (iid, 2026, month, week, round(total * share, 2), "committed",
                 "demo schedule"))

    # --- money tracker: one of every interesting state ----------------------
    tracks = [
        ("Videotron Kominfo 2026", "Dinas Kominfo Prov.", 1_250_000_000, "p11", "active", 0),
        ("Data Advisory Retainer", "PT Nusantara Andalan", 640_000_000, "p3", "active", 0),
        ("Riset Kebijakan Publik", "Badan Riset Nasional", 880_000_000, "p2", "prospectus", 1),
        ("Renovasi Gedung B", "PT Cipta Karya Mandiri", 2_100_000_000, "p7", "active", 1),
        ("Kampanye Literasi", "Yayasan Pendidikan Bangsa", 310_000_000, "p12", "done", 0),
        ("Sistem Arsip Digital", "PT Solusi Digital", 470_000_000, "p5a", "on_hold", 0),
    ]
    ccodes = list(companies.keys())
    for i, (title, client, amount, phase, status, hot) in enumerate(tracks):
        ccode = ccodes[i % len(ccodes)]
        cur = conn.execute(
            "INSERT INTO money_tracker (company_id, project_id, title, invoice_no, client,"
            " amount, phase_key, status, started_at, notes, is_hot)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (companies[ccode], None, title, "MT-2026-%03d" % (i + 1), client, amount,
             phase, status, "2026-%02d-10" % (1 + i), "", hot))
        conn.execute(
            "INSERT INTO money_tracker_stages (tracker_id, phase_key, entered_at)"
            " VALUES (?,?,?)", (cur.lastrowid, phase, "2026-%02d-10" % (1 + i)))

    # --- a buffer policy with a real floor, not the useless default of zero --
    floors = {ccode: round(PAYROLL_BASE[ccode] * 1.5, 2) for ccode in companies}
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('oracle_buffer_policy', ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps({"months_cover": 1.5, "cash_pooling": False,
                     "default_collection_lag_days": 14,
                     "absolute_floor": floors}),))

    # --- a product to judge: the NX-01 model from the planning workbook ------
    # Not linked to a ledger project on purpose - the demo ledger has no NX-01,
    # so every month is plan and the analysis reads as a pure forecast.
    ensure_product_tables(conn)
    owner = companies.get("SBR") or next(iter(companies.values()))
    cur = conn.execute(
        "INSERT INTO products (company_id, code, name, stage, launch_month, target_year,"
        " burn_budget, notes) VALUES (?,?,?,?,?,?,?,?)",
        (owner, "SBU-01", "Sentimind — Media Monitoring (demo)", "launch", "2026-01", 2027,
         3000000000, "Drivers taken from NX Plan Analysis 2026-2027, tab 05 Budget Forecast."))
    apply_product_template(conn, cur.lastrowid, "nx01")
    conn.commit()


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
    conn.execute("DELETE FROM investment_commitments WHERE investment_id IN "
                 "(SELECT id FROM investments WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM investments WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM receivables WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM payables WHERE company_id=?", (cid,))
    conn.execute("DELETE FROM money_tracker_stages WHERE tracker_id IN "
                 "(SELECT id FROM money_tracker WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM money_tracker_comments WHERE tracker_id IN "
                 "(SELECT id FROM money_tracker WHERE company_id=?)", (cid,))
    conn.execute("DELETE FROM money_tracker WHERE company_id=?", (cid,))
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


def _widen_budgets_to_weeks(conn):
    """Move the budget from month grain to week grain.

    A monthly budget tells you WHICH MONTH and never which week, so every
    existing row lands in WEEK 1 rather than being spread across four - spreading
    would invent timing information nobody ever entered, and W1 is also the
    safest reading for cash (money out as early as it could go). This is the
    "convert the monthly budget into Week 1" step, applied once, automatically.

    SQLite cannot alter a UNIQUE constraint, so the table is rebuilt. Ids are
    carried over unchanged. The swap only happens when BOTH the row count and
    the total budgeted amount match the original exactly; on any mismatch the
    whole thing rolls back and the original table survives untouched.
    """
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(budgets)")]
    if not cols or "week" in cols:
        return                                    # absent, or already week grain
    before_n = conn.execute("SELECT COUNT(*) FROM budgets").fetchone()[0]
    before_sum = conn.execute("SELECT COALESCE(SUM(amount),0) FROM budgets").fetchone()[0]
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.execute("DROP TABLE IF EXISTS budgets__new")
        conn.execute(
            "CREATE TABLE budgets__new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "company_id INTEGER NOT NULL REFERENCES companies(id),"
            "account_id INTEGER NOT NULL REFERENCES accounts(id),"
            "project_id INTEGER REFERENCES projects(id),"
            "year INTEGER NOT NULL,"
            "month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),"
            "week INTEGER NOT NULL DEFAULT 1 CHECK (week BETWEEN 1 AND 4),"
            "amount REAL NOT NULL DEFAULT 0,"
            "certainty TEXT NOT NULL DEFAULT 'planned'"
            " CHECK (certainty IN ('committed','planned','expected','speculative')),"
            "cf_class TEXT NOT NULL DEFAULT '',"
            "note TEXT NOT NULL DEFAULT '',"
            "UNIQUE (company_id, account_id, project_id, year, month, week))")
        conn.execute(
            "INSERT INTO budgets__new"
            " (id, company_id, account_id, project_id, year, month, week, amount)"
            " SELECT id, company_id, account_id, project_id, year, month, 1, amount"
            " FROM budgets")
        after_n = conn.execute("SELECT COUNT(*) FROM budgets__new").fetchone()[0]
        after_sum = conn.execute("SELECT COALESCE(SUM(amount),0) FROM budgets__new").fetchone()[0]
        if after_n != before_n or round(after_sum, 2) != round(before_sum, 2):
            raise RuntimeError(
                "budgets rebuild copied %d of %d rows and %.2f of %.2f budgeted"
                " - refusing to swap" % (after_n, before_n, after_sum, before_sum))
        conn.execute("DROP TABLE budgets")
        conn.execute("ALTER TABLE budgets__new RENAME TO budgets")
        # DROP TABLE took idx_budgets_lookup with it, and the CREATE INDEX IF NOT
        # EXISTS in SCHEMA never re-runs on an existing database - so it has to be
        # rebuilt here or every budget read silently falls back to a table scan.
        # Widened past (company_id, year) because the Oracle now reads this table
        # on every consult, month and week included.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_budgets_lookup"
                     " ON budgets(company_id, year, month, week)")
        conn.commit()
    except Exception:
        conn.rollback()
        conn.execute("DROP TABLE IF EXISTS budgets__new")
        conn.commit()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def _widen_money_tracker_status(conn):
    """Drop the legacy CHECK on money_tracker.status so PROSPECTUS is accepted.

    SQLite has no ALTER ... DROP CONSTRAINT, so the table is rebuilt. Ids are
    carried over unchanged, so money_tracker_stages / money_tracker_comments keep
    pointing at the right rows. The swap only happens when the copied row count
    matches the original exactly; otherwise everything rolls back untouched.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='money_tracker'").fetchone()
    if not row or not row["sql"]:
        return
    sql = row["sql"]
    if "CHECK" not in sql.upper() or "prospectus" in sql:
        return  # already fine
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(money_tracker)")]
    collist = ", ".join(cols)
    before = conn.execute("SELECT COUNT(*) FROM money_tracker").fetchone()[0]
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.execute("DROP TABLE IF EXISTS money_tracker__new")
        conn.execute(
            "CREATE TABLE money_tracker__new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "company_id INTEGER NOT NULL REFERENCES companies(id),"
            "project_id INTEGER REFERENCES projects(id),"
            "title TEXT NOT NULL DEFAULT '', invoice_no TEXT NOT NULL DEFAULT '',"
            "client TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0,"
            "phase_key TEXT NOT NULL DEFAULT 'p1', status TEXT NOT NULL DEFAULT 'active',"
            "started_at TEXT, notes TEXT NOT NULL DEFAULT '',"
            "cancel_reason TEXT NOT NULL DEFAULT '', is_hot INTEGER NOT NULL DEFAULT 0,"
            "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
        conn.execute("INSERT INTO money_tracker__new (%s) SELECT %s FROM money_tracker"
                     % (collist, collist))
        after = conn.execute("SELECT COUNT(*) FROM money_tracker__new").fetchone()[0]
        if after != before:
            raise RuntimeError("money_tracker rebuild copied %d of %d rows" % (after, before))
        conn.execute("DROP TABLE money_tracker")
        conn.execute("ALTER TABLE money_tracker__new RENAME TO money_tracker")
        conn.commit()
    except Exception:
        conn.rollback()
        conn.execute("DROP TABLE IF EXISTS money_tracker__new")
        conn.commit()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


# ---- Oracle Step 1: cash-flow classification -------------------------------
# Which section of the cash-flow statement an account belongs to. Getting 6500
# Depreciation or 1510 Accumulated Depreciation wrong makes the Oracle
# OPTIMISTIC, which is the one direction it must never fail in - so they are
# 'noncash' and contribute nothing to CFO.
#
# Seeded idempotently: only rows still at '' are set, so an admin override in
# Settings -> Cash Flow Classes always survives a restart.
CASH_FLOW_CLASSES = ("operating", "investing", "financing", "noncash")
CASH_FLOW_CLASS_SEED = {
    # --- working capital and trading: operating -----------------------------
    "1200": "operating", "1300": "operating", "1400": "operating",
    "2100": "operating", "2200": "operating", "2300": "operating",
    "4000": "operating", "4100": "operating", "4200": "operating", "4900": "operating",
    "5000": "operating", "5100": "operating",
    "5100-01": "operating", "5100-02": "operating",
    "5100-03": "operating", "5100-04": "operating",
    "6000": "operating", "6100": "operating", "6200": "operating",
    "6300": "operating", "6400": "operating", "6600": "operating",
    "6610": "operating", "6700": "operating", "6900": "operating",
    "7200": "operating",   # interest — policy default, see oracle_buffer_policy
    "7300": "operating", "7300-01": "operating", "7300-02": "operating",
    "7300-03": "operating", "7300-04": "operating",
    # --- capex: investing ---------------------------------------------------
    "1500": "investing",
    # --- funding: financing -------------------------------------------------
    "2500": "financing", "3000": "financing", "3100": "financing", "3200": "financing",
    # --- never moves cash ---------------------------------------------------
    "6500": "noncash",     # depreciation expense
    "1510": "noncash",     # accumulated depreciation
}


def seed_cash_flow_classes(conn):
    """Set cash_flow_class on accounts that have never been classified.
    Idempotent, and admin overrides survive because only '' rows are touched."""
    for code, cls in CASH_FLOW_CLASS_SEED.items():
        conn.execute(
            "UPDATE accounts SET cash_flow_class=? WHERE code=? AND cash_flow_class=''",
            (cls, code))


def upsert_plan_week(conn, version_id, company_id, project_id, account_id,
                    year, month, week, flow, amount, certainty="planned",
                    cf_class="", note=""):
    """NULL-safe upsert for a cash-plan cell.

    plan_weeks deliberately has no UNIQUE touching project_id, because SQLite
    treats NULLs as distinct and a unique index would happily store the same
    group-level cell twice. `IS ?` matches NULL to NULL, so a group-level row
    updates in place instead of duplicating (test W4).
    """
    cur = conn.execute(
        "UPDATE plan_weeks SET amount=?, certainty=?, cf_class=?, note=? "
        "WHERE version_id=? AND company_id=? AND account_id=? AND project_id IS ? "
        "AND year=? AND month=? AND week=? AND flow=?",
        (amount, certainty, cf_class, note, version_id, company_id, account_id,
         project_id, year, month, week, flow))
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO plan_weeks (version_id, company_id, project_id, account_id,"
            " year, month, week, flow, amount, certainty, cf_class, note)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (version_id, company_id, project_id, account_id, year, month, week,
             flow, amount, certainty, cf_class, note))
    return cur.rowcount


def _fold_week5_into_week4(conn):
    """The cash plan moved from 5 buckets a month to 4 (W4 now runs to month end).

    Any surviving week-5 row can no longer be given a settlement date, so the
    Oracle would drop it SILENTLY - money that is in the plan but not in the
    forecast. Fold it into week 4 instead: add to the matching W4 cell where one
    exists, otherwise just move it. Idempotent, and no amount is ever lost.
    """
    for table, keys in (
            ("plan_weeks",
             "version_id, company_id, project_id, account_id, year, month, flow"),
            ("investment_commitments",
             "investment_id, year, month, certainty")):
        try:
            rows = conn.execute("SELECT * FROM %s WHERE week=5" % table).fetchall()
        except Exception:
            continue
        if not rows:
            continue
        key_cols = [k.strip() for k in keys.split(",")]
        for r in rows:
            where = " AND ".join("%s IS ?" % k for k in key_cols)
            params = [r[k] for k in key_cols]
            match = conn.execute(
                "SELECT id, amount FROM %s WHERE %s AND week=4 LIMIT 1" % (table, where),
                params).fetchone()
            if match:
                conn.execute("UPDATE %s SET amount=? WHERE id=?" % table,
                             (round((match["amount"] or 0) + (r["amount"] or 0), 2),
                              match["id"]))
                conn.execute("DELETE FROM %s WHERE id=?" % table, (r["id"],))
            else:
                conn.execute("UPDATE %s SET week=4 WHERE id=?" % table, (r["id"],))
    conn.commit()


def _add_column(conn, table, column, decl):
    """Idempotently add a column to an existing table (additive migration)."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    if column not in cols:
        conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))


def _ensure_menu_routes(conn, routes):
    """Give every restricted menu the routes listed here.

    A user granted an explicit list of menus keeps that exact list forever, so a
    section added later is invisible to them and looks like a permissions bug —
    the BOD account could not open the Oracle or SBU for that reason.
    """
    for r in conn.execute("SELECT id, menu_access FROM users").fetchall():
        val = (r["menu_access"] or "all").strip()
        if val in ("", "all"):
            continue
        have = {x.strip() for x in val.split(",") if x.strip()}
        merged = have | set(routes)
        if merged != have:
            conn.execute("UPDATE users SET menu_access=? WHERE id=?",
                         (",".join(sorted(merged)), r["id"]))


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
    # Money Tracker — per-project invoicing pipeline (13 phases)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS money_tracker ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "project_id INTEGER REFERENCES projects(id),"
        "title TEXT NOT NULL DEFAULT '', invoice_no TEXT NOT NULL DEFAULT '',"
        "client TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0,"
        "phase_key TEXT NOT NULL DEFAULT 'p1', status TEXT NOT NULL DEFAULT 'active',"
        "started_at TEXT, notes TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS money_tracker_stages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "tracker_id INTEGER NOT NULL REFERENCES money_tracker(id) ON DELETE CASCADE,"
        "phase_key TEXT NOT NULL, plan_days INTEGER NOT NULL DEFAULT 0,"
        "entered_at TEXT, completed_at TEXT, notes TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS money_tracker_comments ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "tracker_id INTEGER NOT NULL REFERENCES money_tracker(id) ON DELETE CASCADE,"
        "phase_key TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',"
        "body TEXT NOT NULL DEFAULT '',"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    # why a track was put on hold / cancelled
    _add_column(conn, "money_tracker", "cancel_reason", "TEXT NOT NULL DEFAULT ''")
    # a prospectus track can be flagged HOT (worth chasing now)
    _add_column(conn, "money_tracker", "is_hot", "INTEGER NOT NULL DEFAULT 0")
    _widen_money_tracker_status(conn)
    _widen_budgets_to_weeks(conn)
    # ---- Oracle Step 1: how each account moves cash ----------------------
    _add_column(conn, "accounts", "cash_flow_class", "TEXT NOT NULL DEFAULT ''")
    seed_cash_flow_classes(conn)
    # ---- Oracle Step 2: the week-grain cash plan -------------------------
    conn.execute(
        "CREATE TABLE IF NOT EXISTS plan_versions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "company_id INTEGER REFERENCES companies(id),"   # NULL = group-wide
        "year INTEGER NOT NULL, name TEXT NOT NULL,"
        "kind TEXT NOT NULL DEFAULT 'budget',"
        "status TEXT NOT NULL DEFAULT 'draft',"
        "base_version_id INTEGER REFERENCES plan_versions(id),"
        "oracle_verdict TEXT NOT NULL DEFAULT '', oracle_consulted_at TEXT,"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS plan_weeks ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "version_id INTEGER NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "project_id INTEGER REFERENCES projects(id),"
        "account_id INTEGER NOT NULL REFERENCES accounts(id),"
        "year INTEGER NOT NULL,"
        "month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),"
        "week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),"
        "flow TEXT NOT NULL CHECK (flow IN ('in','out')),"
        "amount REAL NOT NULL DEFAULT 0,"
        "certainty TEXT NOT NULL DEFAULT 'planned',"
        "cf_class TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '')")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pw_version "
                 "ON plan_weeks(version_id, company_id, year, month)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pw_project "
                 "ON plan_weeks(version_id, project_id)")
    # ---- Oracle Step 4: WHEN committed investment money leaves ------------
    # investments.committed_amount is a lump sum with no schedule, and
    # investment_events only records what already moved, so without this the
    # Oracle cannot see committed investment outflows coming.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS investment_commitments ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,"
        "year INTEGER NOT NULL,"
        "month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),"
        "week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 5),"
        "amount REAL NOT NULL DEFAULT 0,"
        "certainty TEXT NOT NULL DEFAULT 'committed',"
        "note TEXT NOT NULL DEFAULT '')")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ic_inv "
                 "ON investment_commitments(investment_id, year)")
    # when a receivable was actually collected -> the real client lag
    _add_column(conn, "receivables", "paid_date", "TEXT")
    # 5 buckets a month -> 4: nothing may be stranded in a week that no longer exists
    _fold_week5_into_week4(conn)
    # what the project was sold for - the contract number finance quotes, which
    # is not the same as the revenue budget and not derivable from the ledger
    _add_column(conn, "projects", "contract_value", "REAL NOT NULL DEFAULT 0")
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
    # Investment Center (v1.09) - milestones behind the progress figure
    conn.execute(
        "CREATE TABLE IF NOT EXISTS investment_milestones ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,"
        "title TEXT NOT NULL DEFAULT '', due_date TEXT, done_at TEXT,"
        "weight REAL NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_im_inv "
                 "ON investment_milestones(investment_id, sort)")
    # Grab for Business (v1.10) - who took which ride or order, kept beside the
    # journal it was booked as. The ledger holds the money; this holds the
    # person, the service and the route, which the Expense Breakdown reads.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS grab_transactions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,"
        "company_id INTEGER NOT NULL REFERENCES companies(id),"
        "booking_id TEXT NOT NULL DEFAULT '', service TEXT NOT NULL DEFAULT '',"
        "service_type TEXT NOT NULL DEFAULT '', employee TEXT NOT NULL DEFAULT '',"
        "employee_group TEXT NOT NULL DEFAULT '', employee_email TEXT NOT NULL DEFAULT '',"
        "time TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',"
        "pickup TEXT NOT NULL DEFAULT '', dropoff TEXT NOT NULL DEFAULT '',"
        "merchant TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '',"
        "cost_code TEXT NOT NULL DEFAULT '', trip_description TEXT NOT NULL DEFAULT '',"
        "amount REAL NOT NULL DEFAULT 0, tips REAL NOT NULL DEFAULT 0,"
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_grab_entry ON grab_transactions(entry_id)")
    # the MORES entity Grab bills (PT MORES DATA ANALITIK) gets its account now;
    # any other company gets one the first time it imports a Grab report
    for r in conn.execute("SELECT id FROM companies WHERE code='MDA'").fetchall():
        ensure_grab_account(conn, r["id"])
    # (v1.10) a picture for an SBU or an investment initiative, shown beside its
    # name in the lists. Stored in the database it belongs to, so switching
    # databases and backups carry it; one row per entity, replaced on upload.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS entity_images ("
        "kind TEXT NOT NULL, entity_id INTEGER NOT NULL,"
        "mime TEXT NOT NULL, data BLOB NOT NULL,"
        "updated_at TEXT NOT NULL DEFAULT (datetime('now')),"
        "PRIMARY KEY (kind, entity_id))")
    # (v1.11) project types: the sector a project belongs to, managed in Settings
    # and flaggable from the Money Tracker. The starting list is written ONCE -
    # a flag remembers it, so a list the user empties stays empty.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_types ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
        "color TEXT NOT NULL DEFAULT '#00a2b6',"
        "sort INTEGER NOT NULL DEFAULT 0,"
        "is_active INTEGER NOT NULL DEFAULT 1)")
    if not conn.execute("SELECT 1 FROM app_settings WHERE key='project_types_seeded'").fetchone():
        if not conn.execute("SELECT COUNT(*) FROM project_types").fetchone()[0]:
            for i, (name, color) in enumerate(DEFAULT_PROJECT_TYPES):
                conn.execute("INSERT INTO project_types (name, color, sort) VALUES (?,?,?)", (name, color, i))
        conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('project_types_seeded', '1')")
    _add_column(conn, "projects", "type_id", "INTEGER REFERENCES project_types(id)")
    # a prospect tracked before it has a project carries its own sector flag
    _add_column(conn, "money_tracker", "type_id", "INTEGER REFERENCES project_types(id)")
    # (v1.11) a journal line - and an Oracle scenario row - can be charged to an
    # investment instead of a project; the Account Parsing and journal screens
    # offer both, and a line carries one or the other, never both
    _add_column(conn, "journal_lines", "investment_id", "INTEGER REFERENCES investments(id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jl_investment ON journal_lines(investment_id)")
    _add_column(conn, "plan_weeks", "investment_id", "INTEGER REFERENCES investments(id)")
    # a starred (HOT) investment is pinned to the top of the CEO dashboard
    _add_column(conn, "investments", "is_hot", "INTEGER NOT NULL DEFAULT 0")
    # the painted scene that stands for an initiative when no picture is uploaded
    _add_column(conn, "investments", "art", "TEXT")
    # ... and for a project (Project Details) and an invoice track (Money Tracker)
    _add_column(conn, "projects", "art", "TEXT")
    _add_column(conn, "money_tracker", "art", "TEXT")
    # sections added after a user's menu was set must still reach them
    _ensure_menu_routes(conn, ("oracle", "product", "expenses"))
    # Product Finance Analysis (v1.08)
    ensure_product_tables(conn)
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
