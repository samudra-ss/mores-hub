"""v1.12b: the account popup's budget used + Excel download, the Project HV
tables by sector with NCT, and the menu / page motion.

    python apps/erp/tests/test_v112b_ledger_motion.py
"""
import io
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)
os.environ["MORES_HV_DATA_DIR"] = tempfile.mkdtemp(prefix="v112b_")

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
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
companies = {x["code"]: x["id"] for x in c.get("/api/companies").get_json()}
mda = companies["MDA"]
acc = {a["code"]: a["id"] for a in c.get("/api/accounts?company_id=%d" % mda).get_json()}

print("=== the account popup ===")
conn = database.get_db(database.DEFAULT_DB)
conn.execute("DELETE FROM budgets WHERE company_id=? AND account_id=? AND year=2026", (mda, acc["6200"]))
for m in range(1, 13):
    conn.execute("INSERT INTO budgets (company_id, account_id, project_id, year, month, amount) VALUES (?,?,NULL,2026,?,?)",
                 (mda, acc["6200"], m, 10e6))
conn.commit()
net = conn.execute(
    "SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
    " WHERE je.status='posted' AND je.company_id=? AND jl.account_id=? AND je.date BETWEEN '2026-01-01' AND '2026-12-31'",
    (mda, acc["6200"])).fetchone()[0]
conn.close()
q = "company_id=%d&year=2026&date_from=2026-01-01&date_to=2026-12-31&code=6200" % mda
d = c.get("/api/reports/account-ledger?" + q).get_json()
check("BUDGET", d["budget"] == 120e6, "the year's budget on the account: Rp %s" % d["budget"])
check("ACTUAL", abs(d["actual"] - net) < 0.01, "realization = debit - credit on a cost account (Rp %s)" % d["actual"])
check("USED", d["used_pct"] == round(100.0 * net / 120e6, 1), "%s%% of budget used" % d["used_pct"])
r = c.get("/api/reports/account-ledger.xlsx?" + q)
check("XLSX", r.status_code == 200 and "account_6200_2026.xlsx" in r.headers.get("Content-Disposition", ""),
      "the popup's Download Excel returns a workbook")
ws = load_workbook(io.BytesIO(r.data)).active
r.close()
cells = {ws.cell(row=i, column=1).value: ws.cell(row=i, column=2).value for i in range(1, 8)}
rows = [ws.cell(row=i, column=2).value for i in range(9, ws.max_row)]
check("XLSX-BUDGET", cells.get("Budget (year)") == 120e6 and abs((cells.get("Budget used") or 0) - d["used_pct"] / 100) < 1e-9,
      "the workbook states the budget and how much is used")
check("XLSX-LINES", len(rows) == len(d["entries"]), "%d posted lines, one row each, plus the total" % len(rows))
none = c.get("/api/reports/account-ledger?company_id=%d&year=2026&code=4100" % mda).get_json()
check("NO-BUDGET", none["budget"] == 0 and none["used_pct"] is None, "an account with no budget says so, not 0%")
check("NEED-CODE", c.get("/api/reports/account-ledger.xlsx?company_id=%d" % mda).status_code == 400, "a code is required")

print("=== Project HV and motion (in the page code) ===")
js = open(os.path.join(ERP, "static", "app.js"), encoding="utf-8").read()
tbl = js[js.index("function phContractTable(rows, types)"):js.index("\n}\n", js.index("function phContractTable(rows, types)"))]
check("NCT", ">NCT</th>" in tbl and not re.search(r't\("Margin"\)', tbl), "the contract table's last column is NCT, not Margin")
check("SECTORS", "phSectorGroups(list, types)" in tbl and "phContractTable(rows, types)" in js
      and 'api("/api/project-types")' in js[js.index("async function pageProjectHV"):js.index("async function pageProjectHV") + 600],
      "Project HV reads the sectors and groups its tables by them")
check("SCOREBOARD", 'title="${t("Gain over revenue")}">NCT</th>' in js, "the scoreboard says NCT too")
css = open(os.path.join(ERP, "static", "styles.css"), encoding="utf-8").read()
check("FIT", ".ph-fit .tbl, .ph-gp-scroll.ph-fit .tbl { min-width: 0; width: 100%; font-size: 11.5px; }" in css,
      "smaller type and no forced width, so the table fits")
check("PILL", "tween(prev, lead, to[lead], 0.36, EASE.out3, paint)" in js and "tween(prev, trail, to[trail], 0.55, EASE.inOut3, paint)" in js,
      "the menu pill: leading edge 0.36 s power3.out, trailing edge 0.55 s power3.inOut")
check("REDUCED", "prefers-reduced-motion: reduce" in js and "@media (prefers-reduced-motion: reduce) { .pg-in" in css,
      "nothing moves when less motion is asked for")

print("=== the menu: full / collapsed / hidden, and the softer page change ===")
html = open(os.path.join(ERP, "static", "app.html"), encoding="utf-8").read()
check("NAV-PREPAINT", 'dataset.nav = localStorage.getItem("erp.nav") || "full"' in html,
      "the menu state is set before the first paint, so it never flashes open")
check("NAV-BUTTONS", 'id="navCycle"' in html and 'id="navCollapse"' in html, "a menu button in the top bar and a collapse arrow in the menu")
check("NAV-MODES", 'const NAV_MODES = ["full", "rail", "hidden"]' in js and 'localStorage.setItem("erp.nav", mode)' in js
      and 'e.key.toLowerCase() === "b"' in js, "three states, remembered, Ctrl+B cycles them")
check("NAV-CSS", 'html[data-nav="rail"] .sidebar { width: 68px; }' in css and 'html[data-nav="hidden"] .sidebar { width: 0;' in css
      and "content: attr(data-label)" in css, "the rail is 68 px with a name beside each icon; hidden takes the menu away")
check("PILL-FOLLOWS", "new ResizeObserver(" in js and 'addEventListener("transitionend"' in js,
      "the highlight follows the menu as it changes width")
check("SOFT", "@keyframes pgIn { from { opacity: 0; filter: blur(12px); transform: scale(.985); } }" in css
      and "pgSweep" in css and "function rollDigits(" in js and 'class="empty pg-wait"' in js,
      "frosted panels that sharpen, a title sweep, rolling numbers, no Loading flash")

print("\n%d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
