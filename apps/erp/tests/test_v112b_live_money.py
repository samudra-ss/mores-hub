"""v1.12b round 4: the SBU's live Google Sheet and the Money Tracker <-> journal
connector.

What must not drift:
  * only a Google Sheets / Drive link is ever downloaded; any other link is kept
    as a "further source" only. The sheet is read by its header row (Tanggal /
    Nominal ...), in any column order, and "Perlakuan" keeps capex and deposits
    out of the profit;
  * the live tab shows the sheet as it is - nothing from it is stored;
  * revenue posted to the journal and tagged to a project is offered as the
    payment of the project's open invoice whose amount fits best; invoices
    already Done use up the earliest money; a person validates (paid closes
    the invoice at phase 12, partial keeps it open) or dismisses, and the
    journal itself is never changed.

    python apps/erp/tests/test_v112b_live_money.py
"""
import io
import os
import re
import sys
import tempfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
os.environ["MORES_HV_DATA_DIR"] = tempfile.mkdtemp(prefix="v112b4_")

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import server  # noqa: E402
import sbu_live  # noqa: E402
from openpyxl import Workbook, load_workbook  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-12s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-12s %s" % (name, detail))


SHEET = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?gid=0#gid=0"

print("=== which links are read ===")
check("X-SHEET", sbu_live.export_url(SHEET) == "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=xlsx",
      "a Google Sheet is downloaded as .xlsx")
check("X-DRIVE", (sbu_live.export_url("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01/view") or "").startswith(
    "https://drive.google.com/uc?export=download&id="), "an .xlsx on Drive too")
check("X-OTHER", all(sbu_live.export_url(u) is None for u in (
    "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz01", "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01/edit",
    "https://evil.example.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123/", "http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01/",
    "file:///etc/passwd")), "folders, docs, other hosts and plain http are never fetched")
check("KIND", [sbu_live.link_kind(u) for u in (SHEET, "https://drive.google.com/drive/folders/x", "https://example.com")] == ["sheet", "folder", "web"],
      "source links get a kind for their chip")
check("AMOUNT", [sbu_live._as_amount(v) for v in ("1.234.567", "Rp 2.500.000,50", "12,5", 3)] == [1234567, 2500000.5, 12.5, 3],
      "Indonesian number formats are read")

print("=== reading a sheet ===")
wb = Workbook()
ws = wb.active
ws.title = "Rincian Pengeluaran"
ws["A1"] = "Rincian Pengeluaran"
# columns in another order than the template, a blank line, a heading row
ws.append([])
ws.append(["Project", "Nominal (Rp)", "Tanggal", "GL / Akun", "Keterangan", "Kelompok", "Perlakuan"])
ws.append(["Sentimind", 10e6, date(2026, 1, 31), "HPP-S-DIRECT", "Gaji", "HPP Sentimind", "Beban (Laba Rugi)"])
ws.append(["Overhead", 4e6, date(2026, 2, 28), "OPEX-RENT", "Sewa", "Opex Overhead", "Beban (Laba Rugi)"])
ws.append(["Overhead", 7e6, date(2026, 2, 28), "CAPEX", "Laptop", "Capex", "Capex (Neraca)"])
ws.append(["Overhead", 1e6, date(2026, 2, 28), "DEPOSIT", "Deposit", "Deposit", "Deposit (Neraca)"])
ws.append([None, None, None, None, None, None, None])
ws.append(["Medmon", "3.000.000", "2025-12-31", "HPP-P", "last year", "HPP Project Klien", "Beban (Laba Rugi)"])
rv = wb.create_sheet("Pendapatan")
rv.append(["Rincian Pendapatan"])
rv.append(["Tanggal", "Project", "Keterangan", "Nominal (Rp)"])
rv.append([date(2026, 3, 31), "Medmon", "Termin 1", 25e6])
bio = io.BytesIO()
wb.save(bio)
DATA = bio.getvalue()
p = sbu_live.parse(DATA)
check("TABS", p["expense_tab"] == "Rincian Pengeluaran" and p["revenue_tab"] == "Pendapatan" and len(p["expenses"]) == 5,
      "both registers found by their header row, blank lines skipped")
s = sbu_live.summarise(p)
T = s["totals"]
check("YEAR", s["year"] == 2026 and s["years"] == [2025, 2026] and s["last_date"] == "2026-03-31", "the latest year by default")
check("PROFIT", T["expense"] == 14e6 and T["revenue"] == 25e6 and T["profit"] == 11e6 and T["capex"] == 7e6 and T["deposit"] == 1e6,
      "capex and deposit stay out of the profit (Rp 25 jt - 14 jt = 11 jt)")
check("GROUPS", [g["name"] for g in s["by_group"]] == ["HPP Sentimind", "Opex Overhead"]
      and any(x["name"] == "Medmon" and x["revenue"] == 25e6 for x in s["by_project"]), "cost structure and profit per project")
check("MONTHS", s["months"][1]["expense"] == 4e6 and s["months"][1]["capex"] == 7e6 and T["months_with_data"] == 3, "month by month")
check("Y2025", sbu_live.summarise(p, 2025)["totals"]["expense"] == 3e6, "another year can be picked")

print("=== the SBU's links ===")
c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
mda = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}["MDA"]
pid = c.post("/api/products", json={"company_id": mda, "name": "Live SBU"}).get_json()["id"]
d = c.get("/api/products/%d/live" % pid).get_json()
check("OFF", d["connected"] is False and d["links"] == [], "a new SBU is not connected")
r = c.put("/api/products/%d/live" % pid, json={"live_url": "https://example.com/data.xlsx"})
check("REFUSE", r.status_code == 400, "the live link must be a Google Sheet")
r = c.put("/api/products/%d/live" % pid, json={"live_url": SHEET, "links": [
    {"label": "Receipts", "url": "https://drive.google.com/drive/folders/abc"}, {"label": "", "url": "  "},
    {"label": "Bad", "url": "javascript:alert(1)"}]})
check("BADLINK", r.status_code == 400, "a link that is not http(s) is refused")
r = c.put("/api/products/%d/live" % pid, json={"live_url": SHEET, "links": [
    {"label": "Receipts", "url": "https://drive.google.com/drive/folders/abc"}, {"label": "", "url": "  "}]})
check("SAVE", r.status_code == 200 and len(r.get_json()["links"]) == 1, "the sheet and one further source saved, blanks dropped")
calls = []
real_fetch = sbu_live.fetch
sbu_live.fetch = lambda url, force=False: (calls.append((url, force)) or (DATA, 1.8e9))
d = c.get("/api/products/%d/live?year=2026" % pid).get_json()
check("LIVE", d["connected"] and d["totals"]["profit"] == 11e6 and d["links"][0]["kind"] == "folder" and d["expense_tab"] == "Rincian Pengeluaran",
      "the live tab reads the sheet: Rp 11 jt profit, the folder link alongside")
c.get("/api/products/%d/live?refresh=1" % pid)
check("REFRESH", calls[-1] == (SHEET, True), "Refresh reads the sheet again")
sbu_live.fetch = lambda url, force=False: (_ for _ in ()).throw(PermissionError("share it"))
d = c.get("/api/products/%d/live" % pid)
check("NOSHARE", d.status_code == 200 and "share it" in d.get_json()["error"], "a sheet that is not shared shows why, never a 500")
sbu_live.fetch = real_fetch
c.post("/api/logout")
assert c.post("/api/login", json={"username": "viewer", "password": "viewer123"}).status_code in (200, 401)
r = server.app.test_client()
r.post("/api/login", json={"username": "admin", "password": "MoresMores2018"})
x = r.get("/api/products/live-template.xlsx")
tw = load_workbook(io.BytesIO(x.data))
x.close()
check("TEMPLATE", tw.sheetnames == ["Rincian Pengeluaran", "Pendapatan"] and sbu_live.parse(x.data)["expense_tab"] == "Rincian Pengeluaran",
      "the template is the layout the reader understands")
check("NOSTORE", "live_rows" not in open(os.path.join(ERP, "database.py"), encoding="utf-8").read(), "nothing from the sheet is stored")
c = r

print("=== payments found in the journal ===")
conn = database.get_db(database.DEFAULT_DB)
prj = conn.execute("INSERT INTO projects (company_id, code, name, contract_value) VALUES (?,?,?,?)", (mda, "PAY-1", "Pay project", 300e6)).lastrowid
oth = conn.execute("INSERT INTO projects (company_id, code, name) VALUES (?,?,?)", (mda, "PAY-2", "Other project")).lastrowid
rev = conn.execute("SELECT id FROM accounts WHERE company_id=? AND type='revenue' ORDER BY code LIMIT 1", (mda,)).fetchone()[0]
cash = conn.execute("SELECT id FROM accounts WHERE company_id=? AND code LIKE '11%' ORDER BY code LIMIT 1", (mda,)).fetchone()[0]
n = [0]


def receipt(amount, day, project, status="posted", account=None):
    n[0] += 1
    e = conn.execute("INSERT INTO journal_entries (company_id, entry_no, date, description, status, source) VALUES (?,?,?,?,?,?)",
                     (mda, "TST-%03d" % n[0], day, "KR OTOMATIS test", status, "bca_csv")).lastrowid
    conn.execute("INSERT INTO journal_lines (entry_id, account_id, debit) VALUES (?,?,?)", (e, cash, amount))
    return conn.execute("INSERT INTO journal_lines (entry_id, account_id, project_id, credit) VALUES (?,?,?,?)",
                        (e, account or rev, project, amount)).lastrowid


conn.commit()
mk = lambda title, amount, status="active": c.post("/api/money-tracker", json={
    "company_id": mda, "project_id": prj, "title": title, "amount": amount, "status": status, "phase_key": "p3"}).get_json()["id"]
t0 = mk("Termin 0", 50e6, "done")
t1 = mk("Termin 1", 100e6)
t2 = mk("Termin 2", 120e6)
l_old = receipt(50e6, "2026-02-01", prj)       # paid Termin 0 (already Done by hand)
l_a = receipt(118e6, "2026-03-01", prj)       # fits Termin 2 best (tax withheld)
l_b = receipt(99.5e6, "2026-04-01", prj)      # fits Termin 1
receipt(70e6, "2026-04-02", oth)              # another project, its only invoice cancelled
receipt(10e6, "2026-04-03", prj, status="draft")
conn.commit()
c.post("/api/money-tracker", json={"company_id": mda, "project_id": oth, "title": "Gone", "amount": 70e6, "status": "cancelled"})
before = conn.execute("SELECT COUNT(*), SUM(debit), SUM(credit) FROM journal_lines").fetchone()
R = c.get("/api/money-tracker/receipts?company_id=all").get_json()
s1, s2 = R["tracks"][str(t1)]["suggestion"], R["tracks"][str(t2)]["suggestion"]
check("MATCH", s1 and s1["line_id"] == l_b and s2 and s2["line_id"] == l_a and s2["fit"] == "near" and s2["diff"] == -2e6,
      "each payment goes to the invoice it fits best (Rp 118 jt -> the Rp 120 jt invoice, 2 jt under)")
check("USED", R["tracks"][str(t0)]["suggestion"] is None and all(u["line_id"] != l_old for u in R["unmatched"]),
      "the invoice already Done used up the earliest payment - it is not offered again")
check("DRAFT", R["pending"] == 2 and not any(u["amount"] == 10e6 for u in R["unmatched"]), "a draft entry is not money received")
check("NOOPEN", any(u["amount"] == 70e6 and u["reason"] == "no_open" for u in R["unmatched"]), "money for a project without an open invoice is listed")
r = c.post("/api/money-tracker/receipts", json={"line_id": l_a, "tracker_id": t2, "kind": "paid"})
m2 = c.get("/api/money-tracker/%d" % t2).get_json()
check("PAID", r.status_code == 200 and m2["status"] == "done" and m2["phase_key"] == "p12"
      and m2["history"][-1]["completed_at"] == "2026-03-01", "validated as paid: the invoice is Done at phase 12, on the payment's date")
r = c.post("/api/money-tracker/receipts", json={"line_id": l_b, "tracker_id": t1, "kind": "partial"})
R = c.get("/api/money-tracker/receipts?company_id=all").get_json()
x1 = R["tracks"][str(t1)]
check("PARTIAL", r.status_code == 200 and x1["received"] == 99.5e6 and c.get("/api/money-tracker/%d" % t1).get_json()["status"] == "active",
      "a partial payment is counted and the invoice stays open")
check("TWICE", c.post("/api/money-tracker/receipts", json={"line_id": l_b, "tracker_id": t1, "kind": "paid"}).status_code == 400,
      "a payment is validated once")
l_c = receipt(5e6, "2026-05-01", prj)
conn.commit()
other_t = c.post("/api/money-tracker", json={"company_id": mda, "project_id": oth, "title": "X", "amount": 1e6}).get_json()["id"]
check("WRONGPRJ", c.post("/api/money-tracker/receipts", json={"line_id": l_c, "tracker_id": other_t, "kind": "paid"}).status_code == 400,
      "a payment cannot close another project's invoice")
check("NOTREV", c.post("/api/money-tracker/receipts", json={"line_id": receipt(1e6, "2026-05-02", prj, account=cash), "tracker_id": t1,
                                                             "kind": "paid"}).status_code == 400, "only a revenue line is a payment")
conn.commit()
r = c.post("/api/money-tracker/receipts", json={"line_id": l_c, "kind": "dismissed"})
R = c.get("/api/money-tracker/receipts?company_id=all").get_json()
check("DISMISS", r.status_code == 200 and all((x["suggestion"] or {}).get("line_id") != l_c for x in R["tracks"].values()),
      "a dismissed payment is not offered again")
c.delete("/api/money-tracker/receipts/%d" % l_b)
R = c.get("/api/money-tracker/receipts?company_id=all").get_json()
check("UNDO", R["tracks"][str(t1)]["received"] == 0 and R["tracks"][str(t1)]["suggestion"]["line_id"] == l_b, "undo offers it again")
check("JOURNAL", conn.execute("SELECT COUNT(*), SUM(debit), SUM(credit) FROM journal_lines").fetchone()[:] == (before[0] + 4, before[1] + 6e6, before[2] + 6e6)
      and conn.execute("SELECT COUNT(*) FROM journal_lines WHERE id IN (?,?)", (l_a, l_b)).fetchone()[0] == 2,
      "the journal is never changed by the connector (only the test's own entries were added)")
c.delete("/api/money-tracker/%d" % t2)
check("DELTRACK", conn.execute("SELECT COUNT(*) FROM money_receipts WHERE line_id=?", (l_a,)).fetchone()[0] == 0,
      "deleting an invoice frees its validated payments")
conn.close()

print("=== the page code ===")
js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
check("UI-LIVE", '["live", t("Live sheet")]' in js and "async function pfLive(" in js and "sbuLiveDashCard($(\"#sbuLiveDash\"), state.pfId)" in js,
      "the SBU has a Live sheet tab and a live card on its dashboard")
check("UI-INV", "function mtInvoicesView(" in js and 'localStorage.getItem("erp.mtView2") || "inv"' in js and 'class="iv-prj' in js,
      "the Money Tracker opens on the invoice view: projects with their invoices under them")
check("UI-PAY", "api(`/api/money-tracker/receipts?${scopeQS()}`)" in js and "function mtPayModal(" in js,
      "opening the Money Tracker reads the journal and offers payments for validation")
check("NO-ID", not re.search(r"spreadsheets/d/[A-Za-z0-9_-]{20,}", js + open(os.path.join(ERP, "sbu_live.py"), encoding="utf-8").read()),
      "no real sheet link is written into the code (the repo is public)")

print("\n%d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
