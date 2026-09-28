"""SBU finance report - the executive pack finance keeps by hand for an SBU
(the "Template Finance Report NX-Sentimind" workbook), built from the ledger
instead of retyped every month.

Six views, in the workbook's order:

  DASHBOARD             eight tiles and the health traffic lights
  P&L YTD               budget vs actual per month for every report line
  CASH FLOW             every posted line on the SBU's projects, running balance
  TRACKER PROYEK        per project: contract, cost budget vs realisation, invoicing
  INDIKATOR KESEHATAN   every indicator against its green and amber limits
  KINERJA SaaS          customers, MRR, churn and unit economics by month

Facts come from POSTED journal lines tagged to the SBU's linked projects (in
whichever company's books they were booked, as the SBU analysis already does)
and from the budgets on those projects. What the ledger cannot know - targets,
customer counts, a project's client and risk, the director's actions - comes
from the SBU's report settings (products.report), edited on the Report settings
tab. Nothing here writes to the ledger.
"""
import calendar
import datetime
import json

MONTHS_ID = ("Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des")

# ---------------------------------------------------------------- P&L lines --
# (key, section, group, label, default account-code prefixes). A line takes the
# accounts whose code starts with one of its prefixes; the longest prefix wins,
# so "5" on Others Cost only catches what no specific COGS line claimed. Revenue
# and COGS are split by the KIND of project the line is tagged to - a client
# project or the SaaS product - exactly as the workbook splits them.
PNL_LINES = [
    ("rev_saas", "revenue", "saas", "SaaS — Subscription", ["4"]),
    ("rev_project", "revenue", "project", "Project Revenue", ["4"]),
    ("cogs_p_direct", "cogs", "project", "Direct Cost", ["5100-01"]),
    ("cogs_p_nondirect", "cogs", "project", "Non Direct Cost", ["5100-02"]),
    ("cogs_p_material", "cogs", "project", "Material Cost", ["5100-03"]),
    ("cogs_p_other", "cogs", "project", "Others Cost", ["5100-04", "5"]),
    ("cogs_s_direct", "cogs", "saas", "Direct Cost", ["5100-01"]),
    ("cogs_s_cloud", "cogs", "saas", "Cloud & Infrastructure", ["5100-02"]),
    ("cogs_s_api", "cogs", "saas", "Third-party Data / API Fees", []),
    ("cogs_s_material", "cogs", "saas", "Material Cost", ["5100-03"]),
    ("cogs_s_other", "cogs", "saas", "Others Cost", ["5100-04", "5"]),
    ("opex_salary", "opex", "", "Salary General Team & BPJS", ["6100"]),
    ("opex_software", "opex", "", "Software & Tools", ["6300"]),
    ("opex_rent", "opex", "", "Rent Expense", ["6200"]),
    ("opex_util", "opex", "", "Utilities & Operational", ["6600", "6610", "6630"]),
    ("opex_event", "opex", "", "Event Marketing", ["6400"]),
    ("opex_meals", "opex", "", "Meals, Office Supplies", ["6620"]),
    ("opex_ent", "opex", "", "Entertainment, Meeting, Training", []),
    ("opex_medical", "opex", "", "Medical", ["6640"]),
    ("opex_equipment", "opex", "", "Office Equipment", []),
    ("opex_other", "opex", "", "Other Operating Expense", ["6", "7", "8"]),
    ("da", "da", "", "Depreciation & Amortisation", ["6500"]),
]
LINE_BY_KEY = {k: (k, s, g, lbl, codes) for k, s, g, lbl, codes in PNL_LINES}
PROJECT_KINDS = ("project", "saas")

# project tracker cost buckets, the workbook's four columns
TRACK_BUCKETS = (("direct", "Direct", "5100-01"), ("nondirect", "Non Direct", "5100-02"),
                 ("material", "Material", "5100-03"), ("misc", "Fixed/Misc", None))

# ---------------------------------------------------------------- indicators --
# (key, group, label, unit, direction, default safe limit, default attention limit)
# "high" = bigger is better. Defaults are the workbook's own limits.
INDICATORS = [
    ("runway", "liquidity", "Runway", "months", "high", 12, 6),
    ("current_ratio", "liquidity", "Current Ratio", "x", "high", 2.0, 1.0),
    ("cash_vs_burn", "liquidity", "Cash vs Burn Rate", "x", "high", 3.5, 3.0),
    ("outstanding", "liquidity", "Outstanding Invoice", "rp", "low", 0, 1000000000),
    ("cash_position", "liquidity", "Cash Position", "rp", "high", 500000000, 200000000),
    ("gross_margin", "profit", "Gross Margin", "pct", "high", 0.4699, 0.30),
    ("net_margin", "profit", "Net Profit Margin", "pct", "high", 0.15, 0.0),
    ("ebitda_margin", "profit", "EBITDA Margin", "pct", "high", 0.20, 0.05),
    ("project_gm", "profit", "Project Gross Margin", "pct", "high", 0.50, 0.35),
    ("mrr", "saas", "MRR vs Target", "rp", "high", 15000000, 10000000),
    ("mrr_growth", "saas", "MRR Growth MoM", "pct", "high", 0.15, 0.05),
    ("churn", "saas", "Churn Rate", "pct", "low", 0.03, 0.05),
    ("ltv_cac", "saas", "LTV / CAC Ratio", "x", "high", 3.0, 1.5),
    ("nrr", "saas", "NRR (Net Revenue Retention)", "pct", "high", 1.0, 0.85),
    ("pipeline", "ops", "Project Pipeline", "rp", "high", 5000000000, 3000000000),
    ("burn_rate", "ops", "Burn Rate (monthly)", "rp", "low", 25000000, 35000000),
    ("dso", "ops", "DSO — Days Sales Outstanding", "days", "low", 60, 90),
    ("rev_per_employee", "ops", "Revenue per Employee", "rp", "high", 100000000, 60000000),
]
IND_BY_KEY = {i[0]: i for i in INDICATORS}
IND_GROUPS = (("liquidity", "Liquidity & Solvency"), ("profit", "Profitability"),
              ("saas", "SaaS Performance"), ("ops", "Operations & Projects"))
# the twelve the workbook's DASHBOARD sheet shows, in its order
DASHBOARD_INDICATORS = ("runway", "gross_margin", "net_margin", "mrr", "mrr_growth", "churn",
                        "outstanding", "burn_rate", "dso", "current_ratio", "pipeline", "cash_position")
URGENCIES = (("now", "🔴 SEGERA"), ("week", "🟡 MINGGU INI"), ("month", "🟡 BULAN INI"),
             ("quarter", "🔵 KUARTAL INI"))

DEFAULT_REPORT = {
    "title": "", "subtitle": "", "through": "",
    "opening_cash": 0.0, "headcount": 0, "tax_rate": 0.22, "ltv_churn": 0.05,
    "opening_customers": 0,
    "saas_months": {}, "projects": {}, "indicators": {}, "actions": [], "lines": {},
}


def _f(x, default=None):
    try:
        if x is None or x == "":
            return default
        v = float(x)
        return v if v == v and v not in (float("inf"), float("-inf")) else default
    except (TypeError, ValueError):
        return default


def load_settings(raw):
    s = json.loads(json.dumps(DEFAULT_REPORT))
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError:
            raw = {}
    for k, v in (raw or {}).items():
        if k in s and v is not None:
            s[k] = v
    return s


def clean_settings(d):
    """Validate what the Report settings tab sends. Raises ValueError."""
    s = load_settings({})
    s["title"] = str(d.get("title") or "").strip()[:80]
    s["subtitle"] = str(d.get("subtitle") or "").strip()[:80]
    thr = str(d.get("through") or "").strip()[:7]
    if thr:
        try:
            datetime.date(int(thr[:4]), int(thr[5:7]), 1)
        except (ValueError, IndexError):
            raise ValueError("'Closed through' must be a month (YYYY-MM)")
    s["through"] = thr
    s["opening_cash"] = _f(d.get("opening_cash"), 0.0)
    s["headcount"] = max(0, int(_f(d.get("headcount"), 0) or 0))
    s["opening_customers"] = max(0, int(_f(d.get("opening_customers"), 0) or 0))
    for key, lo, hi, label in (("tax_rate", 0, 1, "Tax rate"), ("ltv_churn", 0.0001, 1, "LTV churn")):
        v = _f(d.get(key), DEFAULT_REPORT[key])
        if not lo <= v <= hi:
            raise ValueError("%s must be between %g%% and %g%%" % (label, lo * 100, hi * 100))
        s[key] = v
    months = {}
    for m, row in (d.get("saas_months") or {}).items():
        if not (isinstance(m, str) and len(m) == 7 and m[4] == "-"):
            continue
        clean = {}
        for k in ("new", "churned"):
            v = _f((row or {}).get(k))
            if v is not None:
                if v < 0:
                    raise ValueError("Customer counts cannot be negative (%s)" % m)
                clean[k] = int(round(v))
        for k in ("mrr_budget", "mrr_actual", "cac"):
            v = _f((row or {}).get(k))
            if v is not None:
                clean[k] = v
        if clean:
            months[m] = clean
    s["saas_months"] = months
    projects = {}
    for pid, meta in (d.get("projects") or {}).items():
        meta = meta or {}
        kind = meta.get("kind") if meta.get("kind") in PROJECT_KINDS else "project"
        clean = {"kind": kind}
        for k in ("client", "status", "risk", "note"):
            clean[k] = str(meta.get(k) or "").strip()[:1500 if k == "note" else 200]
        for k in ("contract_value", "invoiced", "paid"):
            v = _f(meta.get(k))
            if v is not None:
                clean[k] = v
        projects[str(int(pid))] = clean
    s["projects"] = projects
    inds = {}
    for key, v in (d.get("indicators") or {}).items():
        if key not in IND_BY_KEY:
            continue
        clean = {}
        for k in ("safe", "attention", "actual"):
            x = _f((v or {}).get(k))
            if x is not None:
                clean[k] = x
        note = str((v or {}).get("note") or "").strip()[:600]
        if note:
            clean["note"] = note
        if clean:
            inds[key] = clean
    s["indicators"] = inds
    urg = {u for u, _ in URGENCIES}
    s["actions"] = [{"urgency": a.get("urgency") if a.get("urgency") in urg else "now",
                     "text": str(a.get("text") or "").strip()[:800]}
                    for a in (d.get("actions") or []) if str(a.get("text") or "").strip()]
    lines = {}
    for key, v in (d.get("lines") or {}).items():
        if key not in LINE_BY_KEY:
            continue
        clean = {}
        if str((v or {}).get("label") or "").strip():
            clean["label"] = str(v["label"]).strip()[:80]
        if "codes" in (v or {}):
            raw = v["codes"]
            codes = raw if isinstance(raw, list) else str(raw or "").replace(";", ",").split(",")
            clean["codes"] = [c.strip() for c in codes if c.strip()]
        if clean:
            lines[key] = clean
    s["lines"] = lines
    return s


# ------------------------------------------------------------------ helpers --

def through_month(year, settings, today=None):
    """The last month the report treats as closed. A year that has finished is
    closed through December; the current year through last month."""
    today = today or datetime.date.today()
    thr = settings.get("through") or ""
    if thr[:4] == str(year):
        return int(thr[5:7])
    if year < today.year:
        return 12
    if year > today.year:
        return 0
    return max(1, today.month - 1)


def resolved_lines(settings):
    out = []
    for key, section, group, label, codes in PNL_LINES:
        ov = (settings.get("lines") or {}).get(key, {})
        out.append({"key": key, "section": section, "group": group,
                    "label": ov.get("label") or label, "default_label": label,
                    "codes": ov.get("codes") if "codes" in ov else list(codes),
                    "default_codes": list(codes)})
    return out


def line_for(code, acc_type, kind, lines):
    """Which report line an account lands on. Longest matching prefix wins."""
    code = str(code or "")
    if acc_type == "revenue":
        return "rev_saas" if kind == "saas" else "rev_project"
    if acc_type != "expense":
        return None
    if code.startswith("5"):
        group = "saas" if kind == "saas" else "project"
        pool = [ln for ln in lines if ln["section"] == "cogs" and ln["group"] == group]
        fallback = "cogs_s_other" if group == "saas" else "cogs_p_other"
    else:
        pool = [ln for ln in lines if ln["section"] in ("opex", "da")]
        fallback = "opex_other"
    best, best_len = fallback, -1
    for ln in pool:
        for p in ln["codes"]:
            if code.startswith(p) and len(p) > best_len:
                best, best_len = ln["key"], len(p)
    return best


def _bucket(code):
    for key, _lbl, prefix in TRACK_BUCKETS:
        if prefix and str(code).startswith(prefix):
            return key
    return "misc"


def _status(value, direction, safe, attention):
    if value is None:
        return "watch"
    if direction == "high":
        return "safe" if value >= safe else "watch" if value >= attention else "critical"
    return "safe" if value <= safe else "watch" if value <= attention else "critical"


def _div(a, b):
    return (a / b) if b else None


def _r(v, n=2):
    return None if v is None else round(v, n)


# ------------------------------------------------------------------- loading --

def _linked_projects(conn, product_id):
    return [dict(r) for r in conn.execute(
        "SELECT p.id, p.code, p.name, p.status, p.start_date, p.end_date, p.contract_value,"
        " p.company_id, c.code AS company_code"
        " FROM product_projects pp JOIN projects p ON p.id = pp.project_id"
        " JOIN companies c ON c.id = p.company_id"
        " WHERE pp.product_id = ? ORDER BY p.code", (product_id,))]


def _ledger(conn, project_ids, company_ids, year):
    if not project_ids or not company_ids:
        return []
    return [dict(r) for r in conn.execute(
        "SELECT jl.project_id, a.code, a.name, a.type, je.date, je.entry_no, je.id AS entry_id,"
        " COALESCE(NULLIF(jl.description, ''), je.description) AS description,"
        " jl.debit, jl.credit"
        " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
        " JOIN accounts a ON a.id = jl.account_id"
        " WHERE je.status = 'posted' AND jl.project_id IN (%s) AND je.company_id IN (%s)"
        " AND a.type IN ('revenue', 'expense') AND je.date BETWEEN ? AND ?"
        " ORDER BY je.date, je.id, jl.id"
        % (",".join("?" * len(project_ids)), ",".join("?" * len(company_ids))),
        list(project_ids) + list(company_ids) + ["%d-01-01" % year, "%d-12-31" % year])]


def _budgets(conn, project_ids, company_ids, year):
    if not project_ids or not company_ids:
        return []
    return [dict(r) for r in conn.execute(
        "SELECT b.project_id, a.code, a.type, b.month, COALESCE(SUM(b.amount), 0) AS amount"
        " FROM budgets b JOIN accounts a ON a.id = b.account_id"
        " WHERE b.year = ? AND b.project_id IN (%s) AND b.company_id IN (%s)"
        " AND a.type IN ('revenue', 'expense')"
        " GROUP BY b.project_id, a.code, a.type, b.month"
        % (",".join("?" * len(project_ids)), ",".join("?" * len(company_ids))),
        [year] + list(project_ids) + list(company_ids))]


def _money_tracker(conn, project_ids):
    if not project_ids:
        return {}
    out = {}
    for r in conn.execute(
            "SELECT project_id, client, amount, status FROM money_tracker"
            " WHERE project_id IN (%s) AND status NOT IN ('cancelled', 'prospectus')"
            % ",".join("?" * len(project_ids)), list(project_ids)):
        slot = out.setdefault(r["project_id"], {"amount": 0.0, "client": ""})
        slot["amount"] += r["amount"] or 0
        slot["client"] = slot["client"] or (r["client"] or "")
    return out


def _current_ratio(conn, company_id, as_of):
    """Company-level, the way the dashboard measures it: current assets over
    current liabilities at the report date (fixed assets 15xx and long-term 2500
    left out)."""
    rows = conn.execute(
        "SELECT a.type, a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS bal"
        " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
        " JOIN accounts a ON a.id = jl.account_id"
        " WHERE je.status = 'posted' AND je.company_id = ? AND je.date <= ?"
        " AND a.type IN ('asset', 'liability') GROUP BY a.type, a.code",
        (company_id, as_of)).fetchall()
    ca = sum(r["bal"] for r in rows if r["type"] == "asset" and not str(r["code"]).startswith("15"))
    cl = sum(-r["bal"] for r in rows if r["type"] == "liability" and r["code"] != "2500")
    return round(ca / cl, 2) if cl > 0 else None


# ------------------------------------------------------------------- report --

def build(conn, product_id, company_ids, year, today=None):
    today = today or datetime.date.today()
    p = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    if not p:
        raise ValueError("SBU not found")
    p = dict(p)
    st = load_settings(p.get("report"))
    year = int(year)
    T = through_month(year, st, today)
    lines = resolved_lines(st)
    projects = _linked_projects(conn, product_id)
    pids = [x["id"] for x in projects]
    meta = {str(x["id"]): dict({"kind": "project"}, **(st["projects"].get(str(x["id"])) or {}))
            for x in projects}
    kind_of = {x["id"]: meta[str(x["id"])].get("kind", "project") for x in projects}

    ledger = _ledger(conn, pids, company_ids, year)
    budgets = _budgets(conn, pids, company_ids, year)

    # ---- P&L: per line, 12 months of budget and actual -----------------------
    act = {ln["key"]: [0.0] * 12 for ln in lines}
    bud = {ln["key"]: [0.0] * 12 for ln in lines}
    accounts_on = {ln["key"]: {} for ln in lines}
    for r in ledger:
        key = line_for(r["code"], r["type"], kind_of.get(r["project_id"]), lines)
        if not key:
            continue
        m = int(r["date"][5:7]) - 1
        amt = ((r["credit"] or 0) - (r["debit"] or 0)) if r["type"] == "revenue" \
            else ((r["debit"] or 0) - (r["credit"] or 0))
        act[key][m] += amt
        accounts_on[key][r["code"]] = r["name"]
        r["line"] = key
    for b in budgets:
        key = line_for(b["code"], b["type"], kind_of.get(b["project_id"]), lines)
        if key and 1 <= int(b["month"]) <= 12:
            bud[key][int(b["month"]) - 1] += b["amount"] or 0

    def total(keys, src):
        return [sum(src[k][i] for k in keys) for i in range(12)]

    keys = lambda section, group=None: [ln["key"] for ln in lines if ln["section"] == section
                                         and (group is None or ln["group"] == group)]
    tot = {}
    for name, src in (("actual", act), ("budget", bud)):
        rev = total(keys("revenue"), src)
        cogs = total(keys("cogs"), src)
        opex = total(keys("opex"), src)
        da = total(keys("da"), src)
        gross = [rev[i] - cogs[i] for i in range(12)]
        ebitda = [gross[i] - opex[i] for i in range(12)]
        ebit = [ebitda[i] - da[i] for i in range(12)]
        tot[name] = {"revenue": rev, "cogs": cogs, "gross": gross, "opex": opex,
                     "ebitda": ebitda, "da": da, "ebit": ebit,
                     "rev_project": total(keys("revenue", "project"), src),
                     "rev_saas": total(keys("revenue", "saas"), src),
                     "cogs_project": total(keys("cogs", "project"), src),
                     "cogs_saas": total(keys("cogs", "saas"), src)}
    ytd = lambda arr: sum(arr[:T])
    full = lambda arr: sum(arr)
    rate = st["tax_rate"]

    def closing(name, span):
        t = tot[name]
        ebit = span(t["ebit"])
        tax = max(0.0, ebit) * rate
        return {"revenue": span(t["revenue"]), "cogs": span(t["cogs"]), "gross": span(t["gross"]),
                "opex": span(t["opex"]), "ebitda": span(t["ebitda"]), "da": span(t["da"]),
                "ebit": ebit, "tax": tax, "net": ebit - tax,
                "rev_project": span(t["rev_project"]), "rev_saas": span(t["rev_saas"]),
                "cogs_project": span(t["cogs_project"]), "cogs_saas": span(t["cogs_saas"])}

    A_ytd, B_ytd, B_full = closing("actual", ytd), closing("budget", ytd), closing("budget", full)
    A_full = closing("actual", full)
    rnd = lambda arr: [round(x, 2) for x in arr]
    pnl_lines = [dict(ln, actual=rnd(act[ln["key"]]), budget=rnd(bud[ln["key"]]),
                      actual_ytd=round(ytd(act[ln["key"]]), 2), budget_ytd=round(ytd(bud[ln["key"]]), 2),
                      budget_full=round(full(bud[ln["key"]]), 2),
                      accounts=sorted(accounts_on[ln["key"]].items()))
                 for ln in lines]
    pnl_totals = {name: {k: rnd(v) for k, v in t.items()} for name, t in tot.items()}

    # ---- cash flow tracker ---------------------------------------------------
    opening = float(st["opening_cash"] or 0)
    label_of = {ln["key"]: ln["label"] for ln in lines}
    pname = {x["id"]: "%s — %s" % (x["code"], x["name"]) for x in projects}
    cash_rows, bal = [], opening
    months_cf = [{"month": "%d-%02d" % (year, m), "in": 0.0, "out": 0.0} for m in range(1, 13)]
    for r in ledger:
        if r.get("line") in (None, "da"):          # depreciation is not cash
            continue
        amt = ((r["credit"] or 0) - (r["debit"] or 0)) if r["type"] == "revenue" \
            else -((r["debit"] or 0) - (r["credit"] or 0))
        if not amt:
            continue
        m = int(r["date"][5:7])
        bal += amt
        slot = months_cf[m - 1]
        if amt > 0:
            slot["in"] += amt
        else:
            slot["out"] += -amt
        cash_rows.append({
            "date": r["date"], "entry_id": r["entry_id"], "entry_no": r["entry_no"],
            "description": r["description"] or "", "account": "%s %s" % (r["code"], r["name"]),
            "line": label_of.get(r["line"], ""), "section": LINE_BY_KEY[r["line"]][1],
            "category": pname.get(r["project_id"], ""),
            "kind": kind_of.get(r["project_id"], "project"),
            "type": "Cash In" if amt > 0 else "Cash Out",
            "cash_in": round(amt, 2) if amt > 0 else 0.0,
            "cash_out": round(amt, 2) if amt < 0 else 0.0,
            "balance": round(bal, 2), "closed": m <= T})
    run = opening
    for s in months_cf:
        s["net"] = round(s["in"] - s["out"], 2)
        run += s["net"]
        s["ending"] = round(run, 2)
        s["in"], s["out"] = round(s["in"], 2), round(s["out"], 2)
    in_ytd = sum(s["in"] for s in months_cf[:T])
    out_ytd = sum(s["out"] for s in months_cf[:T])
    cash_position = opening + in_ytd - out_ytd
    burn = max(0.0, (out_ytd - in_ytd) / T) if T else 0.0
    gross_burn = out_ytd / T if T else 0.0

    # ---- project tracker -----------------------------------------------------
    mt = _money_tracker(conn, pids)
    per = {x["id"]: {"budget": {b[0]: 0.0 for b in TRACK_BUCKETS},
                     "actual": {b[0]: 0.0 for b in TRACK_BUCKETS}, "revenue": 0.0}
           for x in projects}
    for r in ledger:
        if int(r["date"][5:7]) > T:
            continue
        slot = per[r["project_id"]]
        if r["type"] == "revenue":
            slot["revenue"] += (r["credit"] or 0) - (r["debit"] or 0)
        elif r.get("line") != "da":
            slot["actual"][_bucket(r["code"])] += (r["debit"] or 0) - (r["credit"] or 0)
    for b in budgets:
        if b["type"] == "expense":
            per[b["project_id"]]["budget"][_bucket(b["code"])] += b["amount"] or 0
    status_map = {"active": "In Progress", "completed": "Completed ✅", "on_hold": "On Hold"}
    tracker = []
    for x in projects:
        mm = meta[str(x["id"])]
        slot = per[x["id"]]
        cost = sum(slot["actual"].values())
        contract = mm.get("contract_value")
        contract_src = "entered" if contract is not None else "project"
        if contract is None:
            contract = x["contract_value"] or 0.0
        invoiced = mm.get("invoiced")
        inv_src = "entered"
        if invoiced is None:
            if x["id"] in mt:
                invoiced, inv_src = mt[x["id"]]["amount"], "money tracker"
            else:
                invoiced, inv_src = slot["revenue"], "ledger"
        paid = mm.get("paid")
        paid_src = "entered" if paid is not None else "ledger"
        if paid is None:
            paid = slot["revenue"]
        if contract:
            gm = (contract - cost) / contract
        else:
            gm = _div(slot["revenue"] - cost, slot["revenue"])
        tracker.append({
            "project_id": x["id"], "code": x["code"], "name": x["name"],
            "company_code": x["company_code"], "kind": mm.get("kind", "project"),
            "client": mm.get("client") or (mt.get(x["id"], {}).get("client") or ""),
            "start": x["start_date"], "end": x["end_date"],
            "contract_value": round(contract, 2), "contract_source": contract_src,
            "budget": {k: round(v, 2) for k, v in slot["budget"].items()},
            "actual": {k: round(v, 2) for k, v in slot["actual"].items()},
            "budget_total": round(sum(slot["budget"].values()), 2), "actual_total": round(cost, 2),
            "revenue": round(slot["revenue"], 2), "gross_margin": _r(gm, 4),
            "invoiced": round(invoiced, 2), "invoiced_source": inv_src,
            "paid": round(paid, 2), "paid_source": paid_src,
            "outstanding": round(max(0.0, invoiced - paid), 2),
            "status": mm.get("status") or status_map.get(x["status"], x["status"] or ""),
            "risk": mm.get("risk") or "", "note": mm.get("note") or ""})
    track_sum = {
        "pipeline": round(sum(t["contract_value"] for t in tracker), 2),
        "invoiced": round(sum(t["invoiced"] for t in tracker), 2),
        "paid": round(sum(t["paid"] for t in tracker), 2)}
    track_sum["outstanding"] = round(sum(t["outstanding"] for t in tracker), 2)

    # ---- SaaS performance ----------------------------------------------------
    sm = st["saas_months"]
    saas_rows, start_c = [], int(st["opening_customers"] or 0)
    prev_mrr = None
    for i in range(12):
        key = "%d-%02d" % (year, i + 1)
        row = sm.get(key, {})
        new, churned = int(row.get("new") or 0), int(row.get("churned") or 0)
        end_c = max(0, start_c + new - churned)
        mrr_b = row.get("mrr_budget")
        mrr_b_src = "entered" if mrr_b is not None else "budget"
        if mrr_b is None:
            mrr_b = tot["budget"]["rev_saas"][i]
        mrr_a = row.get("mrr_actual")
        mrr_a_src = "entered" if mrr_a is not None else "ledger"
        if mrr_a is None:
            mrr_a = tot["actual"]["rev_saas"][i] if i < T else None
        churn = (churned / start_c) if start_c else 0.0
        growth = _div((mrr_a - prev_mrr), prev_mrr) if (mrr_a is not None and prev_mrr) else None
        arpu = _div(mrr_a, end_c) if mrr_a is not None else None
        ltv = (arpu / (churn or st["ltv_churn"])) if arpu is not None else None
        cac_spend = row.get("cac")
        cac = _div(cac_spend, new) if cac_spend is not None else None
        saas_rows.append({
            "month": key, "closed": i < T, "start": start_c, "new": new, "churned": churned,
            "end": end_c, "mrr_budget": _r(mrr_b), "mrr_budget_source": mrr_b_src,
            "mrr_actual": _r(mrr_a), "mrr_actual_source": mrr_a_src,
            "arr": _r(mrr_a * 12) if mrr_a is not None else None,
            "variance": _r(mrr_a - mrr_b) if mrr_a is not None else None,
            "achievement": _r(_div(mrr_a, mrr_b), 4) if mrr_a is not None else None,
            "churn": _r(churn, 4), "growth": _r(growth, 4), "arpu": _r(arpu), "ltv": _r(ltv),
            "cac_spend": cac_spend, "cac": _r(cac), "ltv_cac": _r(_div(ltv, cac), 2) if ltv and cac else None})
        start_c = end_c
        if mrr_a is not None:
            prev_mrr = mrr_a
    cur = saas_rows[T - 1] if T else None
    q0 = ((T - 1) // 3) * 3 if T else 0
    q_rows = saas_rows[q0:T] if T else []
    q_start = q_rows[0]["start"] if q_rows else 0
    q_churned = sum(r["churned"] for r in q_rows)
    new_ytd = sum(r["new"] for r in saas_rows[:T])
    cac_ytd = sum(r["cac_spend"] or 0 for r in saas_rows[:T])
    saas_tiles = {
        "arr": cur["arr"] if cur else None, "mrr": cur["mrr_actual"] if cur else None,
        "customers": cur["end"] if cur else int(st["opening_customers"] or 0),
        "churn_quarter": _r(_div(q_churned, q_start), 4) if q_start else 0.0,
        "quarter": "Q%d" % ((T - 1) // 3 + 1) if T else "",
        "arpu": cur["arpu"] if cur else None}

    # ---- health indicators ---------------------------------------------------
    days = (datetime.date(year, T, calendar.monthrange(year, T)[1]) - datetime.date(year, 1, 1)).days + 1 if T else 0
    as_of = "%d-%02d-%02d" % (year, T, calendar.monthrange(year, T)[1]) if T else "%d-01-01" % year
    ltv_now = cur["ltv"] if cur else None
    cac_now = _div(cac_ytd, new_ytd) if new_ytd and cac_ytd else None
    prev = saas_rows[T - 2] if T >= 2 else None
    computed = {
        "runway": (None if burn <= 0 else (0.0 if cash_position <= 0 else cash_position / burn)),
        "current_ratio": _current_ratio(conn, p["company_id"], as_of),
        "cash_vs_burn": _div(cash_position, gross_burn) if gross_burn else None,
        "outstanding": track_sum["outstanding"],
        "cash_position": cash_position,
        "gross_margin": _div(A_ytd["gross"], A_ytd["revenue"]),
        "net_margin": _div(A_ytd["net"], A_ytd["revenue"]),
        "ebitda_margin": _div(A_ytd["ebitda"], A_ytd["revenue"]),
        "project_gm": _div(A_ytd["rev_project"] - A_ytd["cogs_project"], A_ytd["rev_project"]),
        "mrr": (cur["mrr_actual"] or 0.0) if cur else None,
        "mrr_growth": cur["growth"] if cur else None,
        "churn": cur["churn"] if cur else None,
        "ltv_cac": _div(ltv_now, cac_now) if ltv_now and cac_now else None,
        "nrr": None,
        "pipeline": track_sum["pipeline"],
        "burn_rate": burn,
        "dso": (track_sum["outstanding"] * days / A_ytd["revenue"]) if A_ytd["revenue"] > 0 and days else None,
        "rev_per_employee": _div(A_ytd["revenue"], st["headcount"]) if st["headcount"] else None,
    }
    biggest = max(tracker, key=lambda t: t["outstanding"]) if tracker else None
    auto_note = {
        "runway": ("No net burn: money in covers money out." if burn <= 0 else
                   "Cash of Rp %s at a net burn of Rp %s a month." % (_n(cash_position), _n(burn))),
        "current_ratio": "Company level (%s), current assets over current liabilities at %s." % (
            _company_code(conn, p["company_id"]), as_of),
        "cash_vs_burn": "Cash position over the average monthly cash out (Rp %s)." % _n(gross_burn),
        "outstanding": ("Largest: %s — Rp %s." % (biggest["code"], _n(biggest["outstanding"]))
                        if biggest and biggest["outstanding"] else "Nothing outstanding."),
        "cash_position": "Opening Rp %s + in Rp %s − out Rp %s." % (_n(opening), _n(in_ytd), _n(out_ytd)),
        "gross_margin": "Revenue Rp %s, cost of sales Rp %s (YTD)." % (_n(A_ytd["revenue"]), _n(A_ytd["cogs"])),
        "net_margin": "Net profit Rp %s after operating cost, depreciation and tax." % _n(A_ytd["net"]),
        "ebitda_margin": "EBITDA Rp %s." % _n(A_ytd["ebitda"]),
        "project_gm": "Project revenue Rp %s, project cost of sales Rp %s." % (
            _n(A_ytd["rev_project"]), _n(A_ytd["cogs_project"])),
        "mrr": "Recurring revenue in %s." % (MONTHS_ID[T - 1] if T else "-"),
        "mrr_growth": "Month on month, %s against %s." % (
            MONTHS_ID[T - 1] if T else "-", MONTHS_ID[T - 2] if T >= 2 else "-"),
        "churn": "Customers lost over customers at the start of the month.",
        "ltv_cac": "LTV (ARPU over churn, %s%% when nobody churned) over CAC from acquisition spend."
                   % _n(st["ltv_churn"] * 100),
        "nrr": "Needs expansion and renewal data — enter the value by hand.",
        "pipeline": "Total contract value of the %d linked project(s)." % len(tracker),
        "burn_rate": "Average monthly cash out less cash in, YTD.",
        "dso": "Outstanding invoices over YTD revenue, in days.",
        "rev_per_employee": ("YTD revenue over %d people." % st["headcount"]) if st["headcount"]
                            else "Set the headcount in Report settings.",
    }
    indicators = []
    for key, group, label, unit, direction, d_safe, d_att in INDICATORS:
        ov = st["indicators"].get(key, {})
        safe = ov.get("safe", d_safe)
        att = ov.get("attention", d_att)
        entered = "actual" in ov
        value = ov["actual"] if entered else computed.get(key)
        stt = _status(value, direction, safe, att)
        note = ov.get("note") or ""
        no_burn = key == "runway" and value is None and not entered and burn <= 0
        if no_burn:
            stt = "safe"                 # nothing is burning: the runway is open-ended
        if value is None and not note and not no_burn:
            note = "Not measurable yet. " + auto_note.get(key, "")
        indicators.append({
            "key": key, "group": group, "label": label, "unit": unit, "direction": direction,
            "value": _r(value, 4), "source": "entered" if entered else "computed",
            "safe": safe, "attention": att, "status": stt,
            "note": note or auto_note.get(key, ""), "auto_note": auto_note.get(key, ""),
            "on_dashboard": key in DASHBOARD_INDICATORS})
    ind = {i["key"]: i for i in indicators}

    actions = list(st["actions"])
    suggested = []
    if not actions:
        for i in indicators:
            if i["status"] == "critical" and i["value"] is not None:
                suggested.append({"urgency": "now", "text": "%s — %s" % (i["label"], i["note"])})

    # ---- dashboard tiles -----------------------------------------------------
    active = sum(1 for t in tracker if "hold" not in t["status"].lower())
    tiles = [
        {"key": "revenue_ytd", "label": "TOTAL REVENUE YTD", "value": A_ytd["revenue"], "unit": "rp",
         "sub": "Budget YTD: %s  |  %s–%s %d" % (_n(B_ytd["revenue"]), MONTHS_ID[0], MONTHS_ID[T - 1] if T else "-", year)},
        {"key": "mrr", "label": "MRR %s" % (st["title"] or p["name"]).upper(), "value": computed["mrr"] or 0.0,
         "unit": "rp", "sub": "ARR %s" % _n((computed["mrr"] or 0) * 12)},
        {"key": "cash", "label": "POSISI KAS (Est.)", "value": cash_position, "unit": "rp",
         "sub": "Opening Jan: %s  |  %s %d" % (_n(opening), MONTHS_ID[T - 1] if T else "-", year)},
        {"key": "runway", "label": "RUNWAY (ESTIMASI)", "value": ind["runway"]["value"], "unit": "months",
         "sub": "Burn rate  |  %s/bln" % _short(burn)},
        {"key": "gross_margin", "label": "GROSS MARGIN YTD", "value": ind["gross_margin"]["value"], "unit": "pct",
         "sub": "Target: %s" % _pct(ind["gross_margin"]["safe"])},
        {"key": "project_revenue", "label": "PROJECT REVENUE YTD", "value": A_ytd["rev_project"], "unit": "rp",
         "sub": "%d Proyek aktif/selesai  |  Pipeline: %s" % (active, _n(track_sum["pipeline"]))},
        {"key": "outstanding", "label": "OUTSTANDING INVOICE", "value": track_sum["outstanding"], "unit": "rp",
         "sub": ("%s  |  %s" % (biggest["name"][:40], biggest["client"][:30] or biggest["code"]))
                if biggest and biggest["outstanding"] else "Nothing outstanding"},
        {"key": "mrr_growth", "label": "MRR GROWTH (MoM)", "value": ind["mrr_growth"]["value"], "unit": "pct",
         "sub": "Target %s  |  Tren: %s" % (_pct(ind["mrr_growth"]["safe"]),
                                              "—" if ind["mrr_growth"]["value"] is None
                                              else ("▲" if ind["mrr_growth"]["value"] > 0 else "▼" if ind["mrr_growth"]["value"] < 0 else "▬"))},
    ]
    for t in tiles:
        t["value"] = _r(t["value"], 4)
        t["status"] = ind[t["key"]]["status"] if t["key"] in ind else None

    return {
        "product": {"id": p["id"], "name": p["name"], "code": p["code"], "company_id": p["company_id"]},
        "title": st["title"] or p["name"], "subtitle": st["subtitle"],
        "year": year, "through": T, "through_label": ("%s %d" % (MONTHS_ID[T - 1], year)) if T else "",
        "quarter": ("Q%d %d" % ((T - 1) // 3 + 1, year)) if T else "",
        "generated": today.isoformat(), "settings": st, "months": list(MONTHS_ID),
        "projects": projects, "tiles": tiles,
        "pnl": {"lines": pnl_lines, "totals": pnl_totals,
                "ytd": {"actual": _rd(A_ytd), "budget": _rd(B_ytd)},
                "full": {"budget": _rd(B_full), "actual": _rd(A_full)}, "tax_rate": rate},
        "cash": {"opening": opening, "rows": cash_rows, "months": months_cf,
                 "in_ytd": round(in_ytd, 2), "out_ytd": round(out_ytd, 2), "net_ytd": round(in_ytd - out_ytd, 2),
                 "position": round(cash_position, 2), "burn": round(burn, 2), "gross_burn": round(gross_burn, 2)},
        "tracker": {"rows": tracker, "summary": track_sum,
                    "buckets": [{"key": k, "label": l} for k, l, _ in TRACK_BUCKETS]},
        "indicators": indicators, "groups": [{"key": k, "label": l} for k, l in IND_GROUPS],
        "dashboard_indicators": [ind[k] for k in DASHBOARD_INDICATORS],
        "actions": actions, "suggested_actions": suggested,
        "urgencies": [{"key": k, "label": l} for k, l in URGENCIES],
        "saas": {"rows": saas_rows, "tiles": saas_tiles, "ltv_churn": st["ltv_churn"]},
    }


def _rd(d):
    return {k: round(v, 2) for k, v in d.items()}


def _company_code(conn, cid):
    r = conn.execute("SELECT code FROM companies WHERE id=?", (cid,)).fetchone()
    return r[0] if r else "?"


def _n(v):
    return "{:,.0f}".format(v or 0).replace(",", ".")


def _short(v):
    v = v or 0
    if abs(v) >= 1e9:
        return ("%.2f M" % (v / 1e9)).replace(".", ",")
    if abs(v) >= 1e6:
        return ("%.2f jt" % (v / 1e6)).replace(".", ",")
    return _n(v)


def _pct(v):
    return "—" if v is None else ("%.2f%%" % (v * 100)).replace(".", ",")
