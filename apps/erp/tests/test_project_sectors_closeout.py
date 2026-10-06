"""v1.11: project sectors (project types) and the close-out PDF.

Covers the rules that must not quietly change: one project has one sector
whichever screen set it (Project Details or the Money Tracker), a caller that
knows nothing of sectors never wipes one, a type in use cannot be deleted, and
the close-out report of a Done project keeps its gross profit on page 1 and
the account detail from page 2 - however many accounts the project used.

    python apps/erp/tests/test_project_sectors_closeout.py
"""
import io
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="sector_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import pdf_export  # noqa: E402
import reports  # noqa: E402
import server  # noqa: E402
import pdfplumber  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-12s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-12s %s" % (name, detail))


c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200

print("=== the list of project types ===")
types = c.get("/api/project-types").get_json()
names = [x["name"] for x in types]
check("SEEDED", names[:2] == ["Infrastructure", "Consulting & Research"] and len(types) == 6, ", ".join(names))
r = c.post("/api/project-types", json={"name": "infrastructure", "color": "#112233"})
check("UNIQUE", r.status_code == 400, "a second 'infrastructure' is refused: %s" % r.get_json().get("error"))
r = c.post("/api/project-types", json={"name": "Mining", "color": "red"})
check("COLOUR", r.status_code == 400, "a colour must be #rrggbb")
mining = c.post("/api/project-types", json={"name": "Mining", "color": "#7a5c2e"}).get_json()["id"]
r = c.put("/api/project-types/%d" % mining, json={"name": "Mining & Energy", "color": "#7a5c2e", "is_active": False})
row = next(x for x in c.get("/api/project-types").get_json() if x["id"] == mining)
check("EDIT", r.status_code == 200 and row["name"] == "Mining & Energy" and not row["is_active"], "renamed and switched off")
infra = types[0]["id"]
consult = types[1]["id"]

print("=== a project's sector ===")
companies = c.get("/api/companies").get_json()
cid = companies[0]["id"]
p1 = c.post("/api/projects", json={"company_id": cid, "code": "SEC-01", "name": "Toll road study",
                                   "type_id": infra}).get_json()["id"]
proj = lambda pid: next(p for p in c.get("/api/projects?company_id=all").get_json() if p["id"] == pid)
check("CREATE", proj(p1)["type_id"] == infra and proj(p1)["type_name"] == "Infrastructure", "created in a sector")
c.put("/api/projects/%d" % p1, json={"name": "Toll road study", "status": "active", "contract_value": 5000000})
check("KEEP", proj(p1)["type_id"] == infra, "an edit that does not send a sector leaves it alone")
c.put("/api/projects/%d/type" % p1, json={"type_id": consult})
check("INLINE", proj(p1)["type_id"] == consult, "the picker on the list changes it")
r = c.put("/api/projects/%d/type" % p1, json={"type_id": 99999})
check("UNKNOWN", r.status_code == 400 and proj(p1)["type_id"] == consult, "an unknown sector is refused")
r = c.delete("/api/project-types/%d" % consult)
check("IN-USE", r.status_code == 400 and any(x["id"] == consult for x in c.get("/api/project-types").get_json()),
      "a sector still on a project cannot be deleted")

print("=== the Money Tracker flags the same sector ===")
t1 = c.post("/api/money-tracker", json={"company_id": cid, "project_id": p1, "title": "Termin 1",
                                        "amount": 1000000, "type_id": infra}).get_json()["id"]
track = lambda tid: c.get("/api/money-tracker/%d" % tid).get_json()
check("MT-SETS", proj(p1)["type_id"] == infra and track(t1)["sector_id"] == infra,
      "flagging a track Infrastructure flags its project")
t2 = c.post("/api/money-tracker", json={"company_id": cid, "title": "Bridge prospect", "amount": 2000000,
                                        "status": "prospectus", "type_id": infra}).get_json()["id"]
check("MT-OWN", track(t2)["sector_id"] == infra and track(t2)["type_name"] == "Infrastructure",
      "a prospect with no project keeps its own flag")
p2 = c.post("/api/projects", json={"company_id": cid, "code": "SEC-02", "name": "Bridge"}).get_json()["id"]
m = track(t2)
c.put("/api/money-tracker/%d" % t2, json={k: m[k] for k in ("title", "client", "invoice_no", "amount", "phase_key",
                                                              "status", "started_at", "notes")} | {"project_id": p2})
check("INHERIT", proj(p2)["type_id"] == infra, "linked later to a project with no sector, the project takes the flag")
lst = c.get("/api/money-tracker").get_json()["items"]
check("MT-LIST", next(i for i in lst if i["id"] == t2)["sector_id"] == infra, "the list shows it")

print("=== the close-out report ===")
conn = database.get_db(database.DEFAULT_DB)
acc = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM accounts WHERE company_id=?", (cid,))}
expense = [r["id"] for r in conn.execute(
    "SELECT id FROM accounts WHERE company_id=? AND type='expense' AND code LIKE '%-%' OR "
    "(company_id=? AND type='expense' AND code GLOB '6[0-9][0-9][0-9]')", (cid, cid))]
conn.close()
# enough cost accounts that page 1 cannot list them all - the folding must kick in
for k in range(1, 15):
    made = c.post("/api/accounts", json={"company_id": cid, "code": "6900-%02d" % k,
                                         "name": "Site cost %d" % k, "type": "expense"}).get_json()
    expense.append(made["id"])
bank = acc["1120"]
rev = next(v for k, v in acc.items() if k.startswith("4"))
post = lambda date, lines: c.post("/api/journals", json={"company_id": cid, "date": date, "description": "sec test",
                                                         "status": "posted", "lines": lines})
post("2025-11-03", [{"account_id": bank, "debit": 50000000, "credit": 0},
                    {"account_id": rev, "debit": 0, "credit": 50000000, "project_id": p1}])
for i, a in enumerate(expense[:28]):
    post("2026-0%d-1%d" % (1 + i % 8, i % 9), [{"account_id": a, "debit": 100000 * (i + 1), "credit": 0, "project_id": p1},
                                               {"account_id": bank, "debit": 0, "credit": 100000 * (i + 1)}])
r = c.get("/api/projects/%d/closeout.pdf" % p1)
check("NOT-DONE", r.status_code == 400 and "Done" in r.get_json().get("error", ""), "only a project marked Done gets one")
c.put("/api/projects/%d" % p1, json={"name": "Toll road study", "status": "completed", "contract_value": 60000000})
r = c.get("/api/projects/%d/closeout.pdf" % p1)
check("PDF", r.status_code == 200 and r.mimetype == "application/pdf" and r.data[:5] == b"%PDF-", "%d bytes" % len(r.data))
conn = database.get_db(database.DEFAULT_DB)
data = reports.project_closeout(conn, p1)
conn.close()
with pdfplumber.open(io.BytesIO(r.data)) as pdf:
    pages = [pg.extract_text() or "" for pg in pdf.pages]
check("PAGE-1", "Project Close-out Report" in pages[0] and "GROSS PROFIT" in pages[0]
      and pdf_export.money(data["gross_profit"]) in pages[0] and "Infrastructure" not in pages[0].split("Sector")[0],
      "gross profit %s on page 1, whole-life (the 2025 revenue counts)" % pdf_export.money(data["gross_profit"]))
check("WHOLE-LIFE", data["total_revenue"] == 50000000 and data["first_date"] == "2025-11-03",
      "revenue from 2025 and cost from 2026 on one report")
check("FITS", pages[1].strip().splitlines()[1].startswith("Detail per account") and "Other cost accounts" in pages[0],
      "%d cost accounts: the smallest fold into one row so page 1 still holds the whole table" % len(data["cost"]))
detail = "\n".join(pages[1:])
check("DETAIL", all(("Total %s" % a["code"]) in detail for a in data["cost"] + data["revenue"]),
      "every account has its own block and total from page 2 on")
check("PAGED", all(("Page %d of %d" % (i + 1, len(pages))) in pg for i, pg in enumerate(pages)),
      "%d pages, each numbered" % len(pages))
check("SECTOR", "Consulting & Research" in pages[0] or "Infrastructure" in pages[0], "the sector is printed")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
