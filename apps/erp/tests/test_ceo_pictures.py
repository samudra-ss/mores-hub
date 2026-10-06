"""v1.11 revision 3: the CEO Dashboard's picture trackers and the SBU /
Investment Center chooser.

Covers what must not quietly drift: the painted scene an SBU or an initiative
wears is one of a fixed set (the server and app.js list the same keys, and every
key has its picture on disk); choosing one is the owner's write, never a viewer's;
and the SBU tracker's "budget used" is the SBU report's own cost so far against
its own full-year cost budget - the same numbers the SBU dashboard shows.

    python apps/erp/tests/test_ceo_pictures.py
"""
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
TMP = tempfile.mkdtemp(prefix="ceopic_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import server  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

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
companies = {x["code"]: x for x in c.get("/api/companies").get_json()}
mda = companies["MDA"]["id"]

print("=== the painted scenes ===")
js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
block = js[js.index("const ART = {"):js.index("const INV_ART")]
spans = {"product": block[block.index("  product: ["):block.index("  investment: [")],
         "investment": block[block.index("  investment: ["):block.index("  project: [")]}
for kind, prefix in (("product", "sbu"), ("investment", "inv")):
    client_keys = tuple(re.findall(r'\["([a-z]+)", "', spans[kind]))
    check("KEYS-" + prefix.upper(), client_keys == server.ART_KEYS[kind],
          "app.js and the server list the same %s scenes: %s" % (kind, ", ".join(client_keys)))
    missing = [k for k in server.ART_KEYS[kind]
               if not os.path.isfile(os.path.join(ERP, "static", "assets", "art", "%s-%s.webp" % (prefix, k)))]
    check("FILES-" + prefix.upper(), not missing, "every scene has its picture on disk" + (" (missing %s)" % missing if missing else ""))
line = js[js.index("const INV_ART"):js.index("};", js.index("const INV_ART"))]
inv_map = dict(re.findall(r'(\w+): "(\w+)"', line))
cats_src = js[js.index("const INV_CATEGORIES = {"):js.index("};", js.index("const INV_CATEGORIES = {"))]
cats = set(re.findall(r'(\w+): "', cats_src))
check("INV-CATS", set(inv_map) == cats and set(inv_map.values()) <= set(server.ART_KEYS["investment"])
      and len(set(inv_map.values())) == len(inv_map), "each investment category has a scene of its own")
check("MASK", os.path.isfile(os.path.join(ERP, "static", "assets", "art", "brush-mask.png")), "the painted-edge mask is there")
r = c.get("/static/assets/art/sbu-watchtower.webp")
check("SERVED", r.status_code == 200 and r.data[:4] == b"RIFF" and r.data[8:12] == b"WEBP", "served as a WebP picture")
r.close()

print("=== choosing a scene ===")
conn = database.get_db(database.DEFAULT_DB)
cols = {r[1] for r in conn.execute("PRAGMA table_info(products)")} & {r[1] for r in conn.execute("PRAGMA table_info(investments)")}
check("COLUMNS", "art" in cols, "products.art and investments.art exist")
database.migrate_database(conn)
check("IDEMPOTENT", "art" in {r[1] for r in conn.execute("PRAGMA table_info(products)")}, "the migration runs twice without harm")
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access) VALUES (?,?,?,?,?)",
             ("picview", generate_password_hash("viewer-pass-1"), "Viewer", "viewer", "all"))
conn.commit()
conn.close()
pid = c.post("/api/products", json={"name": "Watch SBU", "company_id": mda}).get_json()["id"]
iid = c.post("/api/investments", json={"company_id": mda, "name": "Talent Orchard", "category": "scholarship",
                                       "committed_amount": 100000000}).get_json()["id"]
put = lambda cl, kind, eid, art: cl.put("/api/images/%s/%d/art" % (kind, eid), json={"art": art})
r = put(c, "product", pid, "observatory")
check("SET-SBU", r.status_code == 200 and next(p for p in c.get("/api/products").get_json() if p["id"] == pid)["art"] == "observatory",
      "the SBU list carries the chosen scene")
r = put(c, "product", pid, "orchard")
check("WRONG-KIND", r.status_code == 400 and "Unknown" in r.get_json()["error"], "an investment scene is refused for an SBU")
r = put(c, "investment", iid, "bridge")
check("SET-INV", r.status_code == 200 and next(i for i in c.get("/api/investments?company_id=all").get_json() if i["id"] == iid)["art"] == "bridge",
      "the investment list carries the chosen scene")
r = put(c, "investment", iid, None)
check("RESET", r.status_code == 200 and next(i for i in c.get("/api/investments?company_id=all").get_json() if i["id"] == iid)["art"] is None,
      "no choice = back to the scene of its category")
check("BAD-KIND", put(c, "journal", 1, "forge").status_code == 400, "only SBUs, investments, projects and invoice tracks have scenes")
check("MISSING", put(c, "product", 999999, "forge").status_code in (400, 404), "an SBU that does not exist")
v = server.app.test_client()
assert v.post("/api/login", json={"username": "picview", "password": "viewer-pass-1"}).status_code == 200
check("VIEWER", put(v, "product", pid, "forge").status_code == 403, "a viewer cannot change it")
check("UNCHANGED", next(p for p in c.get("/api/products").get_json() if p["id"] == pid)["art"] == "observatory",
      "and the choice stays as it was")

print("=== the SBU tracker's budget used ===")
# a second SBU spending from a fresh project: Rp 10 jt cost budget a month, Rp 25 jt spent in March
import excel_io  # noqa: E402
prj = c.post("/api/projects", json={"company_id": mda, "code": "PIC-01", "name": "Picture test project"}).get_json()["id"]
spender = c.post("/api/products", json={"name": "Spending SBU", "company_id": mda}).get_json()["id"]
accts = {a["code"]: a["id"] for a in c.get("/api/accounts?company_id=%d" % mda).get_json()}
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO product_projects (product_id, project_id) VALUES (?,?)", (spender, prj))
for m in range(1, 13):
    excel_io.upsert_budget(conn, mda, accts["5100-01"], prj, 2026, m, 10000000)
conn.commit()
conn.close()
r = c.post("/api/journals", json={"company_id": mda, "date": "2026-03-10", "description": "picture test cost", "status": "posted",
                                  "lines": [{"account_id": accts["5100-01"], "debit": 25000000, "credit": 0, "project_id": prj},
                                            {"account_id": accts["1120"], "debit": 0, "credit": 25000000}]})
assert r.status_code == 201, r.get_json()
d = c.get("/api/dashboard/ceo?company_id=all&year=2026").get_json()
sp = next(s for s in d["sbu"] if s["id"] == spender)
check("USED-PCT", sp["cost_budget"] == 120000000 and sp["cost_ytd"] == 25000000 and sp["budget_used_pct"] == 20.8,
      "Rp 25 jt of a Rp 120 jt year = %s%% (cost so far %s, year budget %s)" % (sp["budget_used_pct"], sp["cost_ytd"], sp["cost_budget"]))
sbus = d["sbu"]
check("SBU-LIST", isinstance(sbus, list) and any(s["id"] == pid for s in sbus), "%d SBU(s) on the dashboard" % len(sbus))
mine = next(s for s in sbus if s["id"] == pid)
check("SBU-ART", mine["art"] == "observatory" and mine["company_code"] == "MDA" and "stage" in mine,
      "each tile carries its scene, company and stage")
cost = lambda x: (x.get("cogs") or 0) + (x.get("opex") or 0) + (x.get("da") or 0)
all_match = True
with_budget = 0
for s in sbus:
    if s.get("error"):
        continue
    rep = c.get("/api/products/%d/report?year=2026" % s["id"]).get_json()
    spent, full = cost(rep["pnl"]["ytd"]["actual"]), cost(rep["pnl"]["full"]["budget"])
    pct = round(100.0 * spent / full, 1) if full else None
    with_budget += bool(full)
    if abs(s["cost_ytd"] - round(spent, 2)) > 0.01 or abs(s["cost_budget"] - round(full, 2)) > 0.01 or s["budget_used_pct"] != pct:
        all_match = False
        print("     mismatch", s["id"], s["cost_ytd"], spent, s["cost_budget"], full, s["budget_used_pct"], pct)
check("SAME-NUMBERS", all_match, "cost so far / full-year cost budget = the SBU report's own P&L (%d with a budget)" % with_budget)
check("NO-BUDGET", mine["budget_used_pct"] is None and mine["cost_budget"] == 0,
      "an SBU with no cost budget says so instead of dividing by zero")
check("INV-TILES", all("art" in r and "committed_amount" in r and "invested" in r for r in d["investments"]["rows"]),
      "investment tiles carry their scene, allocated and used")

print("=== the menu ===")
html = open(os.path.join(ERP, "static", "app.html"), encoding="utf-8").read()
hv = re.findall(r'data-route="(\w+)" data-sec="hv"', html)
check("HV-ORDER", hv == ["dashboard", "projecthv", "projects", "money", "product", "investments", "oracle"], " > ".join(hv))
check("JCO", "Jakarta Cost Office" in html and "Expense Breakdown" not in html, "Expense Breakdown is now Jakarta Cost Office")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
