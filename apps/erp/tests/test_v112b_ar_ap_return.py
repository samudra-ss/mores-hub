"""v1.12b round 3: interest / profit sharing on receivables and payables, the
project short codes on the CEO Dashboard tiles, the Devil in Detail order and
the two-tab account popup.

    python apps/erp/tests/test_v112b_ar_ap_return.py
"""
import io
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
os.environ["MORES_HV_DATA_DIR"] = tempfile.mkdtemp(prefix="v112b3_")

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import reports  # noqa: E402
import server  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

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
mda = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}["MDA"]

print("=== the return on top of the base ===")
rt = lambda **k: reports.return_terms(dict({"amount": 100e6, "invoice_date": "2026-01-01", "due_date": "2026-07-02"}, **k), "invoice_date")
x = rt(ret_type="interest", ret_rate=12, ret_basis="annual")
check("INT-YEAR", x["days"] == 182 and x["extra"] == round(100e6 * .12 * 182 / 365, 2),
      "12%% a year over 182 days = Rp %s" % x["extra"])
check("INT-FLAT", rt(ret_type="interest", ret_rate=5, ret_basis="flat")["extra"] == 5e6, "a flat 5% = Rp 5 jt, once")
check("INT-NODATE", rt(ret_type="interest", ret_rate=10, ret_basis="annual", due_date=None)["extra"] == 10e6,
      "no due date = one year")
check("PS-BASE", rt(ret_type="profit_share", ret_rate=30, ret_base=50e6)["extra"] == 15e6, "30% of a Rp 50 jt profit base = Rp 15 jt")
check("PS-NOBASE", rt(ret_type="profit_share", ret_rate=10, ret_base=None)["extra"] == 10e6, "no profit base = share of the base amount")
check("NONE", rt()["extra"] == 0 and rt()["total"] == 100e6, "no scheme = the base, nothing added")

print("=== receivables and payables ===")
before = c.get("/api/receivables?company_id=%d&as_of=2026-11-04" % mda).get_json()
r = c.post("/api/receivables", json={"company_id": mda, "client": "Loan A", "invoice_no": "L-1", "invoice_date": "2026-01-01",
                                     "due_date": "2026-12-31", "amount": 100e6, "paid": 20e6,
                                     "ret_type": "interest", "ret_rate": 12, "ret_basis": "annual"})
rid = r.get_json()["id"]
d = c.get("/api/receivables?company_id=%d&as_of=2026-11-04" % mda).get_json()
it = next(i for i in d["items"] if i["id"] == rid)
exp = round(100e6 * .12 * 364 / 365, 2)
check("AR-EXTRA", r.status_code == 201 and it["extra"] == exp and it["total_repay"] == round(100e6 + exp, 2),
      "the loan carries Rp %s interest; total to repay Rp %s" % (it["extra"], it["total_repay"]))
check("AR-OUT", it["outstanding"] == round(100e6 + exp - 20e6, 2) and it["bucket"] == "not_due",
      "outstanding = total to repay - paid, and it ages like any invoice")
check("AR-TOTALS", d["total_extra"] == round(before["total_extra"] + exp, 2)
      and d["total_outstanding"] == round(before["total_outstanding"] + it["outstanding"], 2),
      "the totals carry the interest too")
old = [i for i in d["items"] if i["id"] != rid]
check("AR-UNCHANGED", all(i["extra"] == 0 and i["outstanding"] == round(i["amount"] - i["paid"], 2) for i in old),
      "invoices without a scheme are exactly as before")
r = c.put("/api/receivables/%d" % rid, json={"client": "Loan A", "invoice_no": "L-1", "invoice_date": "2026-01-01",
                                             "due_date": "2026-12-31", "amount": 100e6, "paid": 20e6,
                                             "ret_type": "profit_share", "ret_rate": 30, "ret_base": 50e6})
it = next(i for i in c.get("/api/receivables?company_id=%d" % mda).get_json()["items"] if i["id"] == rid)
check("AR-PS", r.status_code == 200 and it["extra"] == 15e6 and it["ret"]["type"] == "profit_share", "switched to profit sharing: Rp 15 jt")
r = c.put("/api/receivables/%d" % rid, json={"client": "Loan A", "amount": 100e6, "paid": 0})
it = next(i for i in c.get("/api/receivables?company_id=%d" % mda).get_json()["items"] if i["id"] == rid)
check("AR-KEEP", it["ret"]["type"] == "profit_share", "a save that does not send the scheme keeps it")
check("BAD-TYPE", c.put("/api/receivables/%d" % rid, json={"client": "x", "ret_type": "usury"}).status_code == 400, "an unknown scheme is refused")
check("BAD-RATE", c.put("/api/receivables/%d" % rid, json={"client": "x", "ret_rate": 150}).status_code == 400, "a rate above 100% is refused")
r = c.post("/api/payables", json={"company_id": mda, "vendor": "Bank X", "bill_no": "B-1", "bill_date": "2026-03-01",
                                  "due_date": "2027-03-01", "amount": 200e6, "paid": 0, "ret_type": "interest", "ret_rate": 10})
pid = r.get_json()["id"]
pt = next(i for i in c.get("/api/payables?company_id=%d" % mda).get_json()["items"] if i["id"] == pid)
check("AP-EXTRA", pt["extra"] == 20e6 and pt["total_repay"] == 220e6 and pt["outstanding"] == 220e6,
      "a payable at 10% a year for a year: Rp 200 jt + Rp 20 jt")
r = c.get("/api/export/payables?company_id=%d" % mda)
ws = load_workbook(io.BytesIO(r.data)).active
r.close()
heads = [ws.cell(row=4, column=i).value for i in range(15, 18)]
row = next(i for i in range(5, ws.max_row + 1) if ws.cell(row=i, column=3).value == "B-1")
check("AP-XLSX", heads == ["Scheme", "Interest / profit share", "Total to repay"] and ws.cell(row=row, column=17).value == 220e6,
      "the Excel export carries the scheme, the extra and the total to repay")

print("=== project short codes ===")
prj = c.post("/api/projects", json={"company_id": mda, "code": "ABR-1", "name": "Abbr project", "abbr": " ab 12345 "}).get_json()["id"]
p = next(x for x in c.get("/api/projects?company_id=all").get_json() if x["id"] == prj)
check("ABBR", p["abbr"] == "AB1234", "spaces dropped, upper case, at most 6 characters (%s)" % p["abbr"])
conn = database.get_db(database.DEFAULT_DB)
conn.execute("UPDATE projects SET status='completed' WHERE id=?", (prj,))
conn.commit()
conn.close()
done = c.get("/api/dashboard/ceo?company_id=all&year=2026").get_json()["highlights"]["done"]["rows"]
check("ABBR-DASH", any(r.get("project_abbr") == "AB1234" for r in done) or done and "project_abbr" in done[0],
      "the dashboard's highlight rows carry the short code")

print("=== menu order, tiles and the account popup (page code) ===")
html = open(os.path.join(ERP, "static", "app.html"), encoding="utf-8").read()
routes = re.findall(r'data-route="([a-z]+)" data-sec="detail"', html)
check("ORDER", routes == ["bank", "journals", "expenses", "receivables", "payables", "budgets", "reports", "accountant", "remuneration"],
      " > ".join(routes))
js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
check("TILES", "ceo-hl-tile" in js and "function prjAbbr(r)" in js and 'class="hlt-abbr"' in js, "highlights are square tiles with a short code")
check("POPUP", 'data-t="monthly"' in js and 'data-t="details"' in js and "async function accountMonthlyModal(code, name) { return accountPopup(" in js
      and "async function openAccountLedger(code, fallbackName, tab) { return accountPopup(" in js,
      "every account click opens one popup: Monthly spending first, Account details in its own tab")

print("\n%d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
