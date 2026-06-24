"""MORES ERP - Flask application: auth, REST API, Excel endpoints, static SPA."""
import functools
import json
import os
import secrets
from datetime import datetime, timedelta

from flask import (Flask, g, jsonify, redirect, request, send_file,
                   send_from_directory, session)
from werkzeug.security import check_password_hash, generate_password_hash

import bank_import
import database
import excel_io
import pdf_export
import reports

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SECRET_FILE = os.path.join(BASE_DIR, ".secret_key")

app = Flask(__name__, static_folder=None)

if os.path.exists(SECRET_FILE):
    app.secret_key = open(SECRET_FILE).read().strip()
else:
    app.secret_key = secrets.token_hex(32)
    with open(SECRET_FILE, "w") as f:
        f.write(app.secret_key)

app.permanent_session_lifetime = timedelta(days=30)  # "Remember me" duration

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# where a journal entry came from (shown in the detailed trial balance)
ENTRY_SOURCES = {"manual", "bca_bank", "bca_csv", "bca_pdf", "monit_wallet", "excel"}


# --------------------------------------------------------------------------
# DB / auth plumbing
# --------------------------------------------------------------------------

def active_db_name():
    """The database the current session is working in (defaults to the group)."""
    name = session.get("active_db") or database.DEFAULT_DB
    if name not in database.list_databases():
        name = database.DEFAULT_DB
    return name


def db():
    if "db" not in g:
        g.db = database.get_db(active_db_name())
    return g.db


@app.teardown_appcontext
def close_db(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return db().execute(
        "SELECT * FROM users WHERE id=? AND is_active=1", (uid,)).fetchone()


def login_required(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return jsonify({"error": "Authentication required"}), 401
        g.user = user
        return fn(*args, **kwargs)
    return wrapper


def role_required(*roles):
    def deco(fn):
        @functools.wraps(fn)
        @login_required
        def wrapper(*args, **kwargs):
            if g.user["role"] not in roles:
                return jsonify({"error": "Insufficient permissions"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return deco


def accessible_company_ids():
    """All active company ids the current user may see."""
    rows = db().execute("SELECT id FROM companies WHERE is_active=1").fetchall()
    all_ids = [r["id"] for r in rows]
    access = g.user["company_access"]
    if access == "all":
        return all_ids
    allowed = {int(x) for x in access.split(",") if x.strip().isdigit()}
    return [i for i in all_ids if i in allowed]


def scope_from_request():
    """Resolve ?company_id= (int or 'all') to (ids, label). Raises ValueError."""
    cid = request.args.get("company_id", "all")
    allowed = accessible_company_ids()
    if cid in ("all", "", None):
        if not allowed:
            raise ValueError("No accessible companies")
        if len(allowed) == 1:
            row = db().execute("SELECT name FROM companies WHERE id=?", (allowed[0],)).fetchone()
            return allowed, row["name"]
        return allowed, "Consolidated (all companies)"
    cid = int(cid)
    if cid not in allowed:
        raise ValueError("Company not accessible")
    row = db().execute("SELECT name FROM companies WHERE id=?", (cid,)).fetchone()
    return [cid], row["name"]


def check_company_access(company_id):
    if int(company_id) not in accessible_company_ids():
        raise ValueError("Company not accessible")


def project_in_company(project_id, company_id):
    """Return the project row, or raise if it doesn't belong to the company."""
    row = db().execute(
        "SELECT id, code, name, company_id FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row or row["company_id"] != company_id:
        raise ValueError("Project does not belong to this company")
    return row


def year_param(default=2026):
    try:
        return int(request.args.get("year", default))
    except (TypeError, ValueError):
        return default


def _valid_date(s):
    try:
        datetime.strptime(s or "", "%Y-%m-%d")
        return True
    except ValueError:
        return False


def date_range_from_request():
    """(date_from, date_to) — explicit ?date_from/?date_to win, else year/months."""
    df, dt = request.args.get("date_from", ""), request.args.get("date_to", "")
    if df or dt:
        if not (_valid_date(df) and _valid_date(dt)):
            raise ValueError("Dates must be in YYYY-MM-DD format")
        if df > dt:
            raise ValueError("'From' date is after 'To' date")
        return df, dt
    y = year_param()
    m_from = int(request.args.get("month_from", 1))
    m_to = int(request.args.get("month_to", 12))
    return "%04d-%02d-01" % (y, m_from), "%04d-%02d-31" % (y, m_to)


def as_of_from_request():
    as_of = request.args.get("as_of", "")
    if as_of:
        if not _valid_date(as_of):
            raise ValueError("'As of' date must be YYYY-MM-DD")
        return as_of
    return "%04d-%02d-31" % (year_param(), int(request.args.get("month", 12)))


@app.errorhandler(ValueError)
def on_value_error(e):
    return jsonify({"error": str(e)}), 400


# --------------------------------------------------------------------------
# Static pages
# --------------------------------------------------------------------------

@app.get("/")
def index():
    # Public landing page (login is a popup; "Enter Console" -> /app).
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/app")
def console():
    if not session.get("user_id"):
        return redirect("/")
    return send_from_directory(STATIC_DIR, "app.html")


@app.get("/databases")
def database_picker():
    # Post-login database chooser: pick a data store, then enter the console.
    if not session.get("user_id"):
        return redirect("/")
    return send_from_directory(STATIC_DIR, "databases.html")


@app.get("/login")
def login_page():
    # Standalone full-page login; the landing popup is the primary entry.
    if session.get("user_id"):
        return redirect("/databases")
    return send_from_directory(STATIC_DIR, "login.html")


@app.get("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    session["active_db"] = database.DEFAULT_DB  # always sign in to the group database
    g.pop("db", None)
    user = db().execute(
        "SELECT * FROM users WHERE username=? AND is_active=1",
        (data.get("username", "").strip(),)).fetchone()
    if user is None or not check_password_hash(user["password_hash"], data.get("password", "")):
        return jsonify({"error": "Invalid username or password"}), 401
    session["user_id"] = user["id"]
    session.permanent = bool(data.get("remember"))  # keep me signed in for 30 days
    return jsonify({"ok": True})


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
@login_required
def api_me():
    ids = accessible_company_ids()
    companies = [dict(r) for r in db().execute(
        "SELECT id, code, name, is_holding, parent_id, currency FROM companies"
        " WHERE is_active=1 AND id IN (%s) ORDER BY is_holding DESC, code"
        % ",".join("?" * len(ids)), ids)] if ids else []
    return jsonify({
        "id": g.user["id"], "username": g.user["username"],
        "full_name": g.user["full_name"], "role": g.user["role"],
        "companies": companies,
        "active_db": active_db_name(),
        "databases": database.list_databases() if g.user["role"] == "admin" else [],
    })


# --------------------------------------------------------------------------
# Companies
# --------------------------------------------------------------------------

@app.get("/api/companies")
@login_required
def list_companies():
    # admins can request the full list (incl. inactive) for management screens
    if request.args.get("include_inactive") and g.user["role"] == "admin":
        rows = db().execute(
            "SELECT * FROM companies ORDER BY is_holding DESC, is_active DESC, code").fetchall()
        return jsonify([dict(r) for r in rows])
    ids = accessible_company_ids()
    if not ids:
        return jsonify([])
    rows = db().execute(
        "SELECT * FROM companies WHERE id IN (%s) ORDER BY is_holding DESC, code"
        % ",".join("?" * len(ids)), ids).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/companies")
@role_required("admin")
def create_company():
    d = request.get_json(force=True)
    if not d.get("code") or not d.get("name"):
        raise ValueError("Code and name are required")
    cur = db().execute(
        "INSERT INTO companies (code, name, is_holding, parent_id, currency) VALUES (?,?,?,?,?)",
        (d["code"].strip().upper(), d["name"].strip(), 1 if d.get("is_holding") else 0,
         d.get("parent_id") or None, d.get("currency", "IDR")))
    cid = cur.lastrowid
    if d.get("apply_standard_coa", True):
        database.apply_standard_coa(db(), cid)
    db().commit()
    return jsonify({"id": cid}), 201


@app.put("/api/companies/<int:cid>")
@role_required("admin")
def update_company(cid):
    d = request.get_json(force=True)
    db().execute(
        "UPDATE companies SET name=?, is_holding=?, parent_id=?, currency=?, is_active=? WHERE id=?",
        (d["name"], 1 if d.get("is_holding") else 0, d.get("parent_id") or None,
         d.get("currency", "IDR"), 1 if d.get("is_active", True) else 0, cid))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/companies/<int:cid>")
@role_required("admin")
def delete_company(cid):
    # admins manage every company (like create/update) — incl. inactive ones —
    # so no accessible-only check here; just guard against emptying the database
    row = db().execute("SELECT id, code, name FROM companies WHERE id=?", (cid,)).fetchone()
    if not row:
        raise ValueError("Company not found")
    if db().execute("SELECT COUNT(*) FROM companies").fetchone()[0] <= 1:
        raise ValueError("Cannot delete the only remaining company")
    database.delete_company_cascade(db(), cid)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Chart of accounts
# --------------------------------------------------------------------------

@app.get("/api/accounts")
@login_required
def list_accounts():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    rows = db().execute(
        "SELECT * FROM accounts WHERE company_id=? ORDER BY code", (company_id,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/accounts")
@role_required("admin", "finance")
def create_account():
    d = request.get_json(force=True)
    check_company_access(d["company_id"])
    if d.get("type") not in database.ACCOUNT_TYPES:
        raise ValueError("Invalid account type")
    if not d.get("code") or not d.get("name"):
        raise ValueError("Code and name are required")
    code = d["code"].strip()
    if code.count("-") > 2:
        raise ValueError("Maximum 3 levels: e.g. 5100, 5100-01, 5100-01-01")
    # derivative accounts: 5100-01-01 -> parent 5100-01 (auto, unless given)
    parent = d.get("parent_code") or (code.rsplit("-", 1)[0] if "-" in code else None)
    if "-" in code:
        exists = db().execute(
            "SELECT 1 FROM accounts WHERE company_id=? AND code=?",
            (d["company_id"], parent)).fetchone()
        if not exists:
            raise ValueError("Parent account %s does not exist — create it first" % parent)
    cur = db().execute(
        "INSERT INTO accounts (company_id, code, name, type, parent_code, is_intercompany)"
        " VALUES (?,?,?,?,?,?)",
        (d["company_id"], code, d["name"].strip(), d["type"],
         parent, 1 if d.get("is_intercompany") else 0))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/accounts/<int:aid>")
@role_required("admin", "finance")
def update_account(aid):
    row = db().execute("SELECT company_id FROM accounts WHERE id=?", (aid,)).fetchone()
    if not row:
        raise ValueError("Account not found")
    check_company_access(row["company_id"])
    d = request.get_json(force=True)
    db().execute(
        "UPDATE accounts SET name=?, type=?, parent_code=?, is_intercompany=?, is_active=? WHERE id=?",
        (d["name"], d["type"], d.get("parent_code") or None,
         1 if d.get("is_intercompany") else 0, 1 if d.get("is_active", True) else 0, aid))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/accounts/<int:aid>")
@role_required("admin", "finance")
def delete_account(aid):
    row = db().execute("SELECT company_id FROM accounts WHERE id=?", (aid,)).fetchone()
    if not row:
        raise ValueError("Account not found")
    check_company_access(row["company_id"])
    used = db().execute(
        "SELECT COUNT(*) AS n FROM journal_lines WHERE account_id=?", (aid,)).fetchone()["n"]
    budgeted = db().execute(
        "SELECT COUNT(*) AS n FROM budgets WHERE account_id=?", (aid,)).fetchone()["n"]
    if used or budgeted:
        raise ValueError("Account has transactions or budgets — deactivate it instead")
    db().execute("DELETE FROM accounts WHERE id=?", (aid,))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/accounts/apply-standard")
@role_required("admin", "finance")
def apply_standard():
    d = request.get_json(force=True)
    check_company_access(d["company_id"])
    added = database.apply_standard_coa(db(), d["company_id"])
    db().commit()
    return jsonify({"added": added})


@app.post("/api/accounts/apply-standard-all")
@role_required("admin")
def apply_standard_all():
    """Apply the standard chart of accounts to EVERY company so the COA — and
    the intercompany accounts (1900/2900) — line up across the group."""
    rows = db().execute("SELECT id, code FROM companies ORDER BY code").fetchall()
    result, total = [], 0
    for r in rows:
        added = database.apply_standard_coa(db(), r["id"])
        total += added
        result.append({"code": r["code"], "added": added})
    db().commit()
    return jsonify({"companies": result, "total_added": total})


# --------------------------------------------------------------------------
# Projects
# --------------------------------------------------------------------------

@app.get("/api/projects")
@login_required
def list_projects():
    ids, _ = scope_from_request()
    rows = db().execute(
        """SELECT p.*, c.code AS company_code, c.name AS company_name
           FROM projects p JOIN companies c ON c.id = p.company_id
           WHERE p.company_id IN (%s) ORDER BY c.code, p.code""" % ",".join("?" * len(ids)),
        ids).fetchall()
    out = [dict(r) for r in rows]
    _attach_custom_values(out, "project")
    return jsonify(out)


@app.post("/api/projects")
@role_required("admin", "finance")
def create_project():
    d = request.get_json(force=True)
    check_company_access(d["company_id"])
    if not d.get("code") or not d.get("name"):
        raise ValueError("Code and name are required")
    cur = db().execute(
        "INSERT INTO projects (company_id, code, name, status, start_date, end_date, description)"
        " VALUES (?,?,?,?,?,?,?)",
        (d["company_id"], d["code"].strip(), d["name"].strip(),
         d.get("status", "active"), d.get("start_date") or None,
         d.get("end_date") or None, d.get("description", "")))
    _save_custom_values(d.get("custom", {}), "project", cur.lastrowid)
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/projects/<int:pid>")
@role_required("admin", "finance")
def update_project(pid):
    row = db().execute("SELECT company_id FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise ValueError("Project not found")
    check_company_access(row["company_id"])
    d = request.get_json(force=True)
    db().execute(
        "UPDATE projects SET name=?, status=?, start_date=?, end_date=?, description=? WHERE id=?",
        (d["name"], d.get("status", "active"), d.get("start_date") or None,
         d.get("end_date") or None, d.get("description", ""), pid))
    _save_custom_values(d.get("custom", {}), "project", pid)
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/projects/<int:pid>")
@role_required("admin", "finance")
def delete_project(pid):
    row = db().execute("SELECT company_id FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise ValueError("Project not found")
    check_company_access(row["company_id"])
    n = db().execute(
        "SELECT COUNT(*) AS n FROM journal_lines WHERE project_id=?", (pid,)).fetchone()["n"]
    if n:
        raise ValueError(
            "Project has %d transaction line(s) — reassign or delete those journal entries first." % n)
    # clear references that have no transactions behind them, then delete
    db().execute("DELETE FROM budgets WHERE project_id=?", (pid,))
    db().execute("UPDATE investments SET linked_project_id=NULL WHERE linked_project_id=?", (pid,))
    db().execute(
        "DELETE FROM custom_field_values WHERE entity_id=? AND field_id IN"
        " (SELECT id FROM custom_fields WHERE entity='project')", (pid,))
    db().execute("DELETE FROM projects WHERE id=?", (pid,))
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/projects/performance")
@login_required
def projects_performance():
    ids, label = scope_from_request()
    year = year_param()
    return jsonify({"scope": label, "year": year,
                    "rows": reports.project_performance(db(), ids, year)})


@app.get("/api/projects/<int:pid>/monthly")
@login_required
def project_monthly(pid):
    row = db().execute("SELECT company_id FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        raise ValueError("Project not found")
    check_company_access(row["company_id"])
    return jsonify(reports.project_monthly(db(), pid, year_param()))


# --------------------------------------------------------------------------
# Journal entries
# --------------------------------------------------------------------------

@app.get("/api/journals")
@login_required
def list_journals():
    ids, _ = scope_from_request()
    where = ["je.company_id IN (%s)" % ",".join("?" * len(ids))]
    params = list(ids)
    if request.args.get("year"):
        where.append("strftime('%Y', je.date) = ?")
        params.append(request.args["year"])
    if request.args.get("month"):
        where.append("CAST(strftime('%m', je.date) AS INTEGER) = ?")
        params.append(int(request.args["month"]))
    if request.args.get("status"):
        where.append("je.status = ?")
        params.append(request.args["status"])
    if request.args.get("q"):
        where.append("(je.description LIKE ? OR je.entry_no LIKE ? OR je.reference LIKE ?)")
        q = "%" + request.args["q"] + "%"
        params.extend([q, q, q])
    rows = db().execute(
        """SELECT je.id, je.entry_no, je.date, je.description, je.reference, je.status,
                  c.code AS company,
                  (SELECT ROUND(SUM(debit),2) FROM journal_lines WHERE entry_id=je.id) AS amount,
                  (SELECT COUNT(*) FROM journal_lines WHERE entry_id=je.id) AS line_count
           FROM journal_entries je JOIN companies c ON c.id = je.company_id
           WHERE %s ORDER BY je.date DESC, je.id DESC LIMIT 500""" % " AND ".join(where),
        params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/journals/<int:jid>")
@login_required
def get_journal(jid):
    je = db().execute(
        """SELECT je.*, c.code AS company FROM journal_entries je
           JOIN companies c ON c.id = je.company_id WHERE je.id=?""", (jid,)).fetchone()
    if not je:
        raise ValueError("Entry not found")
    check_company_access(je["company_id"])
    lines = db().execute(
        """SELECT jl.*, a.code AS account_code, a.name AS account_name, p.code AS project_code
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
           LEFT JOIN projects p ON p.id = jl.project_id
           WHERE jl.entry_id=? ORDER BY jl.id""", (jid,)).fetchall()
    out = dict(je)
    out["lines"] = [dict(l) for l in lines]
    wrap = [out]
    _attach_custom_values(wrap, "journal")
    return jsonify(wrap[0])


@app.post("/api/journals")
@role_required("admin", "finance")
def create_journal():
    d = request.get_json(force=True)
    check_company_access(d["company_id"])
    lines = d.get("lines", [])
    if len(lines) < 2:
        raise ValueError("An entry needs at least two lines")
    total_d = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    total_c = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(total_d - total_c) > 0.01:
        raise ValueError("Entry is not balanced: debit %s vs credit %s" % (total_d, total_c))
    if total_d == 0:
        raise ValueError("Entry amount cannot be zero")
    n = db().execute("SELECT COUNT(*)+1 FROM journal_entries WHERE company_id=?",
                     (d["company_id"],)).fetchone()[0]
    entry_no = d.get("entry_no") or "JV-%s-%05d" % (d["date"][:7].replace("-", ""), n)
    source = d.get("source") if d.get("source") in ENTRY_SOURCES else "manual"
    cur = db().execute(
        "INSERT INTO journal_entries (company_id, entry_no, date, description, reference, status, source, created_by)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (d["company_id"], entry_no, d["date"], d.get("description", ""),
         d.get("reference", ""), d.get("status", "draft"), source, g.user["id"]))
    for l in lines:
        db().execute(
            "INSERT INTO journal_lines (entry_id, account_id, project_id, description, debit, credit)"
            " VALUES (?,?,?,?,?,?)",
            (cur.lastrowid, l["account_id"], l.get("project_id") or None,
             l.get("description", ""), round(float(l.get("debit") or 0), 2),
             round(float(l.get("credit") or 0), 2)))
    _save_custom_values(d.get("custom", {}), "journal", cur.lastrowid)
    db().commit()
    return jsonify({"id": cur.lastrowid, "entry_no": entry_no}), 201


@app.put("/api/journals/<int:jid>")
@role_required("admin", "finance")
def update_journal(jid):
    """Edit an entry (incl. posted ones — Admin/Accountant only)."""
    je = db().execute("SELECT * FROM journal_entries WHERE id=?", (jid,)).fetchone()
    if not je:
        raise ValueError("Entry not found")
    check_company_access(je["company_id"])
    d = request.get_json(force=True)
    lines = d.get("lines", [])
    if len(lines) < 2:
        raise ValueError("An entry needs at least two lines")
    total_d = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    total_c = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(total_d - total_c) > 0.01:
        raise ValueError("Entry is not balanced: debit %s vs credit %s" % (total_d, total_c))
    if total_d == 0:
        raise ValueError("Entry amount cannot be zero")
    db().execute(
        "UPDATE journal_entries SET date=?, description=?, reference=? WHERE id=?",
        (d.get("date", je["date"]), d.get("description", ""), d.get("reference", ""), jid))
    db().execute("DELETE FROM journal_lines WHERE entry_id=?", (jid,))
    for l in lines:
        db().execute(
            "INSERT INTO journal_lines (entry_id, account_id, project_id, description, debit, credit)"
            " VALUES (?,?,?,?,?,?)",
            (jid, l["account_id"], l.get("project_id") or None,
             l.get("description", ""), round(float(l.get("debit") or 0), 2),
             round(float(l.get("credit") or 0), 2)))
    _save_custom_values(d.get("custom", {}), "journal", jid)
    db().commit()
    return jsonify({"ok": True, "entry_no": je["entry_no"]})


@app.post("/api/journals/<int:jid>/post")
@role_required("admin", "finance")
def post_journal(jid):
    je = db().execute("SELECT * FROM journal_entries WHERE id=?", (jid,)).fetchone()
    if not je:
        raise ValueError("Entry not found")
    check_company_access(je["company_id"])
    db().execute("UPDATE journal_entries SET status='posted' WHERE id=?", (jid,))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/journals/<int:jid>")
@role_required("admin", "finance")
def delete_journal(jid):
    je = db().execute("SELECT * FROM journal_entries WHERE id=?", (jid,)).fetchone()
    if not je:
        raise ValueError("Entry not found")
    check_company_access(je["company_id"])
    if je["status"] == "posted" and g.user["role"] != "admin":
        raise ValueError("Only admin can delete a posted entry")
    db().execute("DELETE FROM journal_entries WHERE id=?", (jid,))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/journals/bulk")
@role_required("admin", "finance")
def bulk_journals():
    """Apply an action to many entries at once: delete, draft (un-post), post."""
    d = request.get_json(force=True)
    action = d.get("action")
    if action not in ("delete", "draft", "post"):
        raise ValueError("action must be 'delete', 'draft' or 'post'")
    try:
        ids = [int(i) for i in d.get("ids", [])]
    except (TypeError, ValueError):
        raise ValueError("ids must be a list of entry ids")
    if not ids:
        raise ValueError("No entries selected")
    allowed = set(accessible_company_ids())
    done, errors = 0, []
    for jid in ids:
        je = db().execute("SELECT * FROM journal_entries WHERE id=?", (jid,)).fetchone()
        if not je:
            errors.append("Entry %d not found" % jid)
            continue
        if je["company_id"] not in allowed:
            errors.append("%s: company not accessible" % je["entry_no"])
            continue
        if action == "delete":
            if je["status"] == "posted" and g.user["role"] != "admin":
                errors.append("%s: only an Admin can delete a posted entry" % je["entry_no"])
                continue
            db().execute("DELETE FROM journal_entries WHERE id=?", (jid,))
        else:
            db().execute("UPDATE journal_entries SET status=? WHERE id=?",
                         ("posted" if action == "post" else "draft", jid))
        done += 1
    db().commit()
    return jsonify({"done": done, "errors": errors})


# --------------------------------------------------------------------------
# Budgets
# --------------------------------------------------------------------------

@app.get("/api/budgets")
@login_required
def get_budgets():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    year = year_param()
    rows = db().execute(
        """SELECT b.account_id, a.code, a.name, a.type, b.project_id, b.month, b.amount
           FROM budgets b JOIN accounts a ON a.id = b.account_id
           WHERE b.company_id=? AND b.year=? ORDER BY a.code""",
        (company_id, year)).fetchall()
    grid = {}
    for r in rows:
        key = (r["account_id"], r["project_id"])
        g_ = grid.setdefault(key, {
            "account_id": r["account_id"], "code": r["code"], "name": r["name"],
            "type": r["type"], "project_id": r["project_id"], "amounts": [0.0] * 12})
        g_["amounts"][r["month"] - 1] = r["amount"]
    return jsonify({"year": year, "rows": sorted(grid.values(), key=lambda x: x["code"])})


@app.delete("/api/budgets")
@role_required("admin", "finance")
def delete_budget_row():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    year = year_param()
    account_id = int(request.args.get("account_id"))
    project_id = request.args.get("project_id") or None
    if project_id:
        project_id = int(project_id)
        project_in_company(project_id, company_id)
    cur = db().execute(
        "DELETE FROM budgets WHERE company_id=? AND account_id=? AND year=? AND project_id IS ?",
        (company_id, account_id, year, project_id))
    db().commit()
    return jsonify({"deleted": cur.rowcount})


@app.put("/api/budgets")
@role_required("admin", "finance")
def save_budgets():
    d = request.get_json(force=True)
    company_id = int(d["company_id"])
    check_company_access(company_id)
    year = int(d["year"])
    checked_projects = set()
    for row in d.get("rows", []):
        pidv = row.get("project_id")
        if pidv and pidv not in checked_projects:
            project_in_company(int(pidv), company_id)  # block budgeting a foreign project
            checked_projects.add(pidv)
        for m, amount in enumerate(row.get("amounts", [])[:12], start=1):
            excel_io.upsert_budget(db(), company_id, row["account_id"],
                                   row.get("project_id"), year, m, float(amount or 0))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Reports & dashboard
# --------------------------------------------------------------------------

def get_thresholds():
    """Merge stored watch thresholds over the Pengawasan defaults. Stored data is
    optional/best-effort — any problem (missing table on an unmigrated db, bad or
    non-dict JSON) falls back cleanly to the defaults rather than 500-ing."""
    merged = {k: dict(v) for k, v in reports.DEFAULT_THRESHOLDS.items()}
    try:
        row = db().execute("SELECT value FROM app_settings WHERE key='thresholds'").fetchone()
        parsed = json.loads(row["value"]) if row and row["value"] else {}
        if isinstance(parsed, dict):
            for k, v in parsed.items():
                if k in merged and isinstance(v, dict):
                    for kk in ("healthy", "watch"):
                        if v.get(kk) is not None:
                            merged[k][kk] = float(v[kk])
    except Exception:
        pass
    return merged


@app.get("/api/settings/thresholds")
@login_required
def get_thresholds_api():
    return jsonify({"thresholds": get_thresholds(), "defaults": reports.DEFAULT_THRESHOLDS})


@app.post("/api/settings/thresholds")
@role_required("admin")
def set_thresholds_api():
    d = request.get_json(force=True)
    incoming = d.get("thresholds", {})
    clean = {}
    for k in reports.DEFAULT_THRESHOLDS:
        v = incoming.get(k)
        if isinstance(v, dict):
            try:
                clean[k] = {"healthy": float(v["healthy"]), "watch": float(v["watch"])}
            except (KeyError, TypeError, ValueError):
                continue
    db().execute("INSERT INTO app_settings (key, value) VALUES ('thresholds', ?)"
                 " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(clean),))
    db().commit()
    return jsonify({"ok": True, "thresholds": get_thresholds()})


@app.get("/api/reports/dashboard")
@login_required
def report_dashboard():
    ids, label = scope_from_request()
    data = reports.dashboard(db(), ids, year_param(), thresholds=get_thresholds())
    data["scope"] = label
    return jsonify(data)


@app.get("/api/reports/trial-balance")
@login_required
def report_tb():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    if request.args.get("detailed") in ("1", "true", "yes"):
        data = reports.trial_balance_detailed(db(), ids, date_from, date_to)
    else:
        data = reports.trial_balance(db(), ids, date_from, date_to)
    data.update(scope=label, date_from=date_from, date_to=date_to)
    return jsonify(data)


OPENING_REF = "OPENING-BALANCE"  # marks the single opening-balance entry per company


@app.get("/api/reports/opening-balances")
@login_required
def get_opening_balances():
    try:
        company_id = int(request.args.get("company_id"))
    except (TypeError, ValueError):
        raise ValueError("company_id is required")
    check_company_access(company_id)
    je = db().execute(
        "SELECT id, date FROM journal_entries WHERE company_id=? AND reference=? ORDER BY id DESC LIMIT 1",
        (company_id, OPENING_REF)).fetchone()
    lines, date = [], None
    if je:
        date = je["date"]
        # one row per code (collapse any duplicate account lines)
        lines = [dict(r) for r in db().execute(
            "SELECT a.code, MIN(a.name) AS name, MIN(a.type) AS type,"
            "       SUM(jl.debit) AS debit, SUM(jl.credit) AS credit"
            " FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id"
            " WHERE jl.entry_id=? GROUP BY a.code ORDER BY a.code", (je["id"],)).fetchall()]
    return jsonify({"date": date, "lines": lines})


OPENING_BS_TYPES = ("asset", "liability", "equity")


@app.post("/api/reports/opening-balances")
@role_required("admin", "finance")
def save_opening_balances():
    """Create/replace the opening-balance journal entry for one company. Lines
    may only touch balance-sheet accounts (income-statement opening balances
    belong in Retained Earnings). Any debit/credit imbalance is posted to the
    balancing account (Retained Earnings by default) so the entry always
    balances. Replaces any previous opening entry for the company."""
    d = request.get_json(force=True)
    try:
        company_id = int(d["company_id"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("company_id is required")
    check_company_access(company_id)
    date = (d.get("date") or "%d-01-01" % datetime.now().year)[:10]
    balancing_code = (d.get("balancing_code") or "3200").strip()
    acc = {r["code"]: r for r in db().execute(
        "SELECT id, code, type FROM accounts WHERE company_id=?", (company_id,))}
    # net debit-minus-credit per account id (collapses repeats of the same code)
    net = {}
    for l in d.get("lines", []):
        deb = round(float(l.get("debit") or 0), 2)
        cre = round(float(l.get("credit") or 0), 2)
        if deb == 0 and cre == 0:
            continue
        a = acc.get((l.get("code") or "").strip())
        if not a:
            continue
        if a["type"] not in OPENING_BS_TYPES:
            raise ValueError("Opening balances may only be set on balance-sheet "
                             "accounts — %s is a %s account" % (a["code"], a["type"]))
        net[a["id"]] = round(net.get(a["id"], 0.0) + deb - cre, 2)
    if not net:
        raise ValueError("Enter at least one opening balance")
    diff = round(sum(net.values()), 2)  # debit-positive; >0 means debits exceed credits
    if abs(diff) >= 0.01:
        b = acc.get(balancing_code)
        if not b:
            raise ValueError("Balancing account %s does not exist in this company" % balancing_code)
        if b["type"] not in OPENING_BS_TYPES:
            raise ValueError("Balancing account %s must be a balance-sheet account" % balancing_code)
        net[b["id"]] = round(net.get(b["id"], 0.0) - diff, 2)
    # replace any prior opening-balance entry for this company (atomic per request)
    for o in db().execute("SELECT id FROM journal_entries WHERE company_id=? AND reference=?",
                          (company_id, OPENING_REF)).fetchall():
        db().execute("DELETE FROM journal_lines WHERE entry_id=?", (o["id"],))
        db().execute("DELETE FROM journal_entries WHERE id=?", (o["id"],))
    # next OB sequence for the month (max existing OB-YYYYMM-* + 1, not a row count)
    prefix = "OB-%s-" % date[:7].replace("-", "")
    last = db().execute(
        "SELECT entry_no FROM journal_entries WHERE company_id=? AND entry_no LIKE ?"
        " ORDER BY entry_no DESC LIMIT 1", (company_id, prefix + "%")).fetchone()
    seq = (int(last["entry_no"].rsplit("-", 1)[1]) + 1) if last else 1
    entry_no = "%s%05d" % (prefix, seq)
    cur = db().execute(
        "INSERT INTO journal_entries (company_id, entry_no, date, description, reference, status, source, created_by)"
        " VALUES (?,?,?,?,?, 'posted', 'manual', ?)",
        (company_id, entry_no, date, "Opening balances", OPENING_REF, g.user["id"]))
    for aid, val in net.items():
        if abs(val) < 0.005:
            continue
        deb, cre = (val, 0.0) if val > 0 else (0.0, round(-val, 2))
        db().execute(
            "INSERT INTO journal_lines (entry_id, account_id, description, debit, credit)"
            " VALUES (?,?,?,?,?)", (cur.lastrowid, aid, "Opening balance", round(deb, 2), cre))
    db().commit()
    return jsonify({"ok": True, "entry_no": entry_no,
                    "plugged_to": balancing_code if abs(diff) >= 0.01 else None,
                    "difference": diff})


@app.get("/api/reports/account-ledger")
@login_required
def report_account_ledger():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    code = (request.args.get("code") or "").strip()
    if not code:
        raise ValueError("An account code is required")
    data = reports.account_ledger(db(), ids, code, date_from, date_to)
    data.update(scope=label, date_from=date_from, date_to=date_to)
    return jsonify(data)


# --------------------------------------------------------------------------
# Accounts Receivable aging (Piutang)
# --------------------------------------------------------------------------

def _ar_as_of():
    return (request.args.get("as_of") or datetime.now().date().isoformat())[:10]


def _receivable_fields(d):
    return (d.get("client", "").strip(), d.get("invoice_no", "").strip(),
            (d.get("invoice_date") or None), (d.get("due_date") or None),
            round(float(d.get("amount") or 0), 2), round(float(d.get("paid") or 0), 2),
            d.get("notes", "").strip())


@app.get("/api/receivables")
@login_required
def list_receivables():
    ids, label = scope_from_request()
    data = reports.receivables_aging(db(), ids, _ar_as_of())
    data["scope"] = label
    return jsonify(data)


@app.post("/api/receivables")
@role_required("admin", "finance")
def create_receivable():
    d = request.get_json(force=True)
    company_id = int(d["company_id"])
    check_company_access(company_id)
    if not (d.get("client") or "").strip():
        raise ValueError("Client name is required")
    cur = db().execute(
        "INSERT INTO receivables (company_id, client, invoice_no, invoice_date, due_date, amount, paid, notes)"
        " VALUES (?,?,?,?,?,?,?,?)", (company_id,) + _receivable_fields(d))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/receivables/<int:rid>")
@role_required("admin", "finance")
def update_receivable(rid):
    row = db().execute("SELECT company_id FROM receivables WHERE id=?", (rid,)).fetchone()
    if not row:
        raise ValueError("Receivable not found")
    check_company_access(row["company_id"])
    d = request.get_json(force=True)
    db().execute(
        "UPDATE receivables SET client=?, invoice_no=?, invoice_date=?, due_date=?,"
        " amount=?, paid=?, notes=? WHERE id=?", _receivable_fields(d) + (rid,))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/receivables/<int:rid>")
@role_required("admin", "finance")
def delete_receivable(rid):
    row = db().execute("SELECT company_id FROM receivables WHERE id=?", (rid,)).fetchone()
    if not row:
        raise ValueError("Receivable not found")
    check_company_access(row["company_id"])
    db().execute("DELETE FROM receivables WHERE id=?", (rid,))
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/export/receivables")
@login_required
def export_receivables():
    ids, label = scope_from_request()
    aging = reports.receivables_aging(db(), ids, _ar_as_of())
    return _xlsx(excel_io.export_receivables(aging, label),
                 "ar_aging_%s.xlsx" % aging["as_of"])


@app.get("/api/reports/pnl")
@login_required
def report_pnl():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    data = reports.profit_and_loss(db(), ids, date_from, date_to)
    data.update(scope=label, date_from=date_from, date_to=date_to)
    return jsonify(data)


@app.get("/api/reports/balance-sheet")
@login_required
def report_bs():
    ids, label = scope_from_request()
    as_of = as_of_from_request()
    data = reports.balance_sheet(db(), ids, as_of)
    data.update(scope=label, as_of=as_of)
    return jsonify(data)


@app.get("/api/reports/budget-vs-actual")
@login_required
def report_bva():
    ids, label = scope_from_request()
    data = reports.budget_vs_actual(db(), ids, year_param())
    data["scope"] = label
    return jsonify(data)


@app.get("/api/reports/project-budget-vs-actual")
@login_required
def report_project_bva():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    project_id = int(request.args.get("project_id"))
    prow = project_in_company(project_id, company_id)
    data = reports.project_budget_vs_actual(db(), company_id, project_id, year_param())
    data.update(company=_company_name(company_id), project="%s — %s" % (prow["code"], prow["name"]))
    return jsonify(data)


@app.get("/api/reports/cash-flow")
@login_required
def report_cash_flow():
    ids, label = scope_from_request()
    data = reports.cash_flow(db(), ids, year_param())
    data["scope"] = label
    return jsonify(data)


@app.get("/api/export/cash-flow")
@login_required
def export_cash_flow():
    ids, label = scope_from_request()
    cf = reports.cash_flow(db(), ids, year_param())
    return _xlsx(excel_io.export_cash_flow(cf, label), "cash_flow_%d.xlsx" % cf["year"])


# --------------------------------------------------------------------------
# Excel export
# --------------------------------------------------------------------------

def _xlsx(buf, name):
    return send_file(buf, mimetype=XLSX, as_attachment=True, download_name=name)


def _pdf(buf, name):
    return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name=name)


# --- PDF financial statements ---------------------------------------------

@app.get("/api/export/pdf/pnl")
@login_required
def export_pnl_pdf():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    pnl = reports.profit_and_loss(db(), ids, date_from, date_to)
    return _pdf(pdf_export.export_pnl_pdf(pnl, label, "Period %s to %s" % (date_from, date_to)),
                "profit_loss_%s_to_%s.pdf" % (date_from, date_to))


@app.get("/api/export/pdf/balance-sheet")
@login_required
def export_bs_pdf():
    ids, label = scope_from_request()
    as_of = as_of_from_request()
    bs = reports.balance_sheet(db(), ids, as_of)
    return _pdf(pdf_export.export_balance_sheet_pdf(bs, label, "As of %s" % as_of),
                "balance_sheet_%s.pdf" % as_of)


@app.get("/api/export/pdf/trial-balance")
@login_required
def export_tb_pdf():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    tb = reports.trial_balance(db(), ids, date_from, date_to)
    return _pdf(pdf_export.export_trial_balance_pdf(tb, label, "Period %s to %s" % (date_from, date_to)),
                "trial_balance_%s_to_%s.pdf" % (date_from, date_to))


@app.get("/api/export/pdf/cash-flow")
@login_required
def export_cf_pdf():
    ids, label = scope_from_request()
    cf = reports.cash_flow(db(), ids, year_param())
    return _pdf(pdf_export.export_cash_flow_pdf(cf, label), "cash_flow_%d.pdf" % cf["year"])


@app.get("/api/export/pdf/budget-vs-actual")
@login_required
def export_bva_pdf():
    project_id = request.args.get("project_id")
    if project_id:
        company_id = int(request.args.get("company_id"))
        check_company_access(company_id)
        prow = project_in_company(int(project_id), company_id)
        bva = reports.project_budget_vs_actual(db(), company_id, int(project_id), year_param())
        return _pdf(pdf_export.export_budget_vs_actual_pdf(
            bva, _company_name(company_id), "%s - %s" % (prow["code"], prow["name"])),
            "budget_vs_realization_project_%d.pdf" % bva["year"])
    ids, label = scope_from_request()
    bva = reports.budget_vs_actual(db(), ids, year_param())
    return _pdf(pdf_export.export_budget_vs_actual_pdf(bva, label),
                "budget_vs_realization_%d.pdf" % bva["year"])


@app.get("/api/export/trial-balance")
@login_required
def export_tb():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    tb = reports.trial_balance(db(), ids, date_from, date_to)
    return _xlsx(excel_io.export_trial_balance(tb, label, "Period %s to %s" % (date_from, date_to)),
                 "trial_balance_%s_to_%s.xlsx" % (date_from, date_to))


@app.get("/api/export/pnl")
@login_required
def export_pnl():
    ids, label = scope_from_request()
    date_from, date_to = date_range_from_request()
    pnl = reports.profit_and_loss(db(), ids, date_from, date_to)
    return _xlsx(excel_io.export_pnl(pnl, label, "Period %s to %s" % (date_from, date_to)),
                 "profit_loss_%s_to_%s.xlsx" % (date_from, date_to))


@app.get("/api/export/balance-sheet")
@login_required
def export_bs():
    ids, label = scope_from_request()
    as_of = as_of_from_request()
    bs = reports.balance_sheet(db(), ids, as_of)
    return _xlsx(excel_io.export_balance_sheet(bs, label, "As of %s" % as_of),
                 "balance_sheet_%s.xlsx" % as_of)


@app.get("/api/export/budget-vs-actual")
@login_required
def export_bva():
    ids, label = scope_from_request()
    bva = reports.budget_vs_actual(db(), ids, year_param())
    return _xlsx(excel_io.export_budget_vs_actual(bva, label),
                 "budget_vs_actual_%d.xlsx" % bva["year"])


@app.get("/api/export/budget")
@login_required
def export_budget():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    year = year_param()
    project_id = request.args.get("project_id")
    grid = get_budgets().get_json()
    if project_id:
        pid = int(project_id)
        prow = project_in_company(pid, company_id)
        rows = [r for r in grid["rows"] if r["project_id"] == pid]
        label = "%s / %s" % (_company_name(company_id), prow["code"])
    else:
        rows = [r for r in grid["rows"] if not r["project_id"]]
        label = _company_name(company_id)
    return _xlsx(excel_io.export_budget_grid(rows, label, year), "budget_%d.xlsx" % year)


@app.get("/api/export/journals")
@login_required
def export_journals():
    ids, label = scope_from_request()
    y = year_param()
    entries = db().execute(
        """SELECT je.id, je.entry_no, je.date, je.status, je.description, je.reference
           FROM journal_entries je WHERE je.company_id IN (%s)
           AND strftime('%%Y', je.date)=? ORDER BY je.date, je.id"""
        % ",".join("?" * len(ids)), ids + [str(y)]).fetchall()
    out = []
    for e in entries:
        lines = db().execute(
            """SELECT jl.description, jl.debit, jl.credit, a.code AS account_code,
                      a.name AS account_name, p.code AS project_code
               FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id
               LEFT JOIN projects p ON p.id=jl.project_id
               WHERE jl.entry_id=? ORDER BY jl.id""", (e["id"],)).fetchall()
        d = dict(e)
        d["lines"] = [dict(l) for l in lines]
        out.append(d)
    return _xlsx(excel_io.export_journals(out, label, "Year %d" % y), "journals_%d.xlsx" % y)


@app.get("/api/export/coa")
@login_required
def export_coa():
    company_id = int(request.args.get("company_id"))
    check_company_access(company_id)
    rows = [dict(r) for r in db().execute(
        "SELECT * FROM accounts WHERE company_id=? ORDER BY code", (company_id,))]
    return _xlsx(excel_io.export_coa(rows, _company_name(company_id)), "chart_of_accounts.xlsx")


@app.get("/api/export/project-performance")
@login_required
def export_projects():
    ids, label = scope_from_request()
    y = year_param()
    rows = reports.project_performance(db(), ids, y)
    return _xlsx(excel_io.export_project_performance(rows, label, y),
                 "project_performance_%d.xlsx" % y)


@app.get("/api/templates/<kind>")
@login_required
def download_template(kind):
    if kind == "journals":
        return _xlsx(excel_io.template_journals(), "journal_import_template.xlsx")
    if kind == "coa":
        return _xlsx(excel_io.template_coa(), "coa_import_template.xlsx")
    if kind == "budget":
        return _xlsx(excel_io.template_budget(year_param()), "budget_import_template.xlsx")
    raise ValueError("Unknown template")


# --------------------------------------------------------------------------
# Excel import
# --------------------------------------------------------------------------

def _import_file():
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ValueError("No file uploaded")
    if not f.filename.lower().endswith((".xlsx", ".xlsm")):
        raise ValueError("Please upload an .xlsx file")
    return f


@app.post("/api/import/journals")
@role_required("admin", "finance")
def import_journals():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    created, errors = excel_io.import_journals(db(), company_id, _import_file(), g.user["id"])
    return jsonify({"created": created, "errors": errors})


@app.post("/api/import/coa")
@role_required("admin", "finance")
def import_coa():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    created, updated, errors = excel_io.import_coa(db(), company_id, _import_file())
    return jsonify({"created": created, "updated": updated, "errors": errors})


@app.post("/api/import/budget")
@role_required("admin", "finance")
def import_budget():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    year = int(request.form.get("year", 2026))
    saved, errors = excel_io.import_budget(db(), company_id, year, _import_file())
    return jsonify({"saved_rows": saved, "errors": errors})


# --------------------------------------------------------------------------
# Bank import (BCA receipts)
# --------------------------------------------------------------------------

def _flag_duplicates(company_id, txs):
    refs = [t["reference"] for t in txs if t["reference"]]
    existing = set()
    if refs:
        rows = db().execute(
            "SELECT reference FROM journal_entries WHERE company_id=? AND reference IN (%s)"
            % ",".join("?" * len(refs)), [company_id] + refs).fetchall()
        existing = {r["reference"] for r in rows}
    for t in txs:
        t["duplicate"] = bool(t["reference"]) and t["reference"] in existing
        t.setdefault("direction", "out")


def _resolve_suggested_accounts(company_id, txs):
    """Map each transaction's suggested COA code (e.g. 6610 for a 'Biaya TXN'
    bank charge, or a wallet category) to an account id in this company so the
    UI can pre-select the contra account."""
    codes = {t.get("suggested_code") for t in txs if t.get("suggested_code")}
    id_by_code = {}
    if codes:
        rows = db().execute(
            "SELECT id, code FROM accounts WHERE company_id=? AND code IN (%s)"
            % ",".join("?" * len(codes)), [company_id] + list(codes)).fetchall()
        id_by_code = {r["code"]: r["id"] for r in rows}
    for t in txs:
        if not t.get("suggested_account_id"):
            t["suggested_account_id"] = id_by_code.get(t.get("suggested_code"))


@app.post("/api/bank/parse-bca")
@role_required("admin", "finance")
def parse_bca():
    d = request.get_json(force=True)
    company_id = int(d.get("company_id"))
    check_company_access(company_id)
    txs, warnings = bank_import.parse_bca_text(d.get("text", ""))
    _flag_duplicates(company_id, txs)
    _resolve_suggested_accounts(company_id, txs)
    return jsonify({"transactions": txs, "warnings": warnings})


@app.post("/api/bank/parse-csv")
@role_required("admin", "finance")
def parse_bank_csv():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ValueError("No file uploaded")
    if not f.filename.lower().endswith((".csv", ".txt")):
        raise ValueError("Please upload the .csv file exported from the bank")
    txs, warnings, meta = bank_import.parse_bca_csv(f.read())
    _flag_duplicates(company_id, txs)
    _resolve_suggested_accounts(company_id, txs)
    return jsonify({"transactions": txs, "warnings": warnings, "meta": meta})


@app.post("/api/bank/parse-pdf")
@role_required("admin", "finance")
def parse_bank_pdf():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ValueError("No file uploaded")
    if not f.filename.lower().endswith(".pdf"):
        raise ValueError("Please upload the BCA e-statement .pdf file")
    txs, warnings, meta = bank_import.parse_bca_estatement_pdf(f.read())
    _flag_duplicates(company_id, txs)
    _resolve_suggested_accounts(company_id, txs)
    return jsonify({"transactions": txs, "warnings": warnings, "meta": meta})


@app.post("/api/bank/parse-wallet")
@role_required("admin", "finance")
def parse_wallet():
    company_id = int(request.form.get("company_id"))
    check_company_access(company_id)
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ValueError("No file uploaded")
    if not f.filename.lower().endswith((".xlsx", ".xlsm")):
        raise ValueError("Please upload the wallet/card transaction .xlsx file")
    txs, warnings, meta = bank_import.parse_wallet_xlsx(f.read())
    _flag_duplicates(company_id, txs)
    _resolve_suggested_accounts(company_id, txs)
    return jsonify({"transactions": txs, "warnings": warnings, "meta": meta})


# --------------------------------------------------------------------------
# Investments (strategic / scholarship initiatives)
# --------------------------------------------------------------------------

INVESTMENT_CATEGORIES = ("scholarship", "partnership", "rnd", "csr", "strategic", "other")


def _investment_query(where, params):
    return db().execute(
        """SELECT i.*, c.code AS company_code, p.code AS project_code,
              COALESCE((SELECT SUM(amount) FROM investment_events
                        WHERE investment_id=i.id AND kind='outflow'), 0) AS invested,
              COALESCE((SELECT SUM(amount) FROM investment_events
                        WHERE investment_id=i.id AND kind='benefit'), 0) AS benefit
           FROM investments i
           JOIN companies c ON c.id = i.company_id
           LEFT JOIN projects p ON p.id = i.linked_project_id
           WHERE %s ORDER BY i.id""" % where, params).fetchall()


@app.get("/api/investments")
@login_required
def list_investments():
    ids, _ = scope_from_request()
    rows = _investment_query("i.company_id IN (%s)" % ",".join("?" * len(ids)), ids)
    return jsonify([dict(r) for r in rows])


@app.get("/api/investments/<int:iid>")
@login_required
def get_investment(iid):
    rows = _investment_query("i.id = ?", [iid])
    if not rows:
        raise ValueError("Investment not found")
    inv = dict(rows[0])
    check_company_access(inv["company_id"])
    events = db().execute(
        "SELECT * FROM investment_events WHERE investment_id=? ORDER BY date, id", (iid,)).fetchall()
    inv["events"] = [dict(e) for e in events]
    return jsonify(inv)


@app.post("/api/investments")
@role_required("admin", "finance")
def create_investment():
    d = request.get_json(force=True)
    check_company_access(d["company_id"])
    if not d.get("name"):
        raise ValueError("Name is required")
    if d.get("category", "strategic") not in INVESTMENT_CATEGORIES:
        raise ValueError("Invalid category")
    cur = db().execute(
        "INSERT INTO investments (company_id, name, category, description, status,"
        " start_date, horizon_years, committed_amount, linked_project_id)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (d["company_id"], d["name"].strip(), d.get("category", "strategic"),
         d.get("description", ""), d.get("status", "active"), d.get("start_date") or None,
         int(d.get("horizon_years") or 3), float(d.get("committed_amount") or 0),
         d.get("linked_project_id") or None))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/investments/<int:iid>")
@role_required("admin", "finance")
def update_investment(iid):
    row = db().execute("SELECT company_id FROM investments WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("Investment not found")
    check_company_access(row["company_id"])
    d = request.get_json(force=True)
    db().execute(
        "UPDATE investments SET name=?, category=?, description=?, status=?,"
        " start_date=?, horizon_years=?, committed_amount=?, linked_project_id=? WHERE id=?",
        (d["name"].strip(), d.get("category", "strategic"), d.get("description", ""),
         d.get("status", "active"), d.get("start_date") or None,
         int(d.get("horizon_years") or 3), float(d.get("committed_amount") or 0),
         d.get("linked_project_id") or None, iid))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/investments/<int:iid>")
@role_required("admin")
def delete_investment(iid):
    row = db().execute("SELECT company_id FROM investments WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("Investment not found")
    check_company_access(row["company_id"])
    db().execute("DELETE FROM investments WHERE id=?", (iid,))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/investments/<int:iid>/events")
@role_required("admin", "finance")
def add_investment_event(iid):
    row = db().execute("SELECT company_id FROM investments WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("Investment not found")
    check_company_access(row["company_id"])
    d = request.get_json(force=True)
    if d.get("kind") not in ("outflow", "benefit"):
        raise ValueError("Kind must be 'outflow' (money invested) or 'benefit' (value gained)")
    if not float(d.get("amount") or 0):
        raise ValueError("Amount is required")
    cur = db().execute(
        "INSERT INTO investment_events (investment_id, date, kind, description, amount)"
        " VALUES (?,?,?,?,?)",
        (iid, d.get("date") or datetime.now().strftime("%Y-%m-%d"),
         d["kind"], d.get("description", ""), round(float(d["amount"]), 2)))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.delete("/api/investment-events/<int:eid>")
@role_required("admin", "finance")
def delete_investment_event(eid):
    row = db().execute(
        """SELECT i.company_id FROM investment_events e
           JOIN investments i ON i.id = e.investment_id WHERE e.id=?""", (eid,)).fetchone()
    if not row:
        raise ValueError("Entry not found")
    check_company_access(row["company_id"])
    db().execute("DELETE FROM investment_events WHERE id=?", (eid,))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Custom fields
# --------------------------------------------------------------------------

@app.get("/api/custom-fields")
@login_required
def list_custom_fields():
    entity = request.args.get("entity")
    where, params = ["is_active=1"], []
    if entity:
        where.append("entity=?")
        params.append(entity)
    rows = db().execute(
        "SELECT * FROM custom_fields WHERE %s ORDER BY entity, id" % " AND ".join(where),
        params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/custom-fields")
@role_required("admin")
def create_custom_field():
    d = request.get_json(force=True)
    if d.get("entity") not in ("journal", "project"):
        raise ValueError("Entity must be 'journal' or 'project'")
    if d.get("field_type", "text") not in ("text", "number", "date", "select"):
        raise ValueError("Invalid field type")
    if not d.get("label"):
        raise ValueError("Label is required")
    key = d.get("field_key") or d["label"].lower().replace(" ", "_")
    cur = db().execute(
        "INSERT INTO custom_fields (company_id, entity, label, field_key, field_type, options)"
        " VALUES (?,?,?,?,?,?)",
        (d.get("company_id") or None, d["entity"], d["label"], key,
         d.get("field_type", "text"), d.get("options", "")))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.delete("/api/custom-fields/<int:fid>")
@role_required("admin")
def delete_custom_field(fid):
    db().execute("UPDATE custom_fields SET is_active=0 WHERE id=?", (fid,))
    db().commit()
    return jsonify({"ok": True})


def _save_custom_values(custom, entity, entity_id):
    if not custom:
        return
    fields = {str(r["id"]): r for r in db().execute(
        "SELECT * FROM custom_fields WHERE entity=? AND is_active=1", (entity,))}
    for fid, value in custom.items():
        if str(fid) in fields:
            db().execute(
                """INSERT INTO custom_field_values (field_id, entity_id, value) VALUES (?,?,?)
                   ON CONFLICT (field_id, entity_id) DO UPDATE SET value=excluded.value""",
                (int(fid), entity_id, str(value)))


def _attach_custom_values(rows, entity):
    if not rows:
        return
    ids = [r["id"] for r in rows]
    vals = db().execute(
        """SELECT v.entity_id, v.value, f.id AS field_id, f.label
           FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
           WHERE f.entity=? AND f.is_active=1 AND v.entity_id IN (%s)"""
        % ",".join("?" * len(ids)), [entity] + ids).fetchall()
    by_entity = {}
    for v in vals:
        by_entity.setdefault(v["entity_id"], {})[str(v["field_id"])] = v["value"]
    for r in rows:
        r["custom"] = by_entity.get(r["id"], {})


def _company_name(cid):
    row = db().execute("SELECT name FROM companies WHERE id=?", (cid,)).fetchone()
    return row["name"] if row else "?"


# --------------------------------------------------------------------------
# Databases (admin) — separate data stores (MORES-GROUP, TEST-SERVER, ...)
# --------------------------------------------------------------------------

@app.get("/api/databases")
@login_required
def list_databases_api():
    # Any signed-in user can see and switch databases (the picker page);
    # creating and deleting stay admin-only below.
    active = active_db_name()
    return jsonify({
        "active": active,
        "default": database.DEFAULT_DB,
        "can_manage": g.user["role"] == "admin",
        "databases": [{"name": n, "active": n == active,
                       "deletable": n != database.DEFAULT_DB} for n in database.list_databases()],
    })


@app.post("/api/databases")
@role_required("admin")
def create_database_api():
    d = request.get_json(force=True)
    name = database.create_database(d.get("name", ""), seed_demo=bool(d.get("seed_demo", True)))
    return jsonify({"name": name}), 201


@app.delete("/api/databases/<name>")
@role_required("admin")
def delete_database_api(name):
    if name == active_db_name():
        raise ValueError("Switch to another database before deleting this one")
    database.delete_database(name)
    return jsonify({"ok": True})


@app.post("/api/databases/switch")
@login_required
def switch_database_api():
    d = request.get_json(force=True)
    name = d.get("name", "")
    if name not in database.list_databases():
        raise ValueError("Database '%s' not found" % name)
    # the same person must exist in the target database with the SAME role —
    # matching on role too prevents a low-privilege user from switching into a
    # database where their username happens to map to a higher-privileged account
    target = database.get_db(name)
    try:
        row = target.execute(
            "SELECT id FROM users WHERE username=? AND is_active=1 AND role=?",
            (g.user["username"], g.user["role"])).fetchone()
    finally:
        target.close()
    if not row:
        raise ValueError("Your %s account does not exist in '%s'" % (g.user["role"], name))
    session["active_db"] = name
    session["user_id"] = row["id"]
    g.pop("db", None)
    return jsonify({"ok": True, "active": name})


# --------------------------------------------------------------------------
# Users (admin)
# --------------------------------------------------------------------------

@app.get("/api/users")
@role_required("admin")
def list_users():
    rows = db().execute(
        "SELECT id, username, full_name, role, company_access, is_active, created_at"
        " FROM users ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/users")
@role_required("admin")
def create_user():
    d = request.get_json(force=True)
    if not d.get("username") or not d.get("password"):
        raise ValueError("Username and password are required")
    if d.get("role", "viewer") not in ("admin", "finance", "viewer"):
        raise ValueError("Invalid role")
    cur = db().execute(
        "INSERT INTO users (username, password_hash, full_name, role, company_access)"
        " VALUES (?,?,?,?,?)",
        (d["username"].strip(), generate_password_hash(d["password"]),
         d.get("full_name", ""), d.get("role", "viewer"), d.get("company_access", "all")))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/users/<int:uid>")
@role_required("admin")
def update_user(uid):
    d = request.get_json(force=True)
    db().execute(
        "UPDATE users SET full_name=?, role=?, company_access=?, is_active=? WHERE id=?",
        (d.get("full_name", ""), d.get("role", "viewer"),
         d.get("company_access", "all"), 1 if d.get("is_active", True) else 0, uid))
    if d.get("password"):
        db().execute("UPDATE users SET password_hash=? WHERE id=?",
                     (generate_password_hash(d["password"]), uid))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------

if __name__ == "__main__":
    database.init_db()
    port = int(os.environ.get("PORT", 8000))
    # HOST=0.0.0.0 makes the app reachable from other devices on the network.
    # Default stays localhost-only for safety.
    host = os.environ.get("HOST", "127.0.0.1")
    shown = "127.0.0.1" if host in ("127.0.0.1", "localhost") else host
    print("MORES HV running at http://%s:%d  (login: admin / admin123)" % (shown, port))
    if host == "0.0.0.0":
        print("Reachable on your network — change the demo passwords before sharing.")
    app.run(host=host, port=port, debug=False)
