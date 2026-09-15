"""Product Finance engine: the rules that must not quietly change.

Pure-context tests need no database. The ledger tests build a tiny in-memory
SQLite from the real schema, so the project-not-company rule and the
actual-through rules are checked against real SQL.

    python apps/erp/tests/test_product_fa.py
"""
import datetime
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import database  # noqa: E402
import product_fa as F  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-10s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-10s %s" % (name, detail))


def ctx(**over):
    base = {
        "product": {"burn_budget": 0}, "assumptions": F.merged_assumptions({}),
        "lines": [], "oneoffs": [], "capex": [], "project_ids": [], "company_ids": [],
        "actuals": {}, "last_ledger_month": None, "actual_through": "2025-12",
        "actual_through_source": "calendar", "start": "2026-01", "end": "2027-12",
        "launch": "2026-01", "target_year": 2027, "today": "2026-09-15",
    }
    a = over.pop("assumptions", None)
    base.update(over)
    if a:
        base["assumptions"] = F.merged_assumptions(a)
    return base


def row(sim, m):
    return next(r for r in sim["months"] if r["month"] == m)


print("=== calendar ===")
check("WD", (F.working_days("2026-09"), F.working_days("2026-08"), F.working_days("2026-02")) == (22, 21, 20),
      "Sep-26 22, Aug-26 21, Feb-26 20 working days (Sep-26 matches the workbook)")
check("YM", F.ym_add("2026-11", 3) == "2027-02" and F.months_between("2026-03", "2027-12") == 21,
      "month arithmetic crosses year ends")

print("=== account categories ===")
check("CAT", (F.category_of("5100-02"), F.category_of("6620"), F.category_of("6500"), F.category_of("6400"))
      == ("server", "office", "noncash", "marketing"), "longest prefix wins")
check("CAT-OVR", F.category_of("5100-02", {"5100-02": "tools"}) == "tools", "a product override beats the default")

print("=== cost lines ===")
c = ctx(lines=[{"label": "team", "category": "people", "monthly_amount": 100, "basis": "fixed"},
               {"label": "food", "category": "office", "monthly_amount": 10, "basis": "per_working_day"},
               {"label": "ads", "category": "marketing", "monthly_amount": 50, "basis": "fixed",
                "start_month": "2026-09", "end_month": "2026-10"},
               {"label": "rent", "category": "office", "monthly_amount": 1000, "basis": "fixed",
                "escalation_annual": 0.12}])
s = F.simulate(c)
sep = row(s, "2026-09")
check("LINES", sep["costs"]["people"] == 100 and sep["costs"]["office"] == 220 + round(1000 * 1.12 ** (8 / 12), 2),
      "fixed + per-working-day (22 x 10) + escalation")
check("WINDOW", row(s, "2026-08")["costs"]["marketing"] == 0 and sep["costs"]["marketing"] == 50
      and row(s, "2026-11")["costs"]["marketing"] == 0, "start and end months are honoured")
check("ESC", abs(row(s, "2027-01")["costs"]["office"] - (21 * 10 + 1000 * 1.12)) < 0.01,
      "12% a year is exactly 12% after twelve months")

print("=== CAPEX: cash when bought, depreciation after ===")
s = F.simulate(ctx(capex=[{"month": "2026-02", "label": "server", "amount": 4800, "life_months": 48}]))
check("CAPEX", row(s, "2026-02")["capex"] == 4800 and row(s, "2026-02")["depreciation"] == 0
      and row(s, "2026-03")["depreciation"] == 100, "Rp 4,800 over 48 months: cash in Feb, Rp 100 a month from Mar")
check("CAPEX-PL", row(s, "2026-02")["profit"] == 0 and row(s, "2026-02")["net_cash"] == -4800,
      "profit ignores the purchase, cash does not")

print("=== users, churn, server tiers ===")
s = F.simulate(ctx(assumptions={"arpu": 10, "start_users": 10, "new_users_first": 5, "churn_monthly": 0.1,
                                "server_base": 50, "server_per_user": 2, "server_step_users": 10,
                                "server_step_cost": 100}))
m1, m2 = row(s, "2026-01"), row(s, "2026-02")
check("USERS", m1["users_end"] == 14 and m2["users_end"] == 17.6, "10 - 10% + 5 = 14, then 14 - 1.4 + 5 = 17.6")
check("SERVER", m1["costs"]["server"] == 50 + 2 * 14 + 100, "base + per user + one full tier of 10")
check("MRR", m1["mrr"] == 140 and m1["revenue"] == 140, "14 users x Rp 10")
n = F._solve_new_users({"start_users": 10, "churn_monthly": 0.1}, 12, 60)
sim_n = F.simulate(ctx(assumptions={"arpu": 1, "start_users": 10, "new_users_first": n, "churn_monthly": 0.1}))
check("SOLVE", abs(row(sim_n, "2026-12")["users_end"] - 60) < 1e-6,
      "the closed-form acquisition rate really lands on 60 users after 12 months")

print("=== payback and break-even mean STAYING there ===")
c = ctx(lines=[{"label": "cost", "category": "people", "monthly_amount": 100, "basis": "fixed"}],
        oneoffs=[{"month": "2026-03", "flow": "in", "label": "termin", "amount": 500}])
s = F.simulate(c)
sm = F.summarise(c, s)
check("PAYBACK", sm["payback_month"] is None and sm["funding_required"] > 0,
      "a termin that lifts cash above zero for a while is not payback (end: %s)" % s["months"][-1]["cum_cash"])
c2 = ctx(lines=[{"label": "cost", "category": "people", "monthly_amount": 100, "basis": "fixed"}],
         assumptions={"arpu": 1, "start_users": 300, "revenue_start_month": "2026-06"})
s2 = F.simulate(c2)
sm2 = F.summarise(c2, s2)
neg = [r["month"] for r in s2["months"] if r["cum_cash"] < 0]
check("PAYBACK2", sm2["payback_month"] == F.ym_add(neg[-1], 1),
      "payback is the month after the LAST negative cumulative month (%s)" % sm2["payback_month"])
check("BREAKEVEN", sm2["break_even_month"] == "2026-06", "profitable from launch and never again negative")

print("=== verdict ===")
check("V-NOT", sm["verdict"] == "NOT_PROFITABLE", "cost with no revenue")
check("V-OK", sm2["verdict"] == "PROFITABLE", "run-rate profitable and paid back by Dec-27")
check("V-NODATA", F.summarise(ctx(), F.simulate(ctx()))["verdict"] == "NO_DATA", "nothing to judge")

print("=== targets and the growth ladder ===")
c3 = ctx(lines=[{"label": "team", "category": "people", "monthly_amount": 1000, "basis": "fixed"}],
         assumptions={"arpu": 50, "start_users": 0, "new_users_first": 2, "new_users_growth": 0.05,
                      "churn_monthly": 0.03, "server_per_user": 5, "revenue_start_month": "2026-03"})
tg = F.targets(c3, F.simulate(c3))
check("T-USERS", tg["required_active_users"] == 23, "Rp 1,000 fixed / (Rp 50 - Rp 5) = 22.2 -> 23 users")
cash = [r["cum_cash"] for r in tg["ladder"]]
check("T-LADDER", all(b >= a for a, b in zip(cash, cash[1:])), "faster acquisition never ends with less cash")
g = tg["required_growth_for_payback"]
if g is not None:
    s_at = F.simulate(c3, {"new_users_growth": g})
    s_below = F.simulate(c3, {"new_users_growth": max(0.0, g - 0.002)})
    check("T-GROWTH", row(s_at, "2027-12")["cum_cash"] >= 0 > row(s_below, "2027-12")["cum_cash"],
          "the solved growth rate (%.2f%%) is the boundary, not just any passing rate" % (g * 100))
else:
    check("T-GROWTH", False, "expected a reachable growth rate in this scenario")
check("T-NOARPU", F.targets(ctx(), F.simulate(ctx())).get("required_active_users") is None,
      "no price, no number of users that breaks even")

print("=== the ledger: filtered by PROJECT, not by booking company ===")
conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.executescript(database.SCHEMA)
database.ensure_product_tables(conn)
conn.execute("INSERT INTO companies (id, code, name) VALUES (1,'MDA','MDA'), (2,'SBR','SBR')")
for cid in (1, 2):
    for code, typ in (("1120", "asset"), ("4200", "revenue"), ("5100-01", "expense"),
                      ("5100-02", "expense"), ("6500", "expense")):
        conn.execute("INSERT INTO accounts (company_id, code, name, type) VALUES (?,?,?,?)", (cid, code, code, typ))
acc = lambda cid, code: conn.execute("SELECT id FROM accounts WHERE company_id=? AND code=?", (cid, code)).fetchone()[0]
conn.execute("INSERT INTO projects (id, company_id, code, name) VALUES (20, 2, 'NX-01', 'NX-01')")


def post(cid, date, lines, status="posted"):
    cur = conn.execute("INSERT INTO journal_entries (company_id, entry_no, date, status) VALUES (?,?,?,?)",
                       (cid, "JV-%s-%s" % (date, cid), date, status))
    for code, prj, dr, cr in lines:
        conn.execute("INSERT INTO journal_lines (entry_id, account_id, project_id, debit, credit) VALUES (?,?,?,?,?)",
                     (cur.lastrowid, acc(cid, code), prj, dr, cr))


# NX-01 belongs to SBR, but its costs are booked in MDA's books
post(1, "2026-01-10", [("5100-01", 20, 1000, 0), ("1120", None, 0, 1000)])
post(1, "2026-02-10", [("5100-02", 20, 300, 0), ("6500", 20, 40, 0), ("1120", None, 0, 340)])
post(2, "2026-03-05", [("1120", None, 5000, 0), ("4200", 20, 0, 5000)])
post(1, "2026-04-10", [("5100-01", 20, 999, 0), ("1120", None, 0, 999)], status="draft")
cur = conn.execute("INSERT INTO products (company_id, name, launch_month, target_year) VALUES (2,'NX',?,2027)", ("2026-01",))
pid = cur.lastrowid
conn.execute("INSERT INTO product_projects VALUES (?, 20)", (pid,))

cx = F.load_context(conn, pid, [1, 2], today=datetime.date(2026, 9, 15))
check("L-PROJECT", cx["actuals"]["2026-01"]["costs"]["people"] == 1000,
      "a cost booked in MDA's books still counts for SBR's product")
check("L-CATS", cx["actuals"]["2026-02"]["costs"]["server"] == 300 and cx["actuals"]["2026-02"]["noncash"] == 40,
      "5100-02 is server, 6500 is non-cash")
check("L-REV", cx["actuals"]["2026-03"]["revenue"] == 5000, "revenue on the credit side")
check("L-DRAFT", "2026-04" not in cx["actuals"], "draft entries are not actuals")
check("L-THRU", cx["actual_through"] == "2026-03" and cx["actual_through_source"] == "ledger",
      "actual through = last month the ledger has")
cx_hidden = F.load_context(conn, pid, [2], today=datetime.date(2026, 9, 15))
check("L-ACCESS", "2026-01" not in cx_hidden["actuals"] and cx_hidden["actuals"]["2026-03"]["revenue"] == 5000,
      "lines booked in a company the user cannot see are left out")
sim = F.simulate(cx)
check("L-DEP", row(sim, "2026-02")["depreciation"] == 40 and row(sim, "2026-02")["opex"] == 300,
      "booked depreciation stays out of opex")
y26 = F.summarise(cx, sim)["years"]["2026"]
check("L-ACCTS", sum(a["amount"] for a in y26["actual_accounts"]) == y26["actual_opex"] == 1300,
      "realization by account adds up to actual opex (5100-01 1,000 + 5100-02 300)")
check("L-ACCT-ORD", [a["code"] for a in y26["actual_accounts"]] == ["5100-01", "5100-02"]
      and all(a["category"] for a in y26["actual_accounts"]),
      "largest first, each with its category, depreciation left out")
check("L-SPLIT", y26["actual_opex"] + y26["forecast_opex"] == y26["opex"],
      "actual + forecast opex is the year's opex")

conn.execute("UPDATE products SET actual_through='2026-12' WHERE id=?", (pid,))
cx2 = F.load_context(conn, pid, [1, 2], today=datetime.date(2026, 9, 15))
check("L-FUTURE", cx2["actual_through"] == "2026-08",
      "a month that has not finished is never actual, whatever was typed (%s)" % cx2["actual_through"])
conn.execute("DELETE FROM product_projects")
conn.execute("UPDATE products SET actual_through=NULL WHERE id=?", (pid,))
cx3 = F.load_context(conn, pid, [1, 2], today=datetime.date(2026, 9, 15))
check("L-NOLEDGER", all(r["phase"] == "forecast" for r in F.simulate(cx3)["months"]),
      "with no ledger linked, no month pretends to be an actual")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
