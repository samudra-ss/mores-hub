"""Product Finance Analysis — does this product earn the company real money, and by when?

A product is judged the way the NX portfolio workbook judges NX-01: months that
have happened come from the ledger, months that have not come from drivers, and
the two are shown side by side so nobody mistakes a forecast for a fact.

  actual months    posted journal lines tagged to the product's projects,
                   grouped into cost categories by account code
  forecast months  cost lines (fixed or per working day, with start/end and
                   escalation), a SaaS user model (acquisition, churn, ARPU),
                   a server-cost model that grows with active users, one-offs,
                   and a CAPEX register (cash when bought, depreciation after)

Two views are kept apart on purpose. PROFIT includes depreciation and excludes
CAPEX. CASH includes CAPEX when it is paid and excludes depreciation. A product
can be profitable on paper while still burning cash, and the workbook's whole
point is that the second number is the one that runs out.

Pure functions over a context dict, no Flask. load_context() is the only thing
that touches the database, so the solvers can re-run the model hundreds of times
without querying anything.
"""
import calendar
import datetime
import json
import math

CATEGORIES = ("people", "server", "marketing", "tools", "office", "other")
CATEGORY_LABELS = {
    "people": "People (salary & direct labour)",
    "server": "Server, API & infrastructure",
    "marketing": "Marketing",
    "tools": "Tools & subscriptions",
    "office": "Office & running costs",
    "other": "Other",
}

# Account code -> category. Longest matching prefix wins; an exact code in the
# product's own category_map overrides all of this.
DEFAULT_CATEGORY_MAP = (
    ("5100-01", "people"), ("5100-02", "server"), ("5100-03", "other"),
    ("5100-04", "other"), ("6100", "people"), ("6200", "office"), ("6300", "office"),
    ("6400", "marketing"), ("6500", "noncash"), ("6620", "office"), ("6630", "office"),
    ("66", "office"), ("67", "other"), ("69", "other"), ("72", "other"), ("73", "other"),
    ("5", "other"), ("6", "office"),
)

DEFAULT_ASSUMPTIONS = {
    "arpu": 0.0,                   # revenue per active user per month
    "arpu_growth_annual": 0.0,     # price rise per year
    "revenue_start_month": None,   # first month of subscription revenue; default launch
    "start_users": 0.0,            # users already on board in the first revenue month
    "new_users_first": 0.0,        # acquisitions in the first revenue month
    "new_users_growth": 0.0,       # month-on-month growth of acquisitions
    "churn_monthly": 0.0,          # share of the opening base lost each month
    "server_base": 0.0,            # infrastructure that runs whether anyone logs in or not
    "server_per_user": 0.0,        # variable infrastructure per active user
    "server_step_users": 0,        # every N active users another tier is needed...
    "server_step_cost": 0.0,       # ...at this monthly cost
    "category_map": {},            # {account_code: category} overrides for actuals
}

# The verdict judges the TARGET MONTH's run-rate, not the full year. A product
# can make money every month from September and still lose heavily over the
# year, so the label says "run-rate" out loud and the year's result sits next
# to it on screen.
VERDICT_TEXT = {
    "PROFITABLE": "Making money month by month by the target, and every rupiah spent getting there is back",
    "PROFITABLE_NOT_PAID_BACK": "Making money month by month by the target, but the cash spent getting there is not back yet",
    "NOT_PROFITABLE": "Still losing money in the target month",
    "NO_DATA": "Nothing to judge yet: no ledger actuals and no forecast drivers",
}


# ---------------------------------------------------------------- months ----

def ym(d):
    return "%04d-%02d" % (d.year, d.month)


def ym_add(m, n):
    total = int(m[:4]) * 12 + int(m[5:7]) - 1 + n
    return "%04d-%02d" % (total // 12, total % 12 + 1)


def ym_range(a, b):
    out, x = [], a
    while x <= b:
        out.append(x)
        x = ym_add(x, 1)
    return out


def months_between(a, b):
    """Whole months from a to b (b - a)."""
    return (int(b[:4]) * 12 + int(b[5:7])) - (int(a[:4]) * 12 + int(a[5:7]))


def working_days(m):
    y, mo = int(m[:4]), int(m[5:7])
    return sum(1 for d in range(1, calendar.monthrange(y, mo)[1] + 1)
               if datetime.date(y, mo, d).weekday() < 5)


def _f(x, default=0.0):
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _valid_ym(s):
    s = (s or "").strip()[:7]
    try:
        datetime.date(int(s[:4]), int(s[5:7]), 1)
        return s if len(s) == 7 and s[4] == "-" else None
    except (ValueError, IndexError):
        return None


def category_of(code, overrides=None):
    code = str(code or "")
    if overrides and code in overrides:
        return overrides[code]
    best, best_len = "other", -1
    for prefix, cat in DEFAULT_CATEGORY_MAP:
        if code.startswith(prefix) and len(prefix) > best_len:
            best, best_len = cat, len(prefix)
    return best


# --------------------------------------------------------------- context ----

def merged_assumptions(raw):
    a = dict(DEFAULT_ASSUMPTIONS)
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "{}")
        except ValueError:
            raw = {}
    for k, v in (raw or {}).items():
        if k in a and v is not None:
            a[k] = v
    return a


def ledger_actuals(conn, project_ids, company_ids, start, end, overrides=None):
    """Posted ledger lines tagged to these projects, by month and category.

    Filtered by PROJECT, not by the company the entry was booked in: NX-01 is an
    SBR-NX project whose costs are booked in MDA's books, and a product view that
    only looked inside its own company would show it costing nothing. Booking
    company still has to be one the user may see.
    """
    out, last = {}, None
    if not project_ids or not company_ids:
        return out, last
    rows = conn.execute(
        "SELECT substr(je.date,1,7) AS m, a.code AS code, a.type AS type, MIN(a.name) AS name,"
        " COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c"
        " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
        " JOIN accounts a ON a.id = jl.account_id"
        " WHERE je.status='posted' AND jl.project_id IN (%s) AND je.company_id IN (%s)"
        " AND je.date >= ? AND je.date <= ?"
        " GROUP BY m, a.code, a.type"
        % (",".join("?" * len(project_ids)), ",".join("?" * len(company_ids))),
        list(project_ids) + list(company_ids) + [start + "-01", end + "-31"]).fetchall()
    for r in rows:
        bucket = out.setdefault(r["m"], {"revenue": 0.0, "noncash": 0.0, "accounts": {},
                                         "costs": {c: 0.0 for c in CATEGORIES}})
        if r["type"] == "revenue":
            bucket["revenue"] += (r["c"] or 0) - (r["d"] or 0)
        elif r["type"] == "expense":
            cat = category_of(r["code"], overrides)
            amount = (r["d"] or 0) - (r["c"] or 0)
            if cat == "noncash":
                bucket["noncash"] += amount
            else:
                cat = cat if cat in CATEGORIES else "other"
                bucket["costs"][cat] += amount
                acc = bucket["accounts"].setdefault(r["code"], {
                    "code": r["code"], "name": r["name"] or r["code"], "category": cat, "amount": 0.0})
                acc["amount"] += amount
        else:
            continue
        if last is None or r["m"] > last:
            last = r["m"]
    return out, last


def load_context(conn, product_id, company_ids, today=None):
    p = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    if not p:
        raise ValueError("SBU not found")
    p = dict(p)
    today = today or datetime.date.today()
    a = merged_assumptions(p.get("assumptions"))
    lines = [dict(r) for r in conn.execute(
        "SELECT * FROM product_cost_lines WHERE product_id=? ORDER BY sort, id", (product_id,))]
    oneoffs = [dict(r) for r in conn.execute(
        "SELECT * FROM product_oneoffs WHERE product_id=? ORDER BY month, id", (product_id,))]
    capex = [dict(r) for r in conn.execute(
        "SELECT * FROM product_capex WHERE product_id=? ORDER BY month, id", (product_id,))]
    project_ids = [r[0] for r in conn.execute(
        "SELECT project_id FROM product_projects WHERE product_id=?", (product_id,))]

    target_year = int(p.get("target_year") or (today.year + 1))
    horizon_end = _valid_ym(p.get("horizon_end")) or "%d-12" % target_year
    launch = _valid_ym(p.get("launch_month")) or ym(today)
    starts = [launch, "%d-01" % today.year]
    starts += [_valid_ym(l.get("start_month")) for l in lines]
    starts += [_valid_ym(o.get("month")) for o in oneoffs] + [_valid_ym(c.get("month")) for c in capex]
    start = min(s for s in starts if s)
    # the ledger may reach further back than any driver
    probe, last_probe = ledger_actuals(conn, project_ids, company_ids, "2000-01", horizon_end,
                                       a.get("category_map") or {})
    if probe:
        start = min(start, min(probe))
    actuals, last_ledger = probe, last_probe

    current = ym(today)
    stated = _valid_ym(p.get("actual_through"))
    # With no ledger behind it, NOTHING is actual - every month is plan. Treating
    # past calendar months as actual would show them costing zero, which reads as
    # a fact and is not one.
    actual_through = stated or last_ledger or ym_add(start, -1)
    # a month that has not finished cannot be an actual, whatever anyone typed
    actual_through = min(actual_through, ym_add(current, -1))

    return {
        "product": p, "assumptions": a, "lines": lines, "oneoffs": oneoffs, "capex": capex,
        "project_ids": project_ids, "company_ids": list(company_ids), "actuals": actuals,
        "last_ledger_month": last_ledger, "actual_through": actual_through,
        "actual_through_source": "stated" if stated else ("ledger" if last_ledger else "calendar"),
        "start": start, "end": max(horizon_end, start), "launch": launch,
        "target_year": target_year, "today": today.isoformat(),
    }


# -------------------------------------------------------------- the model ---

def _line_amount(line, m, first_forecast):
    s, e = _valid_ym(line.get("start_month")), _valid_ym(line.get("end_month"))
    if (s and m < s) or (e and m > e):
        return 0.0
    base = _f(line.get("monthly_amount"))
    if (line.get("basis") or "fixed") == "per_working_day":
        base *= working_days(m)
    esc = _f(line.get("escalation_annual"))
    if esc:
        since = months_between(max(s or first_forecast, first_forecast), m)
        base *= (1 + esc) ** (max(0, since) / 12.0)
    return base


def _capex_schedule(capex, months):
    outlay = {m: 0.0 for m in months}
    dep = {m: 0.0 for m in months}
    for c in capex:
        m0 = _valid_ym(c.get("month"))
        amt = _f(c.get("amount"))
        if not m0 or amt <= 0:
            continue
        if m0 in outlay:
            outlay[m0] += amt
        life = max(1, int(_f(c.get("life_months"), 48)))
        per = amt / life
        # straight line from the month after purchase, for exactly `life` months
        for i in range(1, life + 1):
            mm = ym_add(m0, i)
            if mm in dep:
                dep[mm] += per
    return outlay, dep


def simulate(ctx, override=None):
    a = dict(ctx["assumptions"])
    if override:
        a.update(override)
    months = ym_range(ctx["start"], ctx["end"])
    through = ctx["actual_through"]
    first_forecast = ym_add(through, 1)
    rev_start = _valid_ym(a.get("revenue_start_month")) or ctx["launch"]
    churn = min(max(_f(a.get("churn_monthly")), 0.0), 1.0)
    growth = _f(a.get("new_users_growth"))
    arpu0 = _f(a.get("arpu"))
    arpu_g = _f(a.get("arpu_growth_annual"))
    step_users = int(_f(a.get("server_step_users")))
    step_cost = _f(a.get("server_step_cost"))

    oneoff_in, oneoff_out, ignored_oneoffs = {}, {}, []
    for o in ctx["oneoffs"]:
        m = _valid_ym(o.get("month"))
        if not m:
            continue
        if m <= through:
            ignored_oneoffs.append(o)       # the ledger already says what happened
            continue
        book = oneoff_in if o.get("flow") == "in" else oneoff_out
        book[m] = book.get(m, 0.0) + _f(o.get("amount"))
    capex_out, capex_dep = _capex_schedule(ctx["capex"], months)

    rows = []
    begin = new = 0.0
    end_prev = 0.0   # carried unrounded - rounding the base every month compounds
    cum_profit = cum_cash = 0.0
    for m in months:
        actual = m <= through
        wd = working_days(m)

        # ---- users: a model, in every month from the first revenue month ----
        if m < rev_start:
            begin = new = churned = end = 0.0
        elif m == rev_start:
            begin = _f(a.get("start_users"))
            new = _f(a.get("new_users_first"))
            churned = begin * churn
            end = begin + new - churned
        else:
            begin = end_prev
            new = new * (1 + growth)
            churned = begin * churn
            end = begin + new - churned
        end = max(0.0, end)
        end_prev = end
        arpu = arpu0 * (1 + arpu_g) ** (max(0, months_between(rev_start, m)) / 12.0) if m >= rev_start else 0.0
        mrr = end * arpu

        # ---- server model (always computed, only charged in forecast months) ----
        server_model = _f(a.get("server_base")) + _f(a.get("server_per_user")) * end
        if step_users > 0 and step_cost:
            server_model += step_cost * math.floor(end / step_users)

        costs = {c: 0.0 for c in CATEGORIES}
        if actual:
            led = ctx["actuals"].get(m)
            revenue = led["revenue"] if led else 0.0
            if led:
                for c in CATEGORIES:
                    costs[c] = led["costs"].get(c, 0.0)
            # booked depreciation wins; the register fills the gap if nothing was booked
            depreciation = (led["noncash"] if led and led["noncash"] else capex_dep.get(m, 0.0))
        else:
            revenue = mrr + oneoff_in.get(m, 0.0)
            for line in ctx["lines"]:
                cat = line.get("category") if line.get("category") in CATEGORIES else "other"
                costs[cat] += _line_amount(line, m, first_forecast)
            costs["server"] += server_model
            costs["other"] += oneoff_out.get(m, 0.0)
            depreciation = capex_dep.get(m, 0.0)

        opex = sum(costs.values())
        capex_cash = capex_out.get(m, 0.0)
        profit = revenue - opex - depreciation
        net_cash = revenue - opex - capex_cash
        cum_profit += profit
        cum_cash += net_cash

        gm = (revenue - costs["server"]) / revenue if revenue > 0 else None
        cac = costs["marketing"] / new if new > 0 else None
        ltv = (arpu * gm / churn) if (churn > 0 and gm is not None and gm > 0 and arpu > 0) else None
        rows.append({
            "month": m, "phase": "actual" if actual else "forecast", "working_days": wd,
            "users_begin": round(begin, 2), "users_new": round(new, 2),
            "users_churned": round(churned, 2), "users_end": round(end, 2),
            "arpu": round(arpu, 2), "mrr": round(mrr, 2), "arr": round(mrr * 12, 2),
            "revenue": round(revenue, 2),
            "costs": {c: round(v, 2) for c, v in costs.items()},
            "server_model": round(server_model, 2),
            "opex": round(opex, 2), "depreciation": round(depreciation, 2),
            "capex": round(capex_cash, 2),
            "profit": round(profit, 2), "net_cash": round(net_cash, 2),
            "cum_profit": round(cum_profit, 2), "cum_cash": round(cum_cash, 2),
            "gross_margin": None if gm is None else round(gm, 4),
            "cac": None if cac is None else round(cac, 2),
            "ltv": None if ltv is None else round(ltv, 2),
            "ltv_cac": None if (ltv is None or not cac) else round(ltv / cac, 2),
            "cac_payback_months": (None if (cac is None or gm is None or gm <= 0 or arpu <= 0)
                                   else round(cac / (arpu * gm), 1)),
            "gross_burn": round(opex + capex_cash, 2),
            "net_burn": round(max(0.0, -net_cash), 2),
        })
    return {"months": rows, "rev_start": rev_start, "first_forecast": first_forecast,
            "ignored_oneoffs": ignored_oneoffs}


# ------------------------------------------------------------- summaries ----

def summarise(ctx, sim):
    rows = sim["months"]
    p = ctx["product"]
    target_m = "%d-12" % ctx["target_year"]
    by_m = {r["month"]: r for r in rows}

    years = {}
    for r in rows:
        y = years.setdefault(r["month"][:4], {
            "revenue": 0.0, "opex": 0.0, "depreciation": 0.0, "capex": 0.0,
            "profit": 0.0, "net_cash": 0.0, "actual_months": 0, "forecast_months": 0,
            "costs": {c: 0.0 for c in CATEGORIES}})
        for k in ("revenue", "opex", "depreciation", "capex", "profit", "net_cash"):
            y[k] += r[k]
        for c in CATEGORIES:
            y["costs"][c] += r["costs"][c]
        y["actual_months" if r["phase"] == "actual" else "forecast_months"] += 1
    for y in years.values():
        for k in ("revenue", "opex", "depreciation", "capex", "profit", "net_cash"):
            y[k] = round(y[k], 2)
        y["costs"] = {c: round(v, 2) for c, v in y["costs"].items()}
        y["margin"] = round(y["profit"] / y["revenue"], 4) if y["revenue"] else None

    # The realized part of each year by ACCOUNT - what actually left the bank for
    # this SBU, broken down the way the dashboard breaks down operating expense.
    for yk, y in years.items():
        accts = {}
        for m, led in ctx["actuals"].items():
            if m[:4] != yk or m > ctx["actual_through"]:
                continue
            for code, acc in led.get("accounts", {}).items():
                tot = accts.setdefault(code, dict(acc, amount=0.0))
                tot["amount"] += acc["amount"]
        y["actual_accounts"] = sorted(
            (dict(acc, amount=round(acc["amount"], 2)) for acc in accts.values()
             if abs(acc["amount"]) > 0.005),
            key=lambda acc: -acc["amount"])
        y["actual_opex"] = round(sum(r["opex"] for r in rows
                                     if r["month"][:4] == yk and r["phase"] == "actual"), 2)
        y["forecast_opex"] = round(sum(r["opex"] for r in rows
                                       if r["month"][:4] == yk and r["phase"] == "forecast"), 2)

    after_launch = [r for r in rows if r["month"] >= sim["rev_start"]]
    first_profit = next((r["month"] for r in after_launch if r["profit"] >= 0), None)
    # break-even means STAYING there: the first month from which no later month loses money
    sustained = None
    for i, r in enumerate(after_launch):
        if r["profit"] >= 0 and all(x["profit"] >= 0 for x in after_launch[i:]):
            sustained = r["month"]
            break
    # Paid back means cumulative cash turns non-negative AND STAYS there. A large
    # one-off receipt can lift it above zero for a while - NX-01's Mar-26 termin
    # did - with the real hole still ahead; calling that "payback" would
    # contradict the funding-required figure on the same screen.
    negs = [i for i, r in enumerate(rows) if r["cum_cash"] < 0]
    payback = rows[negs[-1] + 1]["month"] if negs and negs[-1] + 1 < len(rows) else None
    trough = min(rows, key=lambda r: r["cum_cash"]) if rows else None
    funding_required = round(max(0.0, -trough["cum_cash"]), 2) if trough else 0.0

    through = ctx["actual_through"]
    done = [r for r in rows if r["month"] <= through]
    burnt_so_far = round(max(0.0, -min([0.0] + [r["cum_cash"] for r in done])), 2)
    recent = (done[-3:] if done else [r for r in rows if r["phase"] == "forecast"][:3])
    avg_net_burn = round(sum(r["net_burn"] for r in recent) / len(recent), 2) if recent else 0.0
    budget = _f(p.get("burn_budget"))
    remaining = round(budget - burnt_so_far, 2) if budget else None
    runway = (round(remaining / avg_net_burn, 1)
              if (budget and avg_net_burn > 0 and remaining is not None) else None)

    tm = by_m.get(target_m)
    profitable = bool(tm and tm["profit"] >= 0)
    paid_back = bool(tm and tm["cum_cash"] >= 0)
    has_data = bool(ctx["actuals"] or ctx["lines"] or _f(ctx["assumptions"].get("arpu")))
    if not has_data:
        verdict = "NO_DATA"
    elif profitable and paid_back:
        verdict = "PROFITABLE"
    elif profitable:
        verdict = "PROFITABLE_NOT_PAID_BACK"
    else:
        verdict = "NOT_PROFITABLE"

    return {
        "target_month": target_m, "verdict": verdict, "verdict_text": VERDICT_TEXT[verdict],
        "profitable_in_target_month": profitable, "paid_back_by_target": paid_back,
        "target_row": tm, "years": years,
        "first_profitable_month": first_profit, "break_even_month": sustained,
        "payback_month": payback,
        "funding_required": funding_required,
        "funding_trough_month": trough["month"] if trough and trough["cum_cash"] < 0 else None,
        "burn_budget": budget or None, "burnt_so_far": burnt_so_far,
        "budget_remaining": remaining, "avg_net_burn": avg_net_burn, "runway_months": runway,
        "within_burn_budget": (funding_required <= budget) if budget else None,
        "actual_through": through, "actual_through_source": ctx["actual_through_source"],
        "last_ledger_month": ctx["last_ledger_month"],
    }


def _solve_new_users(a, n_months, required):
    """Constant acquisitions per month that reach `required` active users after
    n_months, given the opening base and churn. end = begin*(1-c) + n."""
    s, c = _f(a.get("start_users")), min(max(_f(a.get("churn_monthly")), 0.0), 1.0)
    if n_months <= 0:
        return None
    if c <= 0:
        return max(0.0, (required - s) / n_months)
    keep = (1 - c) ** n_months
    denom = (1 - keep) / c
    return max(0.0, (required - s * keep) / denom) if denom > 0 else None


def targets(ctx, base_sim):
    """What marketing has to deliver for the product to be profitable by the target."""
    a = ctx["assumptions"]
    target_m = "%d-12" % ctx["target_year"]
    tm = next((r for r in base_sim["months"] if r["month"] == target_m), None)
    out = {"target_month": target_m, "notes": []}
    if not tm:
        out["notes"].append("The target month is outside the modelled horizon.")
        return out

    arpu = tm["arpu"]
    per_user = _f(a.get("server_per_user"))
    step_u, step_c = int(_f(a.get("server_step_users"))), _f(a.get("server_step_cost"))
    step_per_user = (step_c / step_u) if (step_u > 0 and step_c) else 0.0
    unit_margin = arpu - per_user - step_per_user
    user_driven = per_user * tm["users_end"] + (
        step_c * math.floor(tm["users_end"] / step_u) if step_u > 0 else 0.0)
    fixed = tm["opex"] - user_driven + tm["depreciation"] - (tm["revenue"] - tm["mrr"])
    out["fixed_cost_target_month"] = round(fixed, 2)
    out["unit_margin_per_user"] = round(unit_margin, 2)
    if arpu <= 0:
        out["notes"].append("Set a price (ARPU) — without one there is no number of users that breaks even.")
        return out
    if unit_margin <= 0:
        out["notes"].append("Each user costs more to serve than they pay. No amount of marketing fixes that — change the price or the server cost first.")
        return out

    required_active = math.ceil(max(0.0, fixed) / unit_margin)
    n_months = months_between(base_sim["rev_start"], target_m) + 1
    per_month = _solve_new_users(a, n_months, required_active)
    fc = [r for r in base_sim["months"] if r["phase"] == "forecast" and r["month"] <= target_m]
    mkt = (sum(r["costs"]["marketing"] for r in fc) / len(fc)) if fc else 0.0
    out.update({
        "required_active_users": required_active,
        "planned_active_users": round(tm["users_end"], 1),
        "active_user_gap": round(required_active - tm["users_end"], 1),
        "required_new_users_per_month": None if per_month is None else math.ceil(per_month),
        "months_to_target": n_months,
        "avg_forecast_marketing": round(mkt, 2),
        "cac_ceiling": (round(mkt / per_month, 2) if (per_month and per_month > 0 and mkt) else None),
    })

    # acquisition growth needed for the cash hole to be closed by the target month
    def paid_back(g):
        s = simulate(ctx, {"new_users_growth": g})
        row = next((r for r in s["months"] if r["month"] == target_m), None)
        return bool(row and row["cum_cash"] >= 0), s
    hi = 1.0
    ok_hi, _ = paid_back(hi)
    if not ok_hi:
        out["required_growth_for_payback"] = None
        out["notes"].append("Even 100% month-on-month growth in new users does not pay the cash back by %s." % target_m)
    else:
        lo = min(_f(a.get("new_users_growth")), 0.0)
        if paid_back(lo)[0]:
            out["required_growth_for_payback"] = round(lo, 4)
        else:
            for _ in range(24):
                mid = (lo + hi) / 2
                if paid_back(mid)[0]:
                    hi = mid
                else:
                    lo = mid
            # round UP: a target rounded down can sit just below the rate that
            # actually pays back, and then the number it gives marketing fails
            out["required_growth_for_payback"] = math.ceil(hi * 10000) / 10000.0

    ladder = []
    for g in [i / 100.0 for i in range(0, 41, 5)]:
        s = simulate(ctx, {"new_users_growth": g})
        row = next(r for r in s["months"] if r["month"] == target_m)
        ladder.append({"growth": g, "users_end": round(row["users_end"], 1),
                       "mrr": row["mrr"], "profit": row["profit"], "cum_cash": row["cum_cash"],
                       "profitable": row["profit"] >= 0, "paid_back": row["cum_cash"] >= 0})
    out["ladder"] = ladder
    return out


def server_analysis(ctx, base_sim):
    """How infrastructure cost climbs as the user base grows."""
    a = ctx["assumptions"]
    base, per = _f(a.get("server_base")), _f(a.get("server_per_user"))
    step_u, step_c = int(_f(a.get("server_step_users"))), _f(a.get("server_step_cost"))

    def cost_at(users):
        c = base + per * users
        if step_u > 0 and step_c:
            c += step_c * math.floor(users / step_u)
        return c

    rows = []
    for r in base_sim["months"]:
        if r["month"] < base_sim["rev_start"] and r["phase"] == "actual":
            continue
        s = r["costs"]["server"] if r["phase"] == "actual" else r["server_model"]
        rows.append({"month": r["month"], "phase": r["phase"], "users": r["users_end"],
                     "server_cost": round(s, 2),
                     "per_user": round(s / r["users_end"], 2) if r["users_end"] >= 1 else None,
                     "share_of_revenue": round(s / r["revenue"], 4) if r["revenue"] > 0 else None})
    peak = max([r["users_end"] for r in base_sim["months"]] + [0.0])
    top = max(10, int(math.ceil(peak * 2 / 100.0) * 100)) if peak else (step_u * 4 or 1000)
    curve = [{"users": u, "server_cost": round(cost_at(u), 2),
              "per_user": round(cost_at(u) / u, 2) if u else None}
             for u in [int(top * i / 10) for i in range(0, 11)]]
    thresholds = ([{"users": step_u * k, "adds_monthly": step_c,
                    "cost_after": round(cost_at(step_u * k), 2)} for k in range(1, 6)]
                  if step_u > 0 and step_c else [])
    return {"base": base, "per_user": per, "step_users": step_u, "step_cost": step_c,
            "rows": rows, "curve": curve, "thresholds": thresholds,
            "marginal_per_1000_users": round(cost_at(1000) - cost_at(0), 2),
            "actual_server_accounts": [c for c, cat in DEFAULT_CATEGORY_MAP if cat == "server"]}


def warnings_for(ctx, sim, summary):
    w = []
    a = ctx["assumptions"]
    if not ctx["project_ids"]:
        w.append("No ledger project is linked, so every month is a forecast. Link the SBU's "
                 "project to pull its real costs and revenue from the ledger.")
    elif not ctx["actuals"]:
        w.append("The linked projects have no posted journal lines yet.")
    if ctx["actual_through_source"] == "ledger" and ctx["last_ledger_month"]:
        gap = months_between(ctx["last_ledger_month"], ym_add(ym(datetime.date.fromisoformat(ctx["today"])), -1))
        if gap > 0:
            w.append("The ledger for this SBU stops at %s, so %d finished month(s) after it are "
                     "shown as FORECAST. Post the missing months, or set 'actual through' by hand."
                     % (ctx["last_ledger_month"], gap))
    if sim["ignored_oneoffs"]:
        w.append("%d one-off item(s) fall in months that are already actual and were ignored — "
                 "the ledger decides what happened in those months." % len(sim["ignored_oneoffs"]))
    if _f(a.get("arpu")) <= 0:
        w.append("No price (ARPU) is set, so forecast subscription revenue is zero.")
    if _f(a.get("churn_monthly")) <= 0 and _f(a.get("arpu")) > 0:
        w.append("Churn is 0%. Real SaaS products lose customers; LTV is not shown because it "
                 "would be infinite.")
    if ctx["capex"]:
        w.append("CAPEX is treated as cash when bought and depreciated straight-line afterwards. "
                 "If depreciation is ALSO booked in the ledger, the booked figure is used for that "
                 "month so it is never counted twice.")
    if summary["burn_budget"] is None:
        w.append("No burn budget is set, so runway cannot be measured. The funding required "
                 "figure tells you what that budget would need to be.")
    return w


def analyse(conn, product_id, company_ids, today=None):
    ctx = load_context(conn, product_id, company_ids, today)
    sim = simulate(ctx)
    summary = summarise(ctx, sim)
    return {
        "product": ctx["product"], "assumptions": ctx["assumptions"],
        "months": sim["months"], "rev_start": sim["rev_start"],
        "first_forecast": sim["first_forecast"],
        "summary": summary, "targets": targets(ctx, sim),
        "server": server_analysis(ctx, sim),
        "warnings": warnings_for(ctx, sim, summary),
        "categories": [{"key": c, "label": CATEGORY_LABELS[c]} for c in CATEGORIES],
    }


# -------------------------------------------------------------- template ----

# The NX-01 drivers from "NX Plan Analysis 2026 2027 (with marketing setting)",
# tab 05 Budget Forecast, section A and B. Server and API lines move into the
# server model so they can grow with users instead of sitting flat.
NX01_TEMPLATE = {
    "assumptions": {
        "arpu": 2000000.0, "arpu_growth_annual": 0.0, "revenue_start_month": "2027-03",
        "start_users": 60.0, "new_users_first": 7.0, "new_users_growth": 0.0958,
        "churn_monthly": 0.02,
        "server_base": 9699457.0, "server_per_user": 25000.0,
        "server_step_users": 250, "server_step_cost": 7500000.0,
    },
    "launch_month": "2026-01", "target_year": 2027,
    # Run-rate lines carry no start month: they apply from whichever month the
    # forecast begins, so a ledger that stops early does not leave a month with
    # no salary in it. Marketing is genuinely new from Sep-26, as in the workbook.
    "lines": [
        ("OPS / NX team salary", "people", 128125000, "fixed", None, None),
        ("Other direct labour", "people", 24732382, "fixed", None, None),
        ("Salaries & benefits", "people", 16167, "fixed", None, None),
        ("Food & beverage (per working day)", "office", 377658, "per_working_day", None, None),
        ("Subscriptions on credit card", "tools", 8602857, "fixed", None, None),
        ("Marketing — people (2 heads)", "marketing", 20000000, "fixed", "2026-09", None),
        ("Marketing — campaign (digital)", "marketing", 10000000, "fixed", "2026-09", None),
        ("Transportation", "office", 1622013, "fixed", None, None),
        ("Office supplies", "office", 322383, "fixed", None, None),
        ("Admin", "office", 3667, "fixed", None, None),
        ("Bank admin fees", "office", 39607, "fixed", None, None),
        ("Professional fees", "other", 3668333, "fixed", None, None),
        ("Misc expense", "other", 342500, "fixed", None, None),
    ],
    "oneoffs": [("2026-12", "in", "NX-01 Phase 2 termin", 860000000)],
    "capex": [("2026-02", "Asset register (servers, laptops, furniture)", 144982544, 48)],
}
