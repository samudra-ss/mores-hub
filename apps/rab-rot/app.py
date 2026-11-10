"""MORES RAB ROT - the project cost plan and its remuneration, as its own app.

The "PROJECT RAB ROT ACTUAL" Excel sheet as a form: cost lines, the margin
stack, the project value net of tax per PT, the Finance Review signal, and
the remuneration the plan would pay - with the team's shares and a PDF.

Runs on this computer only (http://127.0.0.1:8100). The data is one SQLite
file: data/rabrot.db next to this file, or RAB_ROT_DATA_DIR.

    pip install -r requirements.txt
    python app.py
"""
import io
import json
import os
import re
import sqlite3
from datetime import datetime

from flask import Flask, g, jsonify, request, send_file, send_from_directory

import pdf_report
import rab_rot
import remuneration

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.environ.get("RAB_ROT_DATA_DIR") or os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "rabrot.db")
VERSION = "1.0"

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS remu_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, grade INTEGER NOT NULL DEFAULT 1 CHECK (grade BETWEEN 1 AND 4),
  notes TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS rab_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', prepared_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')));
"""


def db():
    if "db" not in g:
        os.makedirs(DATA_DIR, exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.executescript(SCHEMA)
    return g.db


@app.teardown_appcontext
def _close(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.errorhandler(ValueError)
def _bad(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(LookupError)
def _missing(e):
    return jsonify({"error": str(e.args[0] if e.args else "Not found")}), 404


@app.before_request
def _local_only():
    # pay data: answer this computer only, whatever address the server binds
    if request.remote_addr not in ("127.0.0.1", "::1", None):
        return jsonify({"error": "MORES RAB ROT answers this computer only"}), 403


# ---- pages --------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


@app.get("/manifest.webmanifest")
def manifest():
    r = send_from_directory(os.path.join(STATIC_DIR, "pwa"), "manifest.webmanifest", mimetype="application/manifest+json")
    r.headers["Cache-Control"] = "no-cache"
    return r


@app.get("/sw.js")
def service_worker():
    r = send_from_directory(os.path.join(STATIC_DIR, "pwa"), "sw.js", mimetype="application/javascript")
    r.headers["Cache-Control"] = "no-cache"
    return r


@app.get("/api/health")
def health():
    return jsonify({"app": "MORES RAB ROT", "version": VERSION})


# ---- people & the scheme --------------------------------------------------------
def _people():
    return {r["id"]: dict(r) for r in db().execute("SELECT * FROM remu_people ORDER BY grade DESC, name")}


def _person_fields(d):
    name = (d.get("name") or "").strip()
    if not name:
        raise ValueError("A person needs a name")
    grade = int(d.get("grade") or 1)
    if grade not in (1, 2, 3, 4):
        raise ValueError("Grade is G1 to G4")
    return name, grade, (d.get("notes") or "").strip(), 0 if d.get("is_active") is False else 1


@app.get("/api/people")
def people_list():
    return jsonify(list(_people().values()))


@app.post("/api/people")
def people_add():
    name, grade, notes, active = _person_fields(request.get_json(force=True) or {})
    cur = db().execute("INSERT INTO remu_people (name, grade, notes, is_active) VALUES (?,?,?,?)", (name, grade, notes, active))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/people/<int:pid>")
def people_update(pid):
    if not db().execute("SELECT 1 FROM remu_people WHERE id=?", (pid,)).fetchone():
        raise LookupError("Person not found")
    name, grade, notes, active = _person_fields(request.get_json(force=True) or {})
    db().execute("UPDATE remu_people SET name=?, grade=?, notes=?, is_active=? WHERE id=?", (name, grade, notes, active, pid))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/people/<int:pid>")
def people_delete(pid):
    """Removes the person; plans that named them simply no longer pay them."""
    db().execute("DELETE FROM remu_people WHERE id=?", (pid,))
    db().commit()
    return jsonify({"ok": True})


@app.get("/api/config")
def config_get():
    return jsonify(remuneration.config(db()))


@app.put("/api/config")
def config_save():
    """Grade titles and weights, the scheme percentages and the agent rate."""
    d = request.get_json(force=True) or {}
    if "grades" in d:
        over = {}
        for gr in d["grades"] or []:
            w = float(gr.get("weight") or 0)
            if w <= 0:
                raise ValueError("A grade weight must be above zero")
            over[str(int(gr["grade"]))] = {"title": (gr.get("title") or "").strip(), "weight": w}
        db().execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('remu_grades', ?)", (json.dumps(over),))
    if "schemes" in d:
        over, keys = {}, {x["key"] for x in remuneration.DEFAULT_SCHEMES}
        for k, vals in (d["schemes"] or {}).items():
            if k not in keys:
                continue
            clean = {}
            for f, v in (vals or {}).items():
                if f in remuneration.EDITABLE:
                    v = None if v in (None, "") else float(v)
                    if v is not None and not 0 <= v <= 1:
                        raise ValueError("Scheme percentages are between 0% and 100%")
                    clean[f] = v
            over[k] = clean
        db().execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('remu_schemes', ?)", (json.dumps(over),))
    if "agent_rate" in d:
        r = float(d.get("agent_rate") or 0)
        if not 0 <= r <= 1:
            raise ValueError("The agent rate is between 0% and 100%")
        db().execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('remu_agent_rate', ?)", (json.dumps({"rate": r}),))
    db().commit()
    return jsonify(remuneration.config(db()))


# ---- the plans ----------------------------------------------------------------------
def _plan_row(pid):
    row = db().execute("SELECT * FROM rab_plans WHERE id=?", (pid,)).fetchone()
    if not row:
        raise LookupError("Plan not found")
    return row


def _full(data):
    """The plan's figures and the remuneration it would pay."""
    cfg = remuneration.config(db())
    plan = rab_rot.clean(data)
    calc = rab_rot.compute(plan, cfg)
    remu = rab_rot.remuneration_preview(plan, calc, _people(), cfg)
    for po in remu["payouts"]:
        po["grade_label"] = next(("%s %s" % (x["code"], x["title"]) for x in cfg["grades"] if x["grade"] == po.get("grade")), "")
    return plan, calc, remu


def _header(d, plan):
    name = (d.get("name") or plan.get("project_name") or "").strip()
    if not name:
        raise ValueError("Give the plan a project name")
    status = d.get("status") or "draft"
    if status not in rab_rot.STATUSES:
        raise ValueError("Unknown status")
    return name, (d.get("company") or "").strip(), (d.get("prepared_by") or "").strip(), status


def _meta(row):
    return {k: row[k] for k in row.keys() if k != "data"}


@app.get("/api/plans")
def plans_list():
    out = []
    cfg = remuneration.config(db())
    for r in db().execute("SELECT * FROM rab_plans ORDER BY updated_at DESC, id DESC"):
        d = _meta(r)
        try:
            plan = rab_rot.clean(json.loads(r["data"] or "{}"))
            c = rab_rot.compute(plan, cfg)
            d.update({"value": c["value"], "net": c["net"], "cogs": c["cogs"], "review_cogs": c["review"]["cogs"],
                      "nct": c["review"]["nct"], "review_margin": c["review"]["margin"], "signal": c["review"]["status"],
                      "lines": len(plan["lines"]), "client": plan["client"], "year": plan["year"]})
        except (ValueError, TypeError):
            d["signal"] = "none"
        out.append(d)
    return jsonify(out)


@app.get("/api/blank")
def plan_blank():
    plan, calc, remu = _full(rab_rot.blank_plan())
    return jsonify({"data": plan, "calc": calc, "remu": remu})


@app.post("/api/calc")
def plan_calc():
    """Recalculate a plan as it is typed - nothing is saved."""
    plan, calc, remu = _full((request.get_json(force=True) or {}).get("data") or {})
    return jsonify({"data": plan, "calc": calc, "remu": remu})


@app.get("/api/plans/<int:pid>")
def plan_get(pid):
    row = _plan_row(pid)
    plan, calc, remu = _full(json.loads(row["data"] or "{}"))
    return jsonify({"plan": _meta(row), "data": plan, "calc": calc, "remu": remu})


@app.post("/api/plans")
def plan_create():
    d = request.get_json(force=True) or {}
    plan = rab_rot.clean(d.get("data") or rab_rot.blank_plan())
    name, company, who, status = _header(d, plan)
    cur = db().execute("INSERT INTO rab_plans (name, company, prepared_by, status, data) VALUES (?,?,?,?,?)",
                       (name, company, who, status, rab_rot.dumps(plan)))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.put("/api/plans/<int:pid>")
def plan_update(pid):
    row = _plan_row(pid)
    d = request.get_json(force=True) or {}
    for k in ("company", "prepared_by"):          # a field not sent keeps its value
        d.setdefault(k, row[k])
    plan = rab_rot.clean(d.get("data") or {})
    name, company, who, status = _header(d, plan)
    db().execute("UPDATE rab_plans SET name=?, company=?, prepared_by=?, status=?, data=?, updated_at=datetime('now') WHERE id=?",
                 (name, company, who, status, rab_rot.dumps(plan), pid))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/plans/<int:pid>/copy")
def plan_copy(pid):
    """A new draft from an old plan - the next project usually looks like the last."""
    row = _plan_row(pid)
    cur = db().execute("INSERT INTO rab_plans (name, company, prepared_by, status, data) VALUES (?,?,?,?,?)",
                       (row["name"] + " (copy)", row["company"], row["prepared_by"], "draft", row["data"]))
    db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.delete("/api/plans/<int:pid>")
def plan_delete(pid):
    _plan_row(pid)
    db().execute("DELETE FROM rab_plans WHERE id=?", (pid,))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/import")
def plan_import():
    """Read a RAB ROT Excel sheet into a new draft plan."""
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith((".xlsx", ".xlsm")):
        raise ValueError("Choose the RAB ROT Excel file (.xlsx)")
    plan = rab_rot.import_xlsx(io.BytesIO(f.read()))
    plan["project_name"] = plan["project_name"] or os.path.splitext(f.filename)[0]
    cur = db().execute("INSERT INTO rab_plans (name, company, status, data) VALUES (?,?,?,?)",
                       (plan["project_name"], "", "draft", rab_rot.dumps(plan)))
    db().commit()
    return jsonify({"id": cur.lastrowid, "lines": len(plan["lines"]), "entities": len(plan["entities"])}), 201


@app.get("/api/plans/<int:pid>/pdf")
def plan_pdf(pid):
    row = _plan_row(pid)
    plan, calc, remu = _full(json.loads(row["data"] or "{}"))
    meta = _meta(row)
    meta.update({"created_by": row["prepared_by"] or "-", "updated_by": row["prepared_by"] or "-"})
    buf = pdf_report.export_rab_rot_pdf(meta, plan, calc, remu, "", datetime.now().strftime("%d/%m/%Y"))
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", row["name"]).strip("_")[:60] or "plan"
    return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name="RAB_ROT_%s.pdf" % name)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8100))
    print("MORES RAB ROT running at http://127.0.0.1:%d" % port)
    app.run(host="127.0.0.1", port=port, debug=False)
