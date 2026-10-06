"""v1.11 round 4: Project Details is the mother, the Money Tracker follows it.

Covers what must not quietly change: a project's invoices never add up to more
than its contract value (whichever screen writes them), a planned invoicing is
all or nothing, an invoice is billed by its project's company, the
harmonization check finds every kind of drift and its fixes repair exactly that;
plus the SBU type, and pictures for projects and invoice tracks.

    python apps/erp/tests/test_harmony_pictures.py
"""
import io
import os
import re
import shutil
import struct
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
TMP = tempfile.mkdtemp(prefix="harmony_")
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
        print("  PASS  %-13s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-13s %s" % (name, detail))


def png(w=2, h=2, rgb=(200, 120, 40)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
companies = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}
mda, other = companies["MDA"], next(v for k, v in companies.items() if k != "MDA")
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access) VALUES (?,?,?,?,?)",
             ("hmview", generate_password_hash("viewer-pass-1"), "Viewer", "viewer", "all"))
conn.commit()
conn.close()
v = server.app.test_client()
assert v.post("/api/login", json={"username": "hmview", "password": "viewer-pass-1"}).status_code == 200


def project(code, cv=0, status="active", company=None):
    r = c.post("/api/projects", json={"company_id": company or mda, "code": code, "name": "Project " + code,
                                      "status": status, "contract_value": cv})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def track(pid, amount, status="active", company=None, title="Termin"):
    return c.post("/api/money-tracker", json={"company_id": company or mda, "project_id": pid, "title": title,
                                              "amount": amount, "phase_key": "p1", "status": status})


print("=== the contract rule ===")
p1 = project("HM-01", 100000000)
r = track(p1, 60000000)
check("FITS", r.status_code == 201, "Rp 60 jt of a Rp 100 jt contract")
t1 = r.get_json()["id"]
r = track(p1, 50000000)
check("REFUSED", r.status_code == 400 and "Project Details" in r.get_json()["error"], "Rp 60 + 50 jt > Rp 100 jt is refused")
r = track(p1, 50000000, status="cancelled")
check("CANCELLED", r.status_code == 201, "a cancelled invoice bills nothing, so it fits")
t_cx = r.get_json()["id"]
r = c.post("/api/money-tracker/%d/status" % t_cx, json={"status": "active"})
check("REVIVE", r.status_code == 400, "bringing the cancelled one back would pass the contract - refused")
r = c.put("/api/money-tracker/%d" % t1, json={"project_id": p1, "title": "Termin", "amount": 100000001, "phase_key": "p1", "status": "active"})
check("UPDATE", r.status_code == 400, "an edit past the contract is refused too")
r = c.put("/api/money-tracker/%d" % t1, json={"project_id": p1, "title": "Termin", "amount": 100000000, "phase_key": "p1", "status": "active"})
check("EXACT", r.status_code == 200, "exactly the contract is fine")
c.put("/api/money-tracker/%d" % t1, json={"project_id": p1, "title": "Termin", "amount": 60000000, "phase_key": "p1", "status": "active"})
r = track(p1, 10000000, company=other)
row = c.get("/api/money-tracker/%d" % r.get_json()["id"]).get_json()
check("COMPANY", row["company_id"] == mda and row["project_contract"] == 100000000,
      "billed by the project's company whatever the form said, and the track knows its contract")
p0 = project("HM-00")
check("NO-CV", track(p0, 5000000).status_code == 201, "no contract value yet: nothing to check against (the check reports it)")

print("=== revenue invoicing from Project Details ===")
inv = c.get("/api/projects/%d/invoicing" % p1).get_json()
check("SHAPE", inv["project"]["contract_value"] == 100000000 and inv["invoiced"] == 70000000 and inv["remaining"] == 30000000
      and len(inv["tracks"]) == 3, "contract 100, invoiced 70 (the cancelled one left out), 30 to plan")
r = c.post("/api/projects/%d/invoicing" % p1, json={"termins": [{"title": "T3", "amount": 20000000}, {"title": "T4", "amount": 20000000}]})
after = c.get("/api/projects/%d/invoicing" % p1).get_json()
check("ALL-OR-NONE", r.status_code == 400 and len(after["tracks"]) == 3, "20 + 20 > 30: neither termin is created")
r = c.post("/api/projects/%d/invoicing" % p1, json={"client": "Dinas PU", "termins": [{"title": "T3", "amount": 15000000}, {"title": "T4", "amount": 15000000}]})
after = c.get("/api/projects/%d/invoicing" % p1).get_json()
check("PLANNED", r.status_code == 200 and len(r.get_json()["created"]) == 2 and after["remaining"] == 0
      and all(t["company_id"] == mda and t["client"] == "Dinas PU" for t in after["tracks"] if t["title"] in ("T3", "T4")),
      "two termins created in the project's company, nothing left to plan")
r = c.post("/api/projects/%d/invoicing" % p1, json={"contract_value": 50000000})
check("CV-FLOOR", r.status_code == 400, "the contract cannot drop below what is invoiced")
pn = project("HM-02")
r = c.post("/api/projects/%d/invoicing" % pn, json={"termins": [{"title": "T1", "amount": 1000}]})
check("CV-FIRST", r.status_code == 400 and "contract value first" in r.get_json()["error"], "termins need a contract value")
r = c.post("/api/projects/%d/invoicing" % pn, json={"contract_value": 40000000, "termins": [{"title": "T1", "amount": 40000000}]})
check("CV+TERMIN", r.status_code == 200 and r.get_json()["remaining"] == 0, "set the contract and plan it in one go")
check("VIEWER-RO", v.post("/api/projects/%d/invoicing" % pn, json={"contract_value": 1}).status_code == 403
      and v.get("/api/projects/%d/invoicing" % pn).status_code == 200, "a viewer reads it, cannot write it")

print("=== the harmonization check ===")
H = lambda cl=c: cl.get("/api/money-tracker/harmony?company_id=all").get_json()
kinds = lambda h, pid=None: {i["kind"] for i in h["issues"] if pid is None or i["project_id"] == pid}
p_nc = project("HM-NC")                     # invoiced, but no contract value
track(p_nc, 7000000)
p_ni = project("HM-NI", 80000000)           # contract, nothing invoiced
p_un = project("HM-UN", 80000000)           # under-invoiced
track(p_un, 30000000)
p_ov = project("HM-OV", 80000000)           # over-invoiced (contract lowered behind its back)
track(p_ov, 80000000)
conn = database.get_db(database.DEFAULT_DB)
conn.execute("UPDATE projects SET contract_value=50000000 WHERE id=?", (p_ov,))
conn.commit()
p_do = project("HM-DO", 20000000, status="completed")   # done, invoice still open
track(p_do, 20000000)
p_pd = project("HM-PD", 20000000)           # fully received, project still open
t_pd = track(p_pd, 20000000).get_json()["id"]
conn.execute("UPDATE money_tracker SET status='done', phase_key='p12' WHERE id=?", (t_pd,))
conn.commit()
p_co = project("HM-CO", 20000000)           # billed by another company (moved behind its back)
t_co = track(p_co, 20000000).get_json()["id"]
conn.execute("UPDATE money_tracker SET company_id=? WHERE id=?", (other, t_co))
conn.commit()
types = [r[0] for r in conn.execute("SELECT id FROM project_types ORDER BY id")]
p_se = project("HM-SE", 20000000)
conn.execute("UPDATE projects SET type_id=? WHERE id=?", (types[0], p_se))
conn.commit()
t_se = track(p_se, 20000000).get_json()["id"]
conn.execute("UPDATE money_tracker SET type_id=? WHERE id=?", (types[1], t_se))
conn.commit()
conn.close()
loose = c.post("/api/money-tracker", json={"company_id": mda, "title": "Loose invoice", "amount": 1000000,
                                           "phase_key": "p3", "status": "active"}).get_json()["id"]
prospect = c.post("/api/money-tracker", json={"company_id": mda, "title": "A prospect", "amount": 1000000,
                                              "phase_key": "p1", "status": "prospectus"}).get_json()["id"]
h = H()
lv = {i["kind"]: i["level"] for i in h["issues"]}
check("NO-CONTRACT", "no_contract" in kinds(h, p_nc) and lv["no_contract"] == "danger", "invoiced without a contract value = danger")
check("NOT-INVOICED", "not_invoiced" in kinds(h, p_ni), "a contract with no invoice")
check("UNDER", "under" in kinds(h, p_un) and next(i for i in h["issues"] if i["project_id"] == p_un)["amount"] == 50000000,
      "Rp 50 jt of the contract has no invoice")
check("OVER", "over" in kinds(h, p_ov) and lv["over"] == "danger", "invoices beyond the contract = danger")
check("DONE-OPEN", "done_open" in kinds(h, p_do), "project Done, invoice still open")
check("PAID-OPEN", "paid_not_done" in kinds(h, p_pd), "fully received, project still active")
check("UNBOOKED", "unbooked" in kinds(h, p_pd), "received in the Money Tracker, no revenue in the ledger")
check("COMPANY-DIFF", "company" in kinds(h, p_co) and lv["company"] == "danger", "billed by another company = danger")
check("SECTOR-DIFF", "sector" in kinds(h, p_se), "the track's own sector flag differs")
loose_k = {i["kind"] for i in h["issues"] if i["track_id"] == loose}
check("NO-PROJECT", loose_k == {"no_project"} and not any(i["track_id"] == prospect for i in h["issues"]),
      "a live invoice with no project is flagged; a prospect is not")
check("CLEAN", not kinds(h, p1) - {"unbooked"} and not kinds(h, pn), "a project invoiced to its contract has nothing to say")
p_zz = project("HM-ZZ")                     # no contract value, no invoice
h = H()
check("NOT-SET", any(i["kind"] == "not_set" and i["level"] == "info" and i["project_id"] == p_zz for i in h["issues"]),
      "a project with no contract and no invoice is info, not an alarm")
check("NOT-HARMONIZED", h["harmonized"] is False and h["danger"] >= 3, "%d danger · %d watch · %d info" % (h["danger"], h["watch"], h["info"]))
check("VIEWER-READ", v.get("/api/money-tracker/harmony?company_id=all").status_code == 200, "anyone can run the check")
fix = lambda cl, **kw: cl.post("/api/money-tracker/harmony/fix", json=kw)
check("VIEWER-FIX", fix(v, kind="company", track_id=t_co).status_code == 403, "a viewer cannot fix")
r = fix(c, kind="company", track_id=t_co)
row = c.get("/api/money-tracker/%d" % t_co).get_json()
check("FIX-COMPANY", r.status_code == 200 and row["company_id"] == mda, "the track moves to its project's company")
r = fix(c, kind="sector", track_id=t_se)
conn = database.get_db(database.DEFAULT_DB)
tt, pt = conn.execute("SELECT m.type_id, p.type_id FROM money_tracker m JOIN projects p ON p.id=m.project_id WHERE m.id=?", (t_se,)).fetchone()
conn.close()
check("FIX-SECTOR", r.status_code == 200 and tt is None and pt == types[0], "the track drops its own flag; the project's sector stands")
r = fix(c, kind="done", project_id=p_pd)
check("FIX-DONE", r.status_code == 200 and next(p for p in c.get("/api/projects?company_id=all").get_json() if p["id"] == p_pd)["status"] == "completed",
      "marking the fully received project Done")
h = H()
check("FIXED", not kinds(h, p_co) and not kinds(h, p_se) and "paid_not_done" not in kinds(h, p_pd), "those three no longer show")
check("BAD-FIX", fix(c, kind="over", project_id=p_ov).status_code == 400, "only the offered fixes exist")

print("=== SBU type ===")
check("TYPES-SAME", tuple(re.findall(r'(\w+): "', open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read().split("const SBU_TYPES = {")[1].split("};")[0])) == server.SBU_TYPES,
      "app.js and the server list the same SBU types: %s" % ", ".join(server.SBU_TYPES))
sid = c.post("/api/products", json={"name": "Typed SBU", "company_id": mda, "sbu_type": "intel"}).get_json()["id"]
check("CREATE-TYPE", c.get("/api/products/%d" % sid).get_json()["sbu_type"] == "intel", "launched as Event Based (INTEL)")
check("BAD-TYPE", c.post("/api/products", json={"name": "X", "company_id": mda, "sbu_type": "banana"}).status_code == 400
      and c.put("/api/products/%d" % sid, json={"sbu_type": "banana"}).status_code == 400, "an unknown type is refused")
r = c.put("/api/products/%d" % sid, json={"sbu_type": "seal", "name": "Typed SBU 2"})
d = c.get("/api/products/%d" % sid).get_json()
check("EDIT-TYPE", r.status_code == 200 and d["sbu_type"] == "seal" and d["name"] == "Typed SBU 2", "the edit menu's partial save")
wb = c.get("/api/products/%d/workbook" % sid)
r = c.post("/api/products/%d/import" % sid, data={"file": (io.BytesIO(wb.data), "m.xlsx")}, content_type="multipart/form-data")
check("IMPORT-KEEPS", r.status_code == 200 and c.get("/api/products/%d" % sid).get_json()["sbu_type"] == "seal",
      "an Excel model import never wipes the type")
c.put("/api/products/%d" % sid, json={"sbu_type": None})
check("CLEAR-TYPE", c.get("/api/products/%d" % sid).get_json()["sbu_type"] is None, "the type can be cleared")
ceo = c.get("/api/dashboard/ceo?company_id=all&year=2026").get_json()
check("CEO-TYPE", all("sbu_type" in s for s in ceo["sbu"]), "the CEO tracker tiles carry the type")

print("=== pictures for projects and invoices ===")
for kind, prefix in (("project", "prj"), ("money", "bill")):
    missing = [k for k in server.ART_KEYS[kind] if not os.path.isfile(os.path.join(ERP, "static", "assets", "art", "%s-%s.webp" % (prefix, k)))]
    js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
    block = js[js.index("  %s: [" % kind, js.index("const ART = {")):]
    block = block[:block.index("],\n  ],") if "],\n  ]," in block else block.index("\n  ],")]
    check("ART-" + kind.upper(), not missing and tuple(re.findall(r'\["([a-z]+)", "', block)) == server.ART_KEYS[kind],
          "%d %s scenes, same keys in app.js, all on disk" % (len(server.ART_KEYS[kind]), kind))
up = lambda cl, url, data: cl.post(url, data={"file": (io.BytesIO(data), "p.png")}, content_type="multipart/form-data")
r = up(c, "/api/images/project/%d" % p1, png())
lst = next(p for p in c.get("/api/projects?company_id=all").get_json() if p["id"] == p1)
check("PRJ-UPLOAD", r.status_code == 200 and lst["image_v"], "a project carries its uploaded picture in the list")
mt = next(m for m in c.get("/api/money-tracker?company_id=all").get_json()["items"] if m["id"] == t1)
check("INHERIT", mt["project_image_v"] == lst["image_v"] and mt["image_v"] is None, "its invoices see the project's picture until they get their own")
check("MONEY-UPLOAD", up(c, "/api/images/money/%d" % t1, png(3, 3)).status_code == 200
      and next(m for m in c.get("/api/money-tracker?company_id=all").get_json()["items"] if m["id"] == t1)["image_v"], "an invoice's own picture")
check("ART-SET", c.put("/api/images/project/%d/art" % p1, json={"art": "townhall"}).status_code == 200
      and c.put("/api/images/money/%d/art" % t1, json={"art": "ferry"}).status_code == 200
      and c.put("/api/images/money/%d/art" % t1, json={"art": "townhall"}).status_code == 400,
      "each kind takes its own scenes only")
check("VIEWER-PIC", up(v, "/api/images/project/%d" % p1, png()).status_code == 403
      and v.get("/api/images/project/%d" % p1).status_code == 200, "a viewer sees pictures, cannot change them")
# deleting a project keeps its invoices (the money history) and drops its picture
p_del = project("HM-DEL", 10000000)
t_del = track(p_del, 10000000, title="").get_json()["id"]
up(c, "/api/images/project/%d" % p_del, png())
r = c.delete("/api/projects/%d" % p_del)
row = c.get("/api/money-tracker/%d" % t_del).get_json()
conn = database.get_db(database.DEFAULT_DB)
left = conn.execute("SELECT COUNT(*) FROM entity_images WHERE kind='project' AND entity_id=?", (p_del,)).fetchone()[0]
conn.close()
check("PRJ-DELETE", r.status_code == 200 and row["project_id"] is None and "HM-DEL" in row["title"] and not left,
      "the track stays, named after its project; the picture goes")
r = c.delete("/api/money-tracker/%d" % t1)
conn = database.get_db(database.DEFAULT_DB)
left = conn.execute("SELECT COUNT(*) FROM entity_images WHERE kind='money' AND entity_id=?", (t1,)).fetchone()[0]
conn.close()
check("MT-DELETE", r.status_code == 200 and not left, "deleting an invoice track drops its picture")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
