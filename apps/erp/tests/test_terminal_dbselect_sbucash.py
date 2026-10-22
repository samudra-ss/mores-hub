"""v1.12 round 3: the terminal sign-in, the database-select screen and the SBU
cash popup on the CEO Dashboard.

What must not drift:
  * the sign-in and the database select are the pages the routes serve, and the
    database select lists the same painted backgrounds the server accepts (each
    with its picture on disk);
  * a database's background is a scene key or an uploaded picture kept INSIDE
    that database; only an admin changes it, a frozen database's picture is not
    shown to a role that may not enter it, and only real pictures are accepted;
  * the SBU cash brief reads revenue as cash in and cost as cash out on the SBU's
    projects - its linked projects plus every project of its source company -
    from EVERY company's books (NX costs are booked in MDA), leaves depreciation
    (65xx) out, and the source company can be chosen by finance, not a viewer.

    python apps/erp/tests/test_terminal_dbselect_sbucash.py
"""
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
TMP = tempfile.mkdtemp(prefix="termdb_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
database.create_database("SANDBOX X", seed_demo=False)
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


for name in (database.DEFAULT_DB, "SANDBOX X"):
    conn = database.get_db(name)
    database.migrate_database(conn)
    conn.execute("INSERT OR IGNORE INTO users (username, password_hash, full_name, role, company_access) VALUES (?,?,?,?,?)",
                 ("dbview", generate_password_hash("viewer-pass-1"), "Viewer", "viewer", "all"))
    conn.commit()
    conn.close()

c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
v = server.app.test_client()
assert v.post("/api/login", json={"username": "dbview", "password": "viewer-pass-1"}).status_code == 200
PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82")

print("=== the pages ===")
anon = server.app.test_client()
r = anon.get("/login")
html = r.data.decode("utf-8")
r.close()
check("LOGIN", r.status_code == 200 and "Welcome to MORES HV<" in html and 'data-level="low"' in html and 'data-level="high"' in html,
      "the terminal sign-in with its LOW / HIGH display levels")
r = anon.get("/")
home = r.data.decode("utf-8")
r.close()
ver = lambda h: re.search(r"Version ([0-9.]+)", h)
check("HOME", r.status_code == 200 and "/static/terminal.css" in home and "/static/terminal.css" in html
      and "mores-logo-ondark.png" in home and "mores-logo-ondark.png" in html, "home and sign-in share the terminal theme and the MORES logo")
check("VERSION", ver(home) and ver(html) and ver(home).group(1) == ver(html).group(1) and 'class="mid' in html,
      "both state the same version (%s), the sign-in at the bottom middle" % (ver(html).group(1) if ver(html) else "?"))
for asset in ("/static/terminal.css", "/static/terminal.js", "/static/assets/mores-logo-ondark.png"):
    r = anon.get(asset)
    check("ASSET", r.status_code == 200, asset + " is served")
    r.close()
check("LOGIN-API", '"/api/login"' in html and 'location.href = "/databases"' in html, "it signs in and goes on to the database select")
r = c.get("/databases")
page = r.data.decode("utf-8")
r.close()
check("DBSELECT", r.status_code == 200 and "Database Select" in page, "the database-select screen")
keys = tuple(re.findall(r"\['([a-z]+)', '[A-Z][a-z]+'\]", page[page.index("const SCENES"):page.index("const GROUPS")]))
check("SCENE-KEYS", keys == server.DB_ART, "the page and the server list the same backgrounds: %s" % ", ".join(keys))
missing = [k for k in server.DB_ART if not os.path.isfile(os.path.join(ERP, "static", "assets", "art", "db-%s.webp" % k))]
check("SCENE-FILES", not missing, "every background has its picture on disk" + (" (missing %s)" % missing if missing else ""))

print("=== a database's background ===")
lst = {d["name"]: d for d in c.get("/api/databases").get_json()["databases"]}
check("DEFAULT", lst["SANDBOX X"]["picture"] == "" and lst["SANDBOX X"]["picture_v"] is None, "no background chosen yet")
r = c.put("/api/databases/SANDBOX X/profile", json={"picture": "vault"})
lst = {d["name"]: d for d in c.get("/api/databases").get_json()["databases"]}
check("SET-SCENE", r.status_code == 200 and lst["SANDBOX X"]["picture"] == "vault", "an admin picks the Vault scene")
r = c.put("/api/databases/SANDBOX X/profile", json={"picture": "../../etc"})
check("BAD-SCENE", r.status_code == 400, "an unknown scene is refused")
r = c.put("/api/databases/SANDBOX X/profile", json={"icon": "⭐"})
lst = {d["name"]: d for d in c.get("/api/databases").get_json()["databases"]}
check("KEEP-SCENE", lst["SANDBOX X"]["picture"] == "vault", "saving the other settings keeps the scene")
r = v.post("/api/databases/SANDBOX X/picture", data={"file": (__import__("io").BytesIO(PNG), "p.png")})
check("VIEW-UPLOAD", r.status_code == 403, "a viewer cannot upload a background")
r = c.post("/api/databases/SANDBOX X/picture", data={"file": (__import__("io").BytesIO(b"<svg onload=x>"), "x.svg")})
check("SVG-REFUSED", r.status_code == 400, "a file that is not a picture is refused")
r = c.post("/api/databases/SANDBOX X/picture", data={"file": (__import__("io").BytesIO(PNG), "p.png")})
lst = {d["name"]: d for d in c.get("/api/databases").get_json()["databases"]}
check("UPLOAD", r.status_code == 200 and lst["SANDBOX X"]["picture_v"], "an admin uploads one; the list carries its version")
conn = database.get_db("SANDBOX X")
kept = conn.execute("SELECT mime FROM entity_images WHERE kind='database' AND entity_id=1").fetchone()
conn.close()
conn = database.get_db(database.DEFAULT_DB)
other = conn.execute("SELECT COUNT(*) FROM entity_images WHERE kind='database'").fetchone()[0]
conn.close()
check("INSIDE", kept and kept[0] == "image/png" and other == 0, "it is kept inside that database only")
r = v.get("/api/databases/SANDBOX X/picture")
check("VIEW-SEE", r.status_code == 200 and r.mimetype == "image/png", "a role that may enter sees the picture")
r.close()
c.put("/api/databases/SANDBOX X/profile", json={"frozen": True})
r = v.get("/api/databases/SANDBOX X/picture")
check("FROZEN", r.status_code == 403, "a frozen database's picture is not shown to a viewer")
r.close()
r = c.get("/api/databases/SANDBOX X/picture")
check("ADMIN-SEE", r.status_code == 200, "the admin still sees it")
r.close()
c.put("/api/databases/SANDBOX X/profile", json={"frozen": False})
r = c.delete("/api/databases/SANDBOX X/picture")
lst = {d["name"]: d for d in c.get("/api/databases").get_json()["databases"]}
check("REMOVE", r.status_code == 200 and lst["SANDBOX X"]["picture_v"] is None and lst["SANDBOX X"]["picture"] == "vault",
      "removing the upload falls back to the chosen scene")
r = c.get("/api/databases/NOPE/picture")
check("UNKNOWN-DB", r.status_code == 400, "an unknown database is an error, not a crash")

print("=== the SBU cash brief ===")
r = c.post("/api/companies", json={"code": "NXT", "name": "Nexus Test (MORES NX)"})
assert r.status_code in (200, 201), r.get_json()
companies = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}
nxt, mda = companies["NXT"], companies["MDA"]
mk = lambda cid, code: c.post("/api/projects", json={"company_id": cid, "code": code, "name": code + " project"}).get_json()["id"]
p_linked, p_sib, p_mda = mk(nxt, "NXT-01"), mk(nxt, "NXT-02"), mk(mda, "MDA-X9")
sbu = c.post("/api/products", json={"name": "NX SBU", "company_id": mda}).get_json()["id"]
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO product_projects (product_id, project_id) VALUES (?,?)", (sbu, p_linked))
conn.commit()
conn.close()
acc = {a["code"]: a["id"] for a in c.get("/api/accounts?company_id=%d" % mda).get_json()}


def post(lines, date="2026-04-10", status="posted"):
    r = c.post("/api/journals", json={"company_id": mda, "date": date, "description": "nx test", "status": status, "lines": lines})
    assert r.status_code == 201, r.get_json()


# booked in MDA's books, tagged to the NX projects - as on the real data
post([{"account_id": acc["1120"], "debit": 100e6, "credit": 0},
      {"account_id": acc["4100"], "debit": 0, "credit": 100e6, "project_id": p_linked}])
post([{"account_id": acc["6200"], "debit": 40e6, "credit": 0, "project_id": p_linked},
      {"account_id": acc["6500"], "debit": 10e6, "credit": 0, "project_id": p_linked},
      {"account_id": acc["1120"], "debit": 0, "credit": 50e6}])
post([{"account_id": acc["6200"], "debit": 5e6, "credit": 0, "project_id": p_sib},
      {"account_id": acc["1120"], "debit": 0, "credit": 5e6}])
post([{"account_id": acc["6200"], "debit": 7e6, "credit": 0, "project_id": p_mda},
      {"account_id": acc["1120"], "debit": 0, "credit": 7e6}])
post([{"account_id": acc["6200"], "debit": 99e6, "credit": 0, "project_id": p_sib},
      {"account_id": acc["1120"], "debit": 0, "credit": 99e6}], status="draft")
post([{"account_id": acc["6200"], "debit": 3e6, "credit": 0, "project_id": p_sib},
      {"account_id": acc["1120"], "debit": 0, "credit": 3e6}], date="2025-12-20")

b = c.get("/api/products/%d/cash-brief?company_id=all&year=2026" % sbu).get_json()
ids = {p["id"] for p in b["projects"]}
check("SOURCE", b["source"] == "linked" and b["source_company"]["id"] == nxt,
      "with nothing chosen the source is the linked projects' company (%s)" % b["source_company"]["name"])
check("PROJECTS", ids == {p_linked, p_sib}, "its projects: the linked one plus every project of that company, not MDA's")
check("CASH-IN", b["cash_in"] == 100e6, "cash in = revenue booked to them (Rp %s)" % b["cash_in"])
check("CASH-OUT", b["cash_out"] == 45e6, "cash out = cost booked to them, depreciation, drafts and last year left out (Rp %s)" % b["cash_out"])
check("NET", b["net"] == 55e6, "net Rp %s" % b["net"])
first = b["projects"][0]
check("PER-PROJECT", first["id"] == p_linked and first["cash_out"] == 40e6 and first["linked"] == 1
      and next(p for p in b["projects"] if p["id"] == p_sib)["cash_out"] == 5e6,
      "outflow per project, biggest first: NXT-01 Rp 40 jt (linked), NXT-02 Rp 5 jt")
b25 = c.get("/api/products/%d/cash-brief?company_id=all&year=2025" % sbu).get_json()
check("YEAR", b25["cash_out"] == 3e6 and b25["cash_in"] == 0, "the year asked for is the year read")

r = v.put("/api/products/%d/cash-source" % sbu, json={"company_id": mda})
check("VIEW-SOURCE", r.status_code == 403, "a viewer cannot change the source company")
r = c.put("/api/products/%d/cash-source" % sbu, json={"company_id": mda})
b = c.get("/api/products/%d/cash-brief?company_id=all&year=2026" % sbu).get_json()
ids = {p["id"] for p in b["projects"]}
check("CHOSEN", r.status_code == 200 and b["source"] == "chosen" and b["source_company"]["id"] == mda
      and p_mda in ids and p_linked in ids and p_sib not in ids,
      "choosing MDA reads MDA's projects plus the linked one")
c.put("/api/products/%d/cash-source" % sbu, json={"company_id": None})
b = c.get("/api/products/%d/cash-brief?company_id=all&year=2026" % sbu).get_json()
check("AUTO-AGAIN", b["source"] == "linked" and b["source_company"]["id"] == nxt, "clearing it goes back to automatic")
lonely = c.post("/api/products", json={"name": "Empty SBU", "company_id": mda}).get_json()["id"]
b = c.get("/api/products/%d/cash-brief?company_id=all&year=2026" % lonely).get_json()
check("EMPTY", b["source"] == "none" and b["projects"] == [] and b["cash_out"] == 0, "an SBU with no projects shows nothing, not an error")
js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
check("CLICK", "sbuCashPopup(s)" in js and "/cash-brief?" in js, "clicking an SBU picture opens the cash popup")

print("\n%d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
