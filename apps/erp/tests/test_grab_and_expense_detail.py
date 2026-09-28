"""v1.10: Grab for Business import and the Expense Breakdown (devil in detail).

Covers the rules that must not quietly change: each Grab report shape is read
the way Grab writes it (month-first numeric dates, the company-pays total, not
the tips), a booking is booked once no matter how often the file comes back,
and the Expense Breakdown's money always equals the ledger.

    python apps/erp/tests/test_grab_and_expense_detail.py
"""
import io
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="grab_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import bank_import as B  # noqa: E402
import server  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-12s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-12s %s" % (name, detail))


# Shapes copied from real Grab for Business exports; people and places invented.
EXPRESS = (
    "Company,PT MORES DATA ANALITIK - GFB - Branch\n"
    "Date & Time of Generation,Mon 28 Sep 2026 10:22:40 (GMT+7)\n"
    "Booking Type,Company bookings\nDate Range,30 Aug 2026 - 28 Sep 2026\nBookings,2\n"
    "Total Amount,IDR 31000\n,\n"
    "No.,Date & Time (GMT+7),Employee Name,Employee ID,Employee Group,Service Type,Payment Method,"
    "Pick-Up Address,Drop-Off Address,Booking ID,Bookings,City,Distance,Sender Name,Sender Mobile Number,"
    "Order Source,Trip / Cost Code,Trip Description,Pick-Up Date & Time,Drop-Off Date & Time,Payment Status,"
    "Payment Details,Currency,Base Fare,Promo,Insurance,Platform & Partner Fee,Total,"
    "Revised Total (After Refund),Tips\n"
    "1,22 Sep 2026 12:57:22 PM,Rina Putri,-,Marketing,JUSTEXPRESS,Corporate Billing,"
    "\"Jl. A, Jakarta, 10330, Kantor Satu\",\"Jl. B, Jakarta, 12910, Gedung Dua\",A-EXP1,\"[]\",Jakarta,4.0,"
    "X,081,ANDROID,1255,Dokumen,22 Sep 2026 13:14:41,22 Sep 2026 13:26:06,Success,Corporate Billing,IDR,"
    "11000,0,0,0,11000,11000,0\n"
    "2,23 Sep 2026 09:55:53 AM,Budi Santoso,-,HR&GA,JUSTEXPRESS,Corporate Billing,"
    "\"Jl. B, Jakarta, 12910, Gedung Dua\",\"Jl. C, Jakarta, 13120, Rumah Tiga\",A-EXP2,\"[]\",Jakarta,8.1,"
    "Y,082,IOS,-,-,23 Sep 2026 10:10:49,23 Sep 2026 10:39:10,Success,Corporate Billing,IDR,"
    "20000,0,0,0,20000,20000,0\n")

TRANSPORT = (
    "Company,PT MORES DATA ANALITIK - GFB - Branch,,\nDate Range,30 Aug 2026 - 28 Sep 2026,,\n"
    "Bookings,3,,\nTotal Amount,IDR 79500,,\n,,,\n"
    "No.,Date & Time (GMT+7),Employee Name,Employee ID,Employee Group,Service Type,Payment Method,"
    "Pick-Up Address,Intermediate Stop,Drop-Off Address,Booking ID,City,Distance,Booking Source,"
    "Trip / Cost Code,Trip Description,Pick-Up Date & Time,Drop-Off Date & Time,Payment Status,"
    "Payment Details,Currency, Base Fare , Promo , Booking Fee , Tolls , Late Fee , Other Fees ,"
    " Total Fare , Revised Total (After Refund) ,Booking Type\n"
    # 9/5/2026 is ambiguous: Grab writes month first, so this is 5 September
    "1,9/5/2026 17:01,Rina Putri,-,Marketing,Bike Standard,Corporate Billing,\"Jl. A, Gedung Dua\",-,"
    "\"Jl. D, Mall Empat\",A-TR1,Jakarta,3.3,ANDROID,1,Marketing,9/5/2026 17:05,9/5/2026 17:14,Success,"
    "Corporate Billing,IDR,\" 12,000.00 \", -   , -   , -   , -   ,\" 4,000.00 \",\" 16,000.00 \","
    "\" 16,000.00 \",On-demand\n"
    "2,9/22/2026 20:22,Rina Putri,-,Marketing,Car Standard,Corporate Billing,\"Jl. D, Mall Empat\",-,"
    "\"Jl. E, Stasiun Lima\",A-TR2,Jakarta,1.2,ANDROID,1,Marketing,9/22/2026 20:27,9/22/2026 20:30,Success,"
    "Corporate Billing,IDR,\" 45,500.00 \", -   , -   , -   , -   ,\" 18,000.00 \",\" 63,500.00 \","
    "\" 63,500.00 \",On-demand\n"
    "3,9/23/2026 13:39,Budi Santoso,-,Consultant,Car Standard,Corporate Billing,\"Jl. A, Gedung Dua\",-,"
    "\"Jl. F, Dinas Enam\",A-TR3,Jakarta,5.4,IPHONE,-,-,9/23/2026 13:42,9/23/2026 14:04,Cancelled,"
    "Corporate Billing,IDR,\" 21,000.00 \", -   , -   , -   , -   ,\" 7,500.00 \",\" 28,500.00 \","
    "\" 28,500.00 \",On-demand\n")

FOOD = (
    "Company,PT MORES DATA ANALITIK - GFB - Branch\nOrder Type,Company orders\n"
    "Date Range,30 Aug 2026 - 28 Sep 2026\nOrders,1\nCompany Pays,IDR 150000\nEmployee Pays,- \n,\n"
    "No.,Date & Time (GMT+7),Employee Name,Employee ID,Employee Email,Employee Group,Service Type,"
    "Payment Method,Merchant,Pick-Up Address,Delivery Address,Booking / Order ID,City,Distance,"
    "Order Status,Order Source,Order / Cost Code,Order Description,Order Date & Time (GMT+7),"
    "Order Completion Date & Time (GMT+7),Delivered By,Recipient Name,Items,Promo Code,Payment Status,"
    "Payment Details,Currency, Subtotal , Promo Amount , Parking Fee , Delivery Fee ,"
    "Platform & Partner Fee, Small Order Fee , Other Fees , Total , Company Pays , Employee Pays ,"
    " Revised Total (After Refund) , Revised Company Pays (After Refund) ,"
    "Revised Employee Pays (After Refund),Tips\n"
    "1,9/21/2026 17:03,Budi Santoso,-,budi@example.id,HR&GA,GrabFood,Corporate Billing,Kopi Tujuh,"
    "\"Jl. G, Kopi Tujuh\",\"Jl. A, Gedung Dua\",A-FD1,Jakarta,1.5,Completed,App,-,Rapat,"
    "9/21/2026 17:03,9/21/2026 17:26,Grab,X,\"[{\"\"item\"\":\"\"Kopi Susu\"\", \"\"price\"\":\"\"130000\"\","
    " \"\"quantity\"\":\"\"1\"\"}]\",-,Success,\"[\"\"Corporate Billing\"\"]\",IDR,\" 130,000.00 \", -   ,"
    " -   ,\" 11,000.00 \",0,\" 4,000.00 \",\" 5,000.00 \",\" 150,000.00 \",\" 150,000.00 \", - ,"
    "\" 150,000.00 \",\" 150,000.00 \",-,5000\n")

print("=== reading the three Grab report shapes ===")
ex, w1, m1 = B.parse_grab_csv(EXPRESS.encode(), "x_Express_x.csv")
check("EXPRESS", m1["service"] == "Express" and [r["amount"] for r in ex] == [11000, 20000]
      and m1["reconciled"], "%s rows, reconciled to the report's own total" % len(ex))
check("DATE-12H", ex[0]["date"] == "2026-09-22" and ex[0]["time"] == "12:57", ex[0]["date"])
check("KETERANGAN", ex[0]["description"] == "Rina Putri — Grab Express",
      "the employee's name and the type of transaction")
tr, w2, m2 = B.parse_grab_csv(TRANSPORT.encode(), "x_Transport_x.csv")
check("TRANSPORT", m2["service"] == "Transport" and len(tr) == 2, "the cancelled ride is skipped")
check("CANCELLED", any("skipped" in w for w in w2), w2[0][:70] if w2 else "")
check("MONTH-1ST", tr[0]["date"] == "2026-09-05", "9/5/2026 is 5 September, as Grab writes it")
check("RIGHT-TOT", tr[1]["amount"] == 63500 and "Revised Total" in tr[1]["grab"]["amount_column"],
      "the right-most total before On-demand")
fd, w3, m3 = B.parse_grab_csv(FOOD.encode(), "x_Food_x.csv")
check("FOOD", m3["service"] == "Food" and fd[0]["amount"] == 150000 and m3["reconciled"],
      "company pays after refund, the 5,000 tip is not added")
check("FOOD-ITEM", fd[0]["grab"]["merchant"] == "Kopi Tujuh" and "1× Kopi Susu" in fd[0]["grab"]["items"],
      fd[0]["note"][:60])
check("TIP-NOTE", "tip" in fd[0]["note"], "a tip is mentioned, never billed silently")
check("ACCOUNTS", fd[0]["suggested_codes"][0] == "6620" and tr[0]["suggested_codes"][0] == "6630"
      and ex[0]["suggested_codes"][0] == "6630", "Food -> F&B, Transport and Express -> Transportation")
none, wn, _ = B.parse_grab_csv(b"Date,Amount\n2026-01-01,5\n", "bank.csv")
check("NOT-GRAB", not none and "Grab" in wn[0], wn[0][:60])

c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
companies = c.get("/api/companies").get_json()
mda = next(x for x in companies if x["code"] == "MDA")

print("=== the CORP PAY - GRAB cash account ===")
accts = c.get("/api/accounts?company_id=%d" % mda["id"]).get_json()
grab_acc = [a for a in accts if a["name"] == "CORP PAY - GRAB"]
check("ACCOUNT", len(grab_acc) == 1 and grab_acc[0]["type"] == "asset"
      and grab_acc[0]["code"].startswith("11"), "%s %s under Cash & Bank" % (grab_acc[0]["code"], grab_acc[0]["name"]))
other = next(x for x in companies if x["code"] != "MDA")
r = c.post("/api/bank/grab-account", json={"company_id": other["id"]}).get_json()
r2 = c.post("/api/bank/grab-account", json={"company_id": other["id"]}).get_json()
check("ONCE", r["id"] == r2["id"], "asking twice gives the same account, never a second one")

print("=== parse, book, re-upload ===")
form = {"company_id": str(mda["id"]),
        "file": [(io.BytesIO(EXPRESS.encode()), "a_Express.csv"),
                 (io.BytesIO(TRANSPORT.encode()), "a_Transport.csv"),
                 (io.BytesIO(FOOD.encode()), "a_Food.csv")]}
res = c.post("/api/bank/parse-grab", data=form, content_type="multipart/form-data").get_json()
txs = res["transactions"]
check("MULTI", len(txs) == 5 and len(res["meta"]["files"]) == 3, "three files, one list of %d" % len(txs))
check("DEFAULT", res["meta"]["grab_account_id"] == grab_acc[0]["id"], res["meta"]["grab_account"])
check("RESOLVED", all(t.get("suggested_account_id") for t in txs),
      "every row has a cost account that exists in this company")
for t in txs:
    lines = [{"account_id": t["suggested_account_id"], "debit": t["amount"], "credit": 0},
             {"account_id": grab_acc[0]["id"], "debit": 0, "credit": t["amount"]}]
    rr = c.post("/api/journals", json={"company_id": mda["id"], "date": t["date"], "description": t["description"],
                                       "reference": t["reference"], "status": "posted", "lines": lines,
                                       "source": "grab_business", "grab": t["grab"]})
    assert rr.status_code == 201, rr.get_json()
form["file"] = [(io.BytesIO(EXPRESS.encode()), "a_Express.csv"), (io.BytesIO(TRANSPORT.encode()), "a_Transport.csv"),
                (io.BytesIO(FOOD.encode()), "a_Food.csv"), (io.BytesIO(FOOD.encode()), "copy_Food.csv")]
again = c.post("/api/bank/parse-grab", data=form, content_type="multipart/form-data").get_json()
check("DUPLICATE", len(again["transactions"]) == 5 and all(t["duplicate"] for t in again["transactions"]),
      "re-uploaded (and a copy of Food) -> every booking already booked, none twice")

print("=== the Expense Breakdown equals the ledger ===")
d = c.get("/api/expense-detail?company_id=%d&year=2026" % mda["id"]).get_json()
g = d["grab"]
want = sum(t["amount"] for t in txs)
check("GRAB-TOTAL", abs(g["total"] - want) < 0.01 and g["count"] == 5 and abs(g["billed"] - want) < 0.01,
      "trips %s = CORP PAY - GRAB charged %s" % (g["total"], g["billed"]))
check("OWED", abs(g["closing"] + want) < 0.01, "the account runs negative by what is owed to Grab")
rina = next(p for p in g["by_person"] if p["employee"] == "Rina Putri")
check("PERSON", rina["count"] == 3 and abs(rina["total"] - 90500) < 0.01
      and rina["services"]["Transport"]["count"] == 2, "Rina: 1 express + 2 rides = 90,500")
svc = {s["service"]: s["amount"] for s in g["by_service"]}
check("BY-TYPE", svc == {"Express": 31000, "Transport": 79500, "Food": 150000}, str(svc))
sep = c.get("/api/expense-detail?company_id=%d&year=2026&month=8" % mda["id"]).get_json()
check("MONTH", sep["grab"]["count"] == 0, "August has none of these September trips")

# editing the journal changes what the breakdown reports - the ledger wins
jid = next(t["entry_id"] for t in g["trips"] if t["booking_id"] == "A-FD1")
j = c.get("/api/journals/%d" % jid).get_json()
lines = [{"account_id": ln["account_id"], "debit": ln["debit"] and 120000, "credit": ln["credit"] and 120000}
         for ln in j["lines"]]
c.put("/api/journals/%d" % jid, json={"company_id": mda["id"], "date": j["date"], "description": j["description"],
                                       "reference": j["reference"], "status": "posted", "lines": lines})
d2 = c.get("/api/expense-detail?company_id=%d&year=2026" % mda["id"]).get_json()
food = next(t for t in d2["grab"]["trips"] if t["booking_id"] == "A-FD1")
check("LEDGER-WINS", food["amount"] == 120000, "an entry edited after import reports the edited amount")
c.delete("/api/journals/%d" % jid)
d3 = c.get("/api/expense-detail?company_id=%d&year=2026" % mda["id"]).get_json()
check("DELETED", d3["grab"]["count"] == 4, "deleting the entry removes the trip with it")

print("=== petty cash: in, out, and where it went ===")
pc = next(a for a in c.get("/api/accounts?company_id=%d" % mda["id"]).get_json() if a["code"] == "1130")
bank = next(a for a in accts if a["code"] == "1120")
meal = next(a for a in accts if a["code"].startswith("66") and a["type"] == "expense")
misc = next(a for a in accts if a["code"] == "6900")
post = lambda date, lines, desc: c.post("/api/journals", json={
    "company_id": mda["id"], "date": date, "description": desc, "status": "posted", "lines": lines,
    "source": "monit_wallet"})
post("2025-12-30", [{"account_id": pc["id"], "debit": 50000, "credit": 0},
                    {"account_id": bank["id"], "debit": 0, "credit": 50000}], "last year's top-up")
post("2026-03-02", [{"account_id": pc["id"], "debit": 1000000, "credit": 0},
                    {"account_id": bank["id"], "debit": 0, "credit": 1000000}], "top-up")
post("2026-03-05", [{"account_id": meal["id"], "debit": 300000, "credit": 0},
                    {"account_id": misc["id"], "debit": 100000, "credit": 0},
                    {"account_id": pc["id"], "debit": 0, "credit": 400000}], "lunch and a spare part")
p = c.get("/api/expense-detail?company_id=%d&year=2026" % mda["id"]).get_json()["petty"]
check("OPENING", p["opening"] == 50000, "last year's top-up is the opening balance, not this year's money in")
check("IN-OUT", p["in_total"] == 1000000 and p["out_total"] == 400000 and p["closing"] == 650000,
      "in %s, out %s, closing %s" % (p["in_total"], p["out_total"], p["closing"]))
use = {u["code"]: u["amount"] for u in p["usage"]}
check("SPLIT", use.get(meal["code"]) == 300000 and use.get("6900") == 100000,
      "one entry, two cost accounts, each at its own share")
check("SOURCE", p["sources"][0]["code"] == "1120", "the top-up came from the bank")
check("RUNNING", p["rows"][-1]["balance"] == 650000, "the running balance ends at the closing balance")

print("=== menus ===")
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access,"
             " menu_access) VALUES ('fin2','x','Finance','finance','all','journals')")
conn.commit()
database.migrate_database(conn)
got = set(conn.execute("SELECT menu_access FROM users WHERE username='fin2'").fetchone()[0].split(","))
check("MENU", "expenses" in got and "journals" in got, "a restricted menu gains the Expense Breakdown")
conn.close()

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
