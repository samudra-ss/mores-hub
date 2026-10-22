"""v1.12 Remuneration: the scheme table applied to a project's actual GP.

Pins the policy sheet: the project value picks the tier, the minimum GP decides
whether the team pool is paid (the bringer award does not depend on it), the
pool is split by grade weight x involvement, Type 1 pays the partner, Type 3
High the BOD, Type 3 Low shares the pool with the BOD, STP is 5-10% of GP, and
an agent is paid from the office's share. Also: pay data stays behind the menu,
and the simulation saves nothing.

    python apps/erp/tests/test_remuneration.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="remu_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import remuneration  # noqa: E402
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


c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
mda = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}["MDA"]
A = {a["code"]: a["id"] for a in c.get("/api/accounts?company_id=%d" % mda).get_json()}
jm = 0


def project(code, rtype=None, cv=0, revenue=0, cost=0, date="2026-03-10", **extra):
    global jm
    body = {"company_id": mda, "code": code, "name": "Remu " + code, "contract_value": cv, "remu_type": rtype}
    body.update(extra)
    r = c.post("/api/projects", json=body)
    assert r.status_code == 201, r.get_json()
    pid = r.get_json()["id"]
    for acct, dr, cr, amt in (("1120", True, False, revenue), ("5100-01", True, False, cost)):
        if not amt:
            continue
        lines = ([{"account_id": A["1120"], "debit": amt, "credit": 0}, {"account_id": A["4100"], "debit": 0, "credit": amt, "project_id": pid}]
                 if acct == "1120" else
                 [{"account_id": A["5100-01"], "debit": amt, "credit": 0, "project_id": pid}, {"account_id": A["1120"], "debit": 0, "credit": amt}])
        r = c.post("/api/journals", json={"company_id": mda, "date": date, "description": "remu test", "status": "posted", "lines": lines})
        assert r.status_code == 201, r.get_json()
    return pid


def person(name, grade):
    r = c.post("/api/remuneration/people", json={"name": name, "grade": grade})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def member(pid, person_id, role, inv=100):
    r = c.post("/api/remuneration/projects/%d/team" % pid, json={"person_id": person_id, "role": role, "involvement": inv})
    assert r.status_code == 201, r.get_json()


R = lambda pid: c.get("/api/remuneration/projects/%d" % pid).get_json()["project"]["result"]
pay = lambda res, pid_, kind=None: round(sum(p["amount"] for p in res["payouts"] if p["person_id"] == pid_ and (kind is None or p["kind"] == kind)), 2)

print("=== the project value picks the tier ===")
cases = [("t2", 99e6, "t2_low"), ("t2", 100e6, "t2_med"), ("t2", 1e9, "t2_med"), ("t2", 1.5e9, "t2_high"), ("t2", 5e9, "t2_high"),
         ("t2", 6e9, "stp"), ("t3", 499e6, "t3_low"), ("t3", 500e6, "t3_high"), ("t1", 1, "t1"), ("stp", 1, "stp"), (None, 1e9, None)]
check("TIERS", all(remuneration.scheme_key(t, v) == k for t, v, k in cases),
      "Type 2: <100m Low, 100m-1bn Medium, 1bn-5bn High, >5bn STP; Type 3: <500m Low, >=500m High")

print("=== Type 2 Medium: GP shares, the pool by points, the bringer by value ===")
pm, an, co, br = person("Pak PM", 3), person("Ana Analyst", 1), person("Cici Consultant", 2), person("Bobi Bringer", 2)
p2 = project("RM-T2", "t2", cv=400e6, revenue=400e6, cost=240e6)
member(p2, pm, "pm"); member(p2, an, "team", 50); member(p2, co, "team"); member(p2, br, "bringer")
r = R(p2)
check("SCHEME", r["scheme"]["key"] == "t2_med" and r["gp"] == 160e6 and r["eligible"] is True, "value Rp400m -> Medium; GP Rp160m at 40% >= 35% minimum")
check("SPLIT", r["office"] == 128e6 and r["pool"] == 32e6 and r["bringer"] == 10e6,
      "office 80% = Rp128m, team pool 20% = Rp32m, bringer 2.5% of value = Rp10m")
check("POINTS", pay(r, pm) == 16e6 and pay(r, an) == 4e6 and pay(r, co) == 12e6,
      "points PM 2.0, analyst 1.0x50% = 0.5, consultant 1.5 -> Rp16m / Rp4m / Rp12m")
check("BRINGER", pay(r, br, "bringer") == 10e6 and pay(r, br, "pool") == 0, "the bringer gets the fee, not a pool share")
p2b = project("RM-T2B", "t2", cv=400e6, revenue=400e6, cost=280e6)
member(p2b, pm, "pm"); member(p2b, br, "bringer")
r = R(p2b)
check("MIN-GP", r["eligible"] is False and r["pool"] == 0 and r["bringer"] == 10e6 and pay(r, br) == 10e6,
      "GP 30% < 35%: no team pool, the bringer is still paid")

print("=== Type 1, Type 3, STP, agent ===")
pa, bod, bod2 = person("Pia Partner", 4), person("Budi BOD", 4), person("Dodi BOD", 4)
p1 = project("RM-T1", "t1", cv=500e6, revenue=300e6, cost=200e6)
member(p1, pa, "partner"); member(p1, co, "team")
r = R(p1)
check("TYPE-1", r["office"] == 60e6 and r["pool"] == 15e6 and r["partner"] == 25e6 and pay(r, pa) == 25e6 and pay(r, co) == 15e6,
      "GP Rp100m: office 60%, team 15%, partner 25%")
p3h = project("RM-T3H", "t3", cv=600e6, revenue=600e6, cost=400e6)
member(p3h, pm, "pm"); member(p3h, bod, "bod"); member(p3h, bod2, "bod")
r = R(p3h)
check("TYPE-3-HIGH", r["scheme"]["key"] == "t3_high" and r["pool"] == 50e6 and r["bod"] == 30e6 and pay(r, bod) == 15e6 and pay(r, bod2) == 15e6
      and r["office"] == 120e6, "GP Rp200m: office 60%, team 25%, BOD 15% shared by two")
p3l = project("RM-T3L", "t3", cv=200e6, revenue=200e6, cost=100e6)
member(p3l, an, "team"); member(p3l, bod, "bod")
r = R(p3l)
check("TYPE-3-LOW", r["scheme"]["key"] == "t3_low" and r["pool"] == 25e6 and r["bod"] == 0
      and pay(r, an) == 6250000 and pay(r, bod) == 18750000, "GP Rp100m: the 25% pool is shared by team + BOD (weights 1.0 / 3.0)")
ps = project("RM-STP", "stp", cv=8e9, revenue=1e9, cost=600e6, remu_stp_pct=8)
member(ps, pm, "pm")
r = R(ps)
check("STP", r["pool"] == 32e6 and r["undecided"] == 368e6 and r["office"] == 0 and pay(r, pm) == 32e6,
      "STP at 8%: Rp32m team pool, the rest of the Rp400m GP for the BOD to set")
check("STP-RANGE", c.put("/api/projects/%d" % ps, json={"name": "x", "remu_stp_pct": 12}).status_code == 400, "an STP pool outside 5-10% is refused")
pg = project("RM-AGT", "t2", cv=2e9, revenue=2e9, cost=1.2e9, remu_agent="PT Agen Nusantara")
member(pg, pm, "pm"); member(pg, br, "bringer")
r = R(pg)
check("AGENT", r["scheme"]["key"] == "t2_high" and r["agent_fee"] == 50e6 and r["office"] == 600e6 and r["office_net"] == 550e6
      and r["bringer"] == 60e6, "an agent takes 2.5% of the Rp2bn value out of the office's 75%; the bringer still gets 3%")

print("=== value, basis, nobody named ===")
pv = project("RM-VAL", "t2", cv=0, revenue=90e6, cost=40e6)
r = R(pv)
check("VALUE-FALLBACK", r["value"] == 90e6 and r["value_source"] == "revenue" and r["scheme"]["key"] == "t2_low",
      "no contract value: the revenue stands in for the project value")
check("UNPAID", any(u["kind"] == "pool" for u in r["unpaid"]) and any(u["kind"] == "bringer" for u in r["unpaid"]),
      "with nobody on the team, the pool and the bringer fee show as not paid out")
py = project("RM-YR", "t2", cv=400e6, revenue=400e6, cost=100e6, date="2025-06-01")
c.post("/api/journals", json={"company_id": mda, "date": "2026-02-01", "description": "remu test", "status": "posted",
                              "lines": [{"account_id": A["5100-01"], "debit": 50e6, "credit": 0, "project_id": py},
                                        {"account_id": A["1120"], "debit": 0, "credit": 50e6}]})
life = c.get("/api/remuneration/projects?company_id=%d" % mda).get_json()
year = c.get("/api/remuneration/projects?company_id=%d&year=2026&basis=year" % mda).get_json()
gp = lambda d: next(p for p in d["projects"] if p["id"] == py)["gp"]
check("BASIS", gp(life) == 250e6 and gp(year) == -50e6, "whole life Rp250m GP; 2026 alone is the Rp50m cost")
none = next(p for p in life["projects"] if p["code"] == "RM-VAL")
check("TOTALS", any(t["person_id"] == pm and t["total"] > 0 for t in life["totals"]), "per-person totals across projects")
p0 = project("RM-NONE")
check("NO-SCHEME", R(p0)["scheme"] is None and "Project Details" in R(p0)["notes"][0], "no type yet: nothing computed, and it says where to set it")
r = c.put("/api/projects/%d" % p0, json={"name": "Remu RM-NONE", "contract_value": 0})
check("KEEPS-TYPE", r.status_code == 200 and c.put("/api/remuneration/projects/%d/scheme" % p0, json={"remu_type": "t3"}).status_code == 200
      and c.put("/api/projects/%d" % p0, json={"name": "Remu RM-NONE"}).status_code == 200
      and next(p for p in c.get("/api/projects?company_id=all").get_json() if p["id"] == p0)["remu_type"] == "t3",
      "an edit that does not send the type leaves it alone")
check("BAD-TYPE", c.put("/api/remuneration/projects/%d/scheme" % p0, json={"remu_type": "t9"}).status_code == 400, "an unknown type is refused")

print("=== people, grades, sample names ===")
check("GRADE", c.post("/api/remuneration/people", json={"name": "X", "grade": 5}).status_code == 400, "grades are G1-G4")
check("DUP-ROLE", c.post("/api/remuneration/projects/%d/team" % p2, json={"person_id": pm, "role": "pm"}).status_code == 400,
      "the same person cannot hold the same role twice on a project")
cfg = c.put("/api/remuneration/config", json={"grades": [{"grade": 1, "title": "Analyst", "weight": 2.0}]}).get_json()
r = R(p2)
check("WEIGHT", next(g for g in cfg["grades"] if g["grade"] == 1)["weight"] == 2.0 and abs(pay(r, an) - 32e6 / 4.5) < 1,
      "an analyst weight of 2.0 changes the split (points 2.0 / 1.0 / 1.5 -> Rp7.1m)")
before = len(c.get("/api/remuneration/people").get_json())
s1 = c.post("/api/remuneration/simulate?company_id=all", json={"seed": 3, "people": 6, "projects": 4}).get_json()
s2 = c.post("/api/remuneration/simulate?company_id=all", json={"seed": 3, "people": 6, "projects": 4}).get_json()
check("SIM", len(s1["people"]) == 6 and len({p["name"] for p in s1["people"]}) == 6 and s1["people"] == s2["people"]
      and len(c.get("/api/remuneration/people").get_json()) == before and s1["projects"],
      "six distinct made-up names, the same for the same seed, nothing saved")
check("SIM-SPLIT", all(abs(sum(p["amount"] for p in x["result"]["payouts"] if p["kind"] == "pool") - x["result"]["pool"]) < 1
                       for x in s1["projects"] if x["result"]["pool"]), "every simulated pool is paid out in full")
r = c.post("/api/remuneration/people/sample", json={"people": s1["people"]}).get_json()
mid = len(c.get("/api/remuneration/people").get_json())
r2 = c.delete("/api/remuneration/people/sample").get_json()
check("SAMPLE", r["added"] == 6 and mid == before + 6 and r2["removed"] == 6 and len(c.get("/api/remuneration/people").get_json()) == before,
      "the names can be kept as sample people and removed again")

print("=== pay data stays behind the menu ===")
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access, menu_access) VALUES (?,?,?,?,?,?)",
             ("rview", generate_password_hash("viewer-pass-1"), "Viewer", "viewer", "all", "dashboard,projects"))
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access, menu_access) VALUES (?,?,?,?,?,?)",
             ("rbod", generate_password_hash("viewer-pass-1"), "BOD", "viewer", "all", "dashboard,remuneration"))
conn.commit()
database.migrate_database(conn)
ma = conn.execute("SELECT menu_access FROM users WHERE username='rview'").fetchone()[0]
conn.close()
check("NOT-AUTO", "remuneration" not in ma, "a restricted menu is not given Remuneration automatically")
v, b = server.app.test_client(), server.app.test_client()
assert v.post("/api/login", json={"username": "rview", "password": "viewer-pass-1"}).status_code == 200
assert b.post("/api/login", json={"username": "rbod", "password": "viewer-pass-1"}).status_code == 200
check("NO-MENU", v.get("/api/remuneration/projects?company_id=all").status_code == 403
      and v.post("/api/remuneration/simulate?company_id=all", json={}).status_code == 403, "no Remuneration in the menu: 403")
check("MENU-READ", b.get("/api/remuneration/projects?company_id=all").status_code == 200, "with it in the menu, a viewer can read")
check("VIEWER-WRITE", b.post("/api/remuneration/people", json={"name": "Z", "grade": 1}).status_code == 403, "but not change anything")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
