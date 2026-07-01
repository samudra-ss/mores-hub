"""MORES ERP - reporting engine.

All reports accept either a single company id or a list of company ids.
When more than one company is given the result is a consolidated view:
accounts are merged by account code and intercompany-flagged accounts are
eliminated.
"""

import datetime

# Owner-watch thresholds (from the Pengawasan sheet). "dir" high = bigger is
# better; low = smaller is better. healthy = on target, watch = approaching,
# anything past watch = danger. All are editable in Settings → Thresholds.
DEFAULT_THRESHOLDS = {
    "cash_buffer_months": {"healthy": 3.0, "watch": 1.5, "dir": "high"},
    "gross_margin": {"healthy": 0.45, "watch": 0.35, "dir": "high"},
    "net_margin": {"healthy": 0.10, "watch": 0.05, "dir": "high"},
    "current_ratio": {"healthy": 1.5, "watch": 1.0, "dir": "high"},
    "dso_days": {"healthy": 60, "watch": 90, "dir": "low"},
    "salary_ratio": {"healthy": 0.55, "watch": 0.65, "dir": "low"},
}


def _threshold_status(value, t):
    if value is None or not t:
        return "n/a"
    h, w = t.get("healthy"), t.get("watch")
    if h is None or w is None:
        return "n/a"
    if t.get("dir", "high") == "high":
        return "healthy" if value >= h else "watch" if value >= w else "danger"
    return "healthy" if value <= h else "watch" if value <= w else "danger"


def _fmt_threshold(v, is_pct):
    if v is None:
        return "-"
    return ("%.0f%%" % (v * 100)) if is_pct else ("%g" % v)


SIGN = {  # natural balance sign: balance = sign * (debit - credit)
    "asset": 1,
    "expense": 1,
    "liability": -1,
    "equity": -1,
    "revenue": -1,
}


def _company_filter(company_ids):
    ids = list(company_ids)
    ph = ",".join("?" * len(ids))
    return ph, ids


def _consolidated(company_ids):
    return len(list(company_ids)) > 1


def account_balances(conn, company_ids, date_from=None, date_to=None,
                     only_types=None, exclude_intercompany=False):
    """Aggregated (debit, credit) per account code over posted entries.

    Returns list of dicts {code, name, type, debit, credit, balance} where
    balance is signed by the account's natural side.
    """
    ph, ids = _company_filter(company_ids)
    where = ["je.status = 'posted'", "je.company_id IN (%s)" % ph]
    params = list(ids)
    if date_from:
        where.append("je.date >= ?")
        params.append(date_from)
    if date_to:
        where.append("je.date <= ?")
        params.append(date_to)
    if only_types:
        where.append("a.type IN (%s)" % ",".join("?" * len(only_types)))
        params.extend(only_types)
    if exclude_intercompany or _consolidated(company_ids):
        where.append("a.is_intercompany = 0")
    rows = conn.execute(
        """
        SELECT a.code, MIN(a.name) AS name, a.type,
               SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE %s
        GROUP BY a.code, a.type
        ORDER BY a.code
        """ % " AND ".join(where),
        params,
    ).fetchall()
    out = []
    for r in rows:
        debit, credit = r["debit"] or 0, r["credit"] or 0
        out.append({
            "code": r["code"], "name": r["name"], "type": r["type"],
            "debit": round(debit, 2), "credit": round(credit, 2),
            "balance": round(SIGN[r["type"]] * (debit - credit), 2),
        })
    return out


def trial_balance(conn, company_ids, date_from, date_to):
    rows = account_balances(conn, company_ids, date_from, date_to)
    rows = [r for r in rows if r["debit"] or r["credit"]]
    total_debit = round(sum(r["debit"] for r in rows), 2)
    total_credit = round(sum(r["credit"] for r in rows), 2)
    return {"rows": rows, "total_debit": total_debit, "total_credit": total_credit}


# entry source -> human label (kept in sync with the frontend SOURCE_LABELS)
SOURCE_LABELS = {
    "manual": "Manual entry",
    "bca_bank": "BCA bank receipt",
    "bca_csv": "BCA mutasi CSV",
    "bca_pdf": "BCA e-statement PDF",
    "monit_wallet": "Monit wallet / petty cash",
    "excel": "Excel import",
}


def trial_balance_detailed(conn, company_ids, date_from, date_to):
    """Trial balance where each account carries its individual posted journal
    lines, including the source of each entry (manual / BCA bank / Monit …)."""
    tb = trial_balance(conn, company_ids, date_from, date_to)
    ph, ids = _company_filter(company_ids)
    where = ["je.status = 'posted'", "je.company_id IN (%s)" % ph]
    params = list(ids)
    if date_from:
        where.append("je.date >= ?")
        params.append(date_from)
    if date_to:
        where.append("je.date <= ?")
        params.append(date_to)
    if _consolidated(company_ids):
        where.append("a.is_intercompany = 0")
    rows = conn.execute(
        """
        SELECT a.code AS acc_code, je.date AS date, je.entry_no AS entry_no,
               je.description AS description, je.reference AS reference,
               COALESCE(je.source, 'manual') AS source, c.code AS company_code,
               jl.debit AS debit, jl.credit AS credit, jl.description AS line_desc
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        JOIN companies c ON c.id = je.company_id
        WHERE %s
        ORDER BY a.code, je.date, je.entry_no
        """ % " AND ".join(where),
        params,
    ).fetchall()
    by_code = {}
    for r in rows:
        d = dict(r)
        d["source_label"] = SOURCE_LABELS.get(d["source"], d["source"])
        by_code.setdefault(d["acc_code"], []).append(d)
    detailed = [dict(acc, entries=by_code.get(acc["code"], [])) for acc in tb["rows"]]
    return {"rows": detailed, "total_debit": tb["total_debit"],
            "total_credit": tb["total_credit"]}


def account_ledger(conn, company_ids, code, date_from, date_to):
    """Every posted journal line for one account code in the period, with the
    source of each entry — backs the click-through ledger popup."""
    ph, ids = _company_filter(company_ids)
    where = ["je.status = 'posted'", "je.company_id IN (%s)" % ph, "a.code = ?"]
    params = list(ids) + [code]
    if date_from:
        where.append("je.date >= ?")
        params.append(date_from)
    if date_to:
        where.append("je.date <= ?")
        params.append(date_to)
    if _consolidated(company_ids):
        where.append("a.is_intercompany = 0")
    rows = conn.execute(
        """
        SELECT je.date AS date, je.entry_no AS entry_no, je.description AS description,
               je.reference AS reference, COALESCE(je.source, 'manual') AS source,
               c.code AS company_code, a.name AS account_name, a.type AS type,
               jl.debit AS debit, jl.credit AS credit, jl.description AS line_desc
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        JOIN companies c ON c.id = je.company_id
        WHERE %s
        ORDER BY je.date, je.entry_no
        """ % " AND ".join(where),
        params,
    ).fetchall()
    entries, name, typ = [], code, ""
    total_d = total_c = 0.0
    for r in rows:
        d = dict(r)
        name = d.pop("account_name") or name
        typ = d.pop("type") or typ
        d["source_label"] = SOURCE_LABELS.get(d["source"], d["source"])
        total_d += d["debit"] or 0
        total_c += d["credit"] or 0
        entries.append(d)
    return {"code": code, "name": name, "type": typ, "entries": entries,
            "total_debit": round(total_d, 2), "total_credit": round(total_c, 2)}


def profit_and_loss(conn, company_ids, date_from, date_to):
    rows = account_balances(conn, company_ids, date_from, date_to,
                            only_types=["revenue", "expense"])
    revenue = [r for r in rows if r["type"] == "revenue" and r["balance"] != 0]
    expense = [r for r in rows if r["type"] == "expense" and r["balance"] != 0]
    total_rev = round(sum(r["balance"] for r in revenue), 2)
    total_exp = round(sum(r["balance"] for r in expense), 2)
    return {
        "revenue": revenue, "expense": expense,
        "total_revenue": total_rev, "total_expense": total_exp,
        "net_profit": round(total_rev - total_exp, 2),
        "margin_pct": round(100.0 * (total_rev - total_exp) / total_rev, 1) if total_rev else 0,
    }


def balance_sheet(conn, company_ids, as_of_date):
    rows = account_balances(conn, company_ids, None, as_of_date)
    assets = [r for r in rows if r["type"] == "asset" and r["balance"] != 0]
    liabilities = [r for r in rows if r["type"] == "liability" and r["balance"] != 0]
    equity = [r for r in rows if r["type"] == "equity" and r["balance"] != 0]
    # accumulated earnings = lifetime revenue - expense through as-of date
    earnings = round(
        sum(r["balance"] for r in rows if r["type"] == "revenue")
        - sum(r["balance"] for r in rows if r["type"] == "expense"), 2)
    equity.append({"code": "3290", "name": "Accumulated Earnings (computed)",
                   "type": "equity", "debit": 0, "credit": 0, "balance": earnings})
    total_assets = round(sum(r["balance"] for r in assets), 2)
    total_liab = round(sum(r["balance"] for r in liabilities), 2)
    total_eq = round(sum(r["balance"] for r in equity), 2)
    return {
        "assets": assets, "liabilities": liabilities, "equity": equity,
        "total_assets": total_assets, "total_liabilities": total_liab,
        "total_equity": total_eq,
        "balanced": abs(total_assets - total_liab - total_eq) < 0.05,
    }


def monthly_pnl_series(conn, company_ids, year):
    """[{month, revenue, expense, profit}] for the 12 months of a year."""
    ph, ids = _company_filter(company_ids)
    ic = " AND a.is_intercompany = 0" if _consolidated(company_ids) else ""
    rows = conn.execute(
        """
        SELECT CAST(strftime('%%m', je.date) AS INTEGER) AS month, a.type,
               SUM(jl.credit - jl.debit) AS cr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE je.status='posted' AND je.company_id IN (%s)
          AND strftime('%%Y', je.date) = ? AND a.type IN ('revenue','expense')%s
        GROUP BY month, a.type
        """ % (ph, ic),
        ids + [str(year)],
    ).fetchall()
    series = {m: {"month": m, "revenue": 0, "expense": 0, "profit": 0} for m in range(1, 13)}
    for r in rows:
        if r["type"] == "revenue":
            series[r["month"]]["revenue"] = round(r["cr_net"] or 0, 2)
        else:
            series[r["month"]]["expense"] = round(-(r["cr_net"] or 0), 2)
    for m in series.values():
        m["profit"] = round(m["revenue"] - m["expense"], 2)
    return [series[m] for m in range(1, 13)]


def budget_vs_actual(conn, company_ids, year):
    """Per account: budget vs actual for a year (P&L accounts), with monthly detail."""
    ph, ids = _company_filter(company_ids)
    budgets = conn.execute(
        """
        SELECT a.code, MIN(a.name) AS name, a.type, b.month, SUM(b.amount) AS amount
        FROM budgets b JOIN accounts a ON a.id = b.account_id
        WHERE b.company_id IN (%s) AND b.year = ? AND b.project_id IS NULL
        GROUP BY a.code, a.type, b.month
        """ % ph,
        ids + [year],
    ).fetchall()
    ic = " AND a.is_intercompany = 0" if _consolidated(company_ids) else ""
    actuals = conn.execute(
        """
        SELECT a.code, MIN(a.name) AS name, a.type,
               CAST(strftime('%%m', je.date) AS INTEGER) AS month,
               SUM(jl.debit - jl.credit) AS dr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE je.status='posted' AND je.company_id IN (%s)
          AND strftime('%%Y', je.date) = ? AND a.type IN ('revenue','expense')%s
        GROUP BY a.code, a.type, month
        """ % (ph, ic),
        ids + [str(year)],
    ).fetchall()

    acc = {}
    def slot(code, name, typ):
        if code not in acc:
            acc[code] = {"code": code, "name": name, "type": typ,
                         "budget_months": [0.0] * 12, "actual_months": [0.0] * 12}
        return acc[code]

    for r in budgets:
        slot(r["code"], r["name"], r["type"])["budget_months"][r["month"] - 1] = round(r["amount"], 2)
    for r in actuals:
        amt = SIGN[r["type"]] * (r["dr_net"] or 0)  # natural-sign actual
        slot(r["code"], r["name"], r["type"])["actual_months"][r["month"] - 1] = round(amt, 2)

    rows = []
    for code in sorted(acc):
        a = acc[code]
        budget, actual = round(sum(a["budget_months"]), 2), round(sum(a["actual_months"]), 2)
        variance = round(actual - budget, 2)
        rows.append({**a, "budget": budget, "actual": actual, "variance": variance,
                     "used_pct": round(100.0 * actual / budget, 1) if budget else None})
    total_budget_exp = round(sum(r["budget"] for r in rows if r["type"] == "expense"), 2)
    total_actual_exp = round(sum(r["actual"] for r in rows if r["type"] == "expense"), 2)
    total_budget_rev = round(sum(r["budget"] for r in rows if r["type"] == "revenue"), 2)
    total_actual_rev = round(sum(r["actual"] for r in rows if r["type"] == "revenue"), 2)
    return {
        "rows": rows, "year": year,
        "total_budget_expense": total_budget_exp, "total_actual_expense": total_actual_exp,
        "total_budget_revenue": total_budget_rev, "total_actual_revenue": total_actual_rev,
    }


def project_budget_vs_actual(conn, company_id, project_id, year):
    """Per-account budget vs actual for a single project in one company/year."""
    budgets = conn.execute(
        """
        SELECT a.code, MIN(a.name) AS name, a.type, b.month, SUM(b.amount) AS amount
        FROM budgets b JOIN accounts a ON a.id = b.account_id
        WHERE b.company_id = ? AND b.year = ? AND b.project_id = ?
        GROUP BY a.code, a.type, b.month
        """,
        (company_id, year, project_id),
    ).fetchall()
    actuals = conn.execute(
        """
        SELECT a.code, MIN(a.name) AS name, a.type,
               CAST(strftime('%m', je.date) AS INTEGER) AS month,
               SUM(jl.debit - jl.credit) AS dr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE je.status='posted' AND je.company_id = ? AND jl.project_id = ?
          AND strftime('%Y', je.date) = ? AND a.type IN ('revenue','expense')
        GROUP BY a.code, a.type, month
        """,
        (company_id, project_id, str(year)),
    ).fetchall()

    acc = {}
    def slot(code, name, typ):
        if code not in acc:
            acc[code] = {"code": code, "name": name, "type": typ,
                         "budget_months": [0.0] * 12, "actual_months": [0.0] * 12}
        return acc[code]

    for r in budgets:
        slot(r["code"], r["name"], r["type"])["budget_months"][r["month"] - 1] = round(r["amount"], 2)
    for r in actuals:
        amt = SIGN[r["type"]] * (r["dr_net"] or 0)
        slot(r["code"], r["name"], r["type"])["actual_months"][r["month"] - 1] = round(amt, 2)

    rows = []
    for code in sorted(acc):
        a = acc[code]
        budget, actual = round(sum(a["budget_months"]), 2), round(sum(a["actual_months"]), 2)
        rows.append({**a, "budget": budget, "actual": actual,
                     "variance": round(actual - budget, 2),
                     "used_pct": round(100.0 * actual / budget, 1) if budget else None})
    return {
        "rows": rows, "year": year,
        "total_budget_expense": round(sum(r["budget"] for r in rows if r["type"] == "expense"), 2),
        "total_actual_expense": round(sum(r["actual"] for r in rows if r["type"] == "expense"), 2),
        "total_budget_revenue": round(sum(r["budget"] for r in rows if r["type"] == "revenue"), 2),
        "total_actual_revenue": round(sum(r["actual"] for r in rows if r["type"] == "revenue"), 2),
    }


def project_performance(conn, company_ids, year):
    """Per project for a year: revenue, direct cost, opex, profit, margin, budget."""
    ph, ids = _company_filter(company_ids)
    rows = conn.execute(
        """
        SELECT p.id AS project_id, p.code, p.name, p.status, c.code AS company_code,
               a.type, SUM(jl.credit - jl.debit) AS cr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        JOIN projects p ON p.id = jl.project_id
        JOIN companies c ON c.id = p.company_id
        WHERE je.status='posted' AND je.company_id IN (%s)
          AND strftime('%%Y', je.date) = ? AND a.type IN ('revenue','expense')
        GROUP BY p.id, a.type
        """ % ph,
        ids + [str(year)],
    ).fetchall()
    budgets = conn.execute(
        """
        SELECT b.project_id, SUM(b.amount) AS amount, a.type
        FROM budgets b JOIN accounts a ON a.id = b.account_id
        WHERE b.company_id IN (%s) AND b.year = ? AND b.project_id IS NOT NULL
        GROUP BY b.project_id, a.type
        """ % ph,
        ids + [year],
    ).fetchall()

    projects = {}
    for r in rows:
        p = projects.setdefault(r["project_id"], {
            "project_id": r["project_id"], "code": r["code"], "name": r["name"],
            "status": r["status"], "company": r["company_code"],
            "revenue": 0, "expense": 0, "budget_revenue": 0, "budget_expense": 0,
        })
        if r["type"] == "revenue":
            p["revenue"] = round(r["cr_net"] or 0, 2)
        else:
            p["expense"] = round(-(r["cr_net"] or 0), 2)
    for r in budgets:
        if r["project_id"] in projects:
            key = "budget_revenue" if r["type"] == "revenue" else "budget_expense"
            projects[r["project_id"]][key] = round(r["amount"], 2)
    out = []
    for p in projects.values():
        p["profit"] = round(p["revenue"] - p["expense"], 2)
        p["margin_pct"] = round(100.0 * p["profit"] / p["revenue"], 1) if p["revenue"] else 0
        out.append(p)
    out.sort(key=lambda x: -x["profit"])
    return out


def project_monthly(conn, project_id, year):
    rows = conn.execute(
        """
        SELECT CAST(strftime('%m', je.date) AS INTEGER) AS month, a.type,
               SUM(jl.credit - jl.debit) AS cr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE je.status='posted' AND jl.project_id = ?
          AND strftime('%Y', je.date) = ? AND a.type IN ('revenue','expense')
        GROUP BY month, a.type
        """,
        (project_id, str(year)),
    ).fetchall()
    series = {m: {"month": m, "revenue": 0, "expense": 0, "profit": 0} for m in range(1, 13)}
    for r in rows:
        if r["type"] == "revenue":
            series[r["month"]]["revenue"] = round(r["cr_net"] or 0, 2)
        else:
            series[r["month"]]["expense"] = round(-(r["cr_net"] or 0), 2)
    for m in series.values():
        m["profit"] = round(m["revenue"] - m["expense"], 2)
    return [series[m] for m in range(1, 13)]


def cash_flow(conn, company_ids, year):
    """Cash flow analysis: opening balance, monthly in/out/net/ending balance,
    plus sources & uses of cash by counter account (entries touching cash)."""
    ph, ids = _company_filter(company_ids)
    cash_cond = "a.type = 'asset' AND a.code LIKE '11%%'"
    opening = conn.execute(
        """SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
           WHERE je.status='posted' AND je.company_id IN (%s) AND %s AND je.date < ?"""
        % (ph, cash_cond), ids + ["%d-01-01" % year]).fetchone()[0]
    rows = conn.execute(
        """SELECT CAST(strftime('%%m', je.date) AS INTEGER) AS month,
                  SUM(jl.debit) AS cash_in, SUM(jl.credit) AS cash_out
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
           WHERE je.status='posted' AND je.company_id IN (%s) AND %s
             AND strftime('%%Y', je.date) = ?
           GROUP BY month""" % (ph, cash_cond), ids + [str(year)]).fetchall()
    by_month = {r["month"]: r for r in rows}
    monthly, running = [], round(opening, 2)
    for m in range(1, 13):
        r = by_month.get(m)
        cash_in = round(r["cash_in"] or 0, 2) if r else 0.0
        cash_out = round(r["cash_out"] or 0, 2) if r else 0.0
        net = round(cash_in - cash_out, 2)
        running = round(running + net, 2)
        monthly.append({"month": m, "cash_in": cash_in, "cash_out": cash_out,
                        "net": net, "ending": running})

    # sources & uses: counter accounts of entries that touched cash
    counters = conn.execute(
        """SELECT a.code, MIN(a.name) AS name, a.type,
                  SUM(jl.debit - jl.credit) AS net_debit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
           WHERE je.status='posted' AND je.company_id IN (%s)
             AND strftime('%%Y', je.date) = ?
             AND NOT (%s)
             AND je.id IN (
               SELECT jl2.entry_id FROM journal_lines jl2
               JOIN accounts a2 ON a2.id = jl2.account_id
               WHERE a2.type = 'asset' AND a2.code LIKE '11%%')
           GROUP BY a.code, a.type""" % (ph, cash_cond), ids + [str(year)]).fetchall()
    sources = sorted([{"code": c["code"], "name": c["name"], "type": c["type"],
                       "amount": round(-(c["net_debit"] or 0), 2)}
                      for c in counters if (c["net_debit"] or 0) < 0],
                     key=lambda x: -x["amount"])[:8]
    uses = sorted([{"code": c["code"], "name": c["name"], "type": c["type"],
                    "amount": round(c["net_debit"] or 0, 2)}
                   for c in counters if (c["net_debit"] or 0) > 0],
                  key=lambda x: -x["amount"])[:8]

    total_in = round(sum(m["cash_in"] for m in monthly), 2)
    total_out = round(sum(m["cash_out"] for m in monthly), 2)
    return {
        "year": year, "opening_balance": round(opening, 2), "monthly": monthly,
        "total_in": total_in, "total_out": total_out,
        "net_change": round(total_in - total_out, 2),
        "closing_balance": monthly[-1]["ending"],
        "sources": sources, "uses": uses,
    }


# ---- Accounts Receivable aging (Piutang) ----------------------------------
AR_STATUS = {
    "current": "Current (Lancar)", "late_1_30": "Late 1–30 (Terlambat)",
    "late_31_60": "Late 31–60 (Terlambat)", "late_61_90": "Late 61–90 (Terlambat)",
    "bad": "Bad / >90 (Macet)", "paid": "Paid (Lunas)",
}
AR_BUCKETS = ["not_due", "d1_30", "d31_60", "d61_90", "d90"]
AR_BUCKET_LABELS = {
    "not_due": "Not Due", "d1_30": "1–30 d", "d31_60": "31–60 d",
    "d61_90": "61–90 d", "d90": "> 90 d",
}


def receivables_aging(conn, company_ids, as_of):
    """Per-invoice AR aging as of a report date, plus bucket totals & summary.
    Aging runs on the OUTSTANDING amount (amount − paid); fully-paid rows drop
    out of the buckets and are marked Paid."""
    ph, ids = _company_filter(company_ids)
    rows = conn.execute(
        "SELECT r.*, c.code AS company_code FROM receivables r "
        "JOIN companies c ON c.id = r.company_id "
        "WHERE r.company_id IN (%s) ORDER BY r.due_date IS NULL, r.due_date, r.id" % ph,
        ids).fetchall()
    try:
        as_of_d = datetime.date.fromisoformat(as_of)
    except (ValueError, TypeError):
        as_of_d = datetime.date.today()
    items, buckets = [], {b: 0.0 for b in AR_BUCKETS}
    total_amount = total_out = 0.0
    for r in rows:
        amount = round(r["amount"] or 0, 2)
        paid = round(r["paid"] or 0, 2)
        outstanding = round(amount - paid, 2)
        total_amount = round(total_amount + amount, 2)
        bucket, days = None, None
        if outstanding <= 0.005:
            status = "paid"
        else:
            total_out = round(total_out + outstanding, 2)
            due = None
            if r["due_date"]:
                try:
                    due = datetime.date.fromisoformat(r["due_date"])
                except ValueError:
                    due = None
            days = (as_of_d - due).days if due else 0
            if days <= 0:
                bucket, status = "not_due", "current"
            elif days <= 30:
                bucket, status = "d1_30", "late_1_30"
            elif days <= 60:
                bucket, status = "d31_60", "late_31_60"
            elif days <= 90:
                bucket, status = "d61_90", "late_61_90"
            else:
                bucket, status = "d90", "bad"
            buckets[bucket] = round(buckets[bucket] + outstanding, 2)
        items.append({
            "id": r["id"], "company_code": r["company_code"], "client": r["client"],
            "invoice_no": r["invoice_no"], "invoice_date": r["invoice_date"],
            "due_date": r["due_date"], "amount": amount, "paid": paid,
            "outstanding": outstanding,
            "days_overdue": (max(days, 0) if days is not None else None),
            "bucket": bucket, "status": status, "status_label": AR_STATUS.get(status, status),
            "notes": r["notes"],
        })
    summary = [{"bucket": b, "label": AR_BUCKET_LABELS[b], "amount": buckets[b],
                "pct": round(100.0 * buckets[b] / total_out, 1) if total_out else 0.0}
               for b in AR_BUCKETS]
    return {
        "as_of": as_of_d.isoformat(), "items": items, "buckets": buckets, "summary": summary,
        "total_amount": total_amount, "total_outstanding": total_out, "risky": buckets["d90"],
        "status_labels": AR_STATUS, "bucket_labels": AR_BUCKET_LABELS,
    }


def payables_aging(conn, company_ids, as_of):
    """Per-bill AP aging (Hutang) as of a report date — the liabilities-side
    mirror of receivables_aging, on the OUTSTANDING amount (amount − paid)."""
    ph, ids = _company_filter(company_ids)
    rows = conn.execute(
        "SELECT p.*, c.code AS company_code FROM payables p "
        "JOIN companies c ON c.id = p.company_id "
        "WHERE p.company_id IN (%s) ORDER BY p.due_date IS NULL, p.due_date, p.id" % ph,
        ids).fetchall()
    try:
        as_of_d = datetime.date.fromisoformat(as_of)
    except (ValueError, TypeError):
        as_of_d = datetime.date.today()
    items, buckets = [], {b: 0.0 for b in AR_BUCKETS}
    total_amount = total_out = 0.0
    for r in rows:
        amount = round(r["amount"] or 0, 2)
        paid = round(r["paid"] or 0, 2)
        outstanding = round(amount - paid, 2)
        total_amount = round(total_amount + amount, 2)
        bucket, days = None, None
        if outstanding <= 0.005:
            status = "paid"
        else:
            total_out = round(total_out + outstanding, 2)
            due = None
            if r["due_date"]:
                try:
                    due = datetime.date.fromisoformat(r["due_date"])
                except ValueError:
                    due = None
            days = (as_of_d - due).days if due else 0
            if days <= 0:
                bucket, status = "not_due", "current"
            elif days <= 30:
                bucket, status = "d1_30", "late_1_30"
            elif days <= 60:
                bucket, status = "d31_60", "late_31_60"
            elif days <= 90:
                bucket, status = "d61_90", "late_61_90"
            else:
                bucket, status = "d90", "bad"
            buckets[bucket] = round(buckets[bucket] + outstanding, 2)
        items.append({
            "id": r["id"], "company_code": r["company_code"], "vendor": r["vendor"],
            "bill_no": r["bill_no"], "bill_date": r["bill_date"], "due_date": r["due_date"],
            "amount": amount, "paid": paid, "outstanding": outstanding,
            "days_overdue": (max(days, 0) if days is not None else None),
            "bucket": bucket, "status": status, "status_label": AR_STATUS.get(status, status),
            "notes": r["notes"],
        })
    summary = [{"bucket": b, "label": AR_BUCKET_LABELS[b], "amount": buckets[b],
                "pct": round(100.0 * buckets[b] / total_out, 1) if total_out else 0.0}
               for b in AR_BUCKETS]
    return {
        "as_of": as_of_d.isoformat(), "items": items, "buckets": buckets, "summary": summary,
        "total_amount": total_amount, "total_outstanding": total_out, "risky": buckets["d90"],
        "status_labels": AR_STATUS, "bucket_labels": AR_BUCKET_LABELS,
    }


# ---- Weekly cash flow + cash budget ---------------------------------------
CASH_WEEKS = 52  # week N = days [(N-1)*7+1 .. N*7]; week 52 absorbs the year-end remainder


def _cash_week_of(date_str, year):
    try:
        d = datetime.date.fromisoformat(date_str)
    except (ValueError, TypeError):
        return None
    if d.year != year:
        return None
    return min(CASH_WEEKS, (d.timetuple().tm_yday - 1) // 7 + 1)


def _cash_week_dates(year, week):
    start = datetime.date(year, 1, 1) + datetime.timedelta(days=(week - 1) * 7)
    end = datetime.date(year, 12, 31) if week >= CASH_WEEKS else start + datetime.timedelta(days=6)
    return start.isoformat(), end.isoformat()


def weekly_cash_flow(conn, company_ids, year):
    """Actual vs budgeted cash by week: opening balance carried forward, weekly
    cash in/out/net/ending for both actual (11xx movements) and the per-week cash
    budget, plus the running variance (actual ending − budget ending)."""
    ph, ids = _company_filter(company_ids)
    cash_cond = "a.type = 'asset' AND a.code LIKE '11%%'"
    opening = conn.execute(
        "SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl "
        "JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id "
        "WHERE je.status='posted' AND je.company_id IN (%s) AND %s AND je.date < ?"
        % (ph, cash_cond), ids + ["%d-01-01" % year]).fetchone()[0]
    rows = conn.execute(
        "SELECT je.date AS d, SUM(jl.debit) AS cin, SUM(jl.credit) AS cout "
        "FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id "
        "JOIN accounts a ON a.id = jl.account_id "
        "WHERE je.status='posted' AND je.company_id IN (%s) AND %s AND strftime('%%Y', je.date) = ? "
        "GROUP BY je.date" % (ph, cash_cond), ids + [str(year)]).fetchall()
    actual = {w: [0.0, 0.0] for w in range(1, CASH_WEEKS + 1)}
    for r in rows:
        w = _cash_week_of(r["d"], year)
        if w:
            actual[w][0] = round(actual[w][0] + (r["cin"] or 0), 2)
            actual[w][1] = round(actual[w][1] + (r["cout"] or 0), 2)
    brows = conn.execute(
        "SELECT week, SUM(cash_in) AS cin, SUM(cash_out) AS cout FROM cash_budget "
        "WHERE company_id IN (%s) AND year = ? GROUP BY week" % ph, ids + [year]).fetchall()
    bud = {r["week"]: [round(r["cin"] or 0, 2), round(r["cout"] or 0, 2)] for r in brows}
    weeks, run, brun = [], round(opening, 2), round(opening, 2)
    t_in = t_out = bt_in = bt_out = 0.0
    for w in range(1, CASH_WEEKS + 1):
        cin, cout = actual[w]
        net = round(cin - cout, 2)
        run = round(run + net, 2)
        bcin, bcout = bud.get(w, [0.0, 0.0])
        bnet = round(bcin - bcout, 2)
        brun = round(brun + bnet, 2)
        s, e = _cash_week_dates(year, w)
        t_in, t_out, bt_in, bt_out = t_in + cin, t_out + cout, bt_in + bcin, bt_out + bcout
        weeks.append({"week": w, "start": s, "end": e, "cash_in": cin, "cash_out": cout,
                      "net": net, "ending": run, "budget_in": bcin, "budget_out": bcout,
                      "budget_net": bnet, "budget_ending": brun, "variance": round(run - brun, 2)})
    return {
        "year": year, "opening_balance": round(opening, 2), "weeks": weeks,
        "total_in": round(t_in, 2), "total_out": round(t_out, 2), "total_net": round(t_in - t_out, 2),
        "budget_total_in": round(bt_in, 2), "budget_total_out": round(bt_out, 2),
        "budget_total_net": round(bt_in - bt_out, 2),
        "closing": weeks[-1]["ending"], "budget_closing": weeks[-1]["budget_ending"],
    }


def dashboard(conn, company_ids, year, thresholds=None):
    date_from, date_to = "%d-01-01" % year, "%d-12-31" % year
    pnl = profit_and_loss(conn, company_ids, date_from, date_to)
    monthly = monthly_pnl_series(conn, company_ids, year)
    bva = budget_vs_actual(conn, company_ids, year)

    balances = account_balances(conn, company_ids, None, date_to)
    cash = round(sum(b["balance"] for b in balances
                     if b["type"] == "asset" and b["code"].startswith("11")), 2)
    ar = round(sum(b["balance"] for b in balances if b["code"] == "1200"), 2)
    ap = round(sum(b["balance"] for b in balances if b["code"] == "2100"), 2)

    # Working capital as of TODAY = current assets − current liabilities.
    # Current assets exclude Fixed Assets (15xx); current liabilities exclude the
    # long-term Bank Loans (2500). Intercompany lines are already eliminated in
    # consolidated views by account_balances().
    today = datetime.date.today().isoformat()
    wc_bal = account_balances(conn, company_ids, None, today)
    current_assets = round(sum(b["balance"] for b in wc_bal
                               if b["type"] == "asset" and not b["code"].startswith("15")), 2)
    current_liabilities = round(sum(b["balance"] for b in wc_bal
                                    if b["type"] == "liability" and b["code"] != "2500"), 2)
    working_capital = round(current_assets - current_liabilities, 2)

    # Expense breakdown with budget (Realization vs Budget) for every expense line,
    # so the full Office Expense and its budget are visible.
    bva_exp = {r["code"]: r for r in bva["rows"] if r["type"] == "expense"}
    actual_by_code = {r["code"]: r["balance"] for r in pnl["expense"]}
    exp_codes = set(bva_exp) | set(actual_by_code)
    expense_breakdown = []
    for code in exp_codes:
        row = bva_exp.get(code)
        name = row["name"] if row else next(
            (r["name"] for r in pnl["expense"] if r["code"] == code), code)
        expense_breakdown.append({
            "code": code, "name": name,
            "actual": round(actual_by_code.get(code, row["actual"] if row else 0), 2),
            "budget": round(row["budget"] if row else 0, 2),
        })
    expense_breakdown.sort(key=lambda r: -r["actual"])

    # Office Expense YTD = rent (6200) + utilities (6300) + the Office &
    # Administration group (66xx, which now includes Bank Admin Fees 6610)
    office_expense = round(sum(r["balance"] for r in pnl["expense"]
                              if r["code"] in ("6200", "6300") or r["code"].startswith("66")), 2)

    # ---- ratios & health indicators (modelled on the Pengawasan sheet) -------
    revenue = pnl["total_revenue"]
    cogs = round(sum(r["balance"] for r in pnl["expense"] if r["code"].startswith("5")), 2)
    opex = round(sum(r["balance"] for r in pnl["expense"] if r["code"].startswith("6")), 2)
    salary = round(sum(r["balance"] for r in pnl["expense"] if r["code"] == "6100"), 2)
    # non-operating = interest/financing (72xx). Operating profit therefore keeps
    # every other expense — incl. the MDA C-AKUN (7300) operating band — so no
    # expense band silently vanishes from the operating line.
    non_operating = round(sum(r["balance"] for r in pnl["expense"] if r["code"].startswith("72")), 2)
    gross_profit = round(revenue - cogs, 2)
    operating_profit = round(revenue - (pnl["total_expense"] - non_operating), 2)

    # balance-sheet ratios use the same period-end snapshot as cash/AR/AP so a
    # past/future year reads its year-end position (not today's)
    period_ca = round(sum(b["balance"] for b in balances
                          if b["type"] == "asset" and not b["code"].startswith("15")), 2)
    period_cl = round(sum(b["balance"] for b in balances
                          if b["type"] == "liability" and b["code"] != "2500"), 2)
    period_inv = round(sum(b["balance"] for b in balances if b["code"] == "1300"), 2)

    today_d = datetime.date.today()
    if year < today_d.year:
        months_elapsed, days_elapsed = 12, 365
    elif year > today_d.year:
        months_elapsed, days_elapsed = 0, 0
    else:
        months_elapsed = today_d.month
        days_elapsed = (today_d - datetime.date(year, 1, 1)).days + 1

    gross_margin = round(gross_profit / revenue, 4) if revenue else None
    net_margin = round(pnl["net_profit"] / revenue, 4) if revenue else None
    salary_ratio = round(salary / revenue, 4) if revenue else None
    current_ratio = round(period_ca / period_cl, 2) if period_cl else None
    quick_ratio = round((period_ca - period_inv) / period_cl, 2) if period_cl else None
    dso_days = round(ar * days_elapsed / revenue, 1) if revenue and days_elapsed else None
    avg_month_exp = (pnl["total_expense"] / months_elapsed) if months_elapsed else 0
    cash_buffer_months = round(cash / avg_month_exp, 2) if avg_month_exp else None

    th = thresholds or DEFAULT_THRESHOLDS
    indicators = [
        ("gross_margin", "Gross Margin", gross_margin, True),
        ("net_margin", "Net Margin", net_margin, True),
        ("current_ratio", "Current Ratio", current_ratio, False),
        ("dso_days", "DSO (days)", dso_days, False),
        ("cash_buffer_months", "Cash Buffer (months)", cash_buffer_months, False),
        ("salary_ratio", "Salary / Revenue", salary_ratio, True),
    ]
    health, warnings = [], []
    for key, label, value, is_pct in indicators:
        t = th.get(key, DEFAULT_THRESHOLDS.get(key, {}))
        status = _threshold_status(value, t)
        health.append({"key": key, "label": label, "value": value, "is_pct": is_pct,
                       "target": t.get("healthy"), "watch": t.get("watch"),
                       "dir": t.get("dir", "high"), "status": status})
        if status in ("watch", "danger"):
            warnings.append({"level": "danger" if status == "danger" else "watch",
                             "key": key, "title": label,
                             "detail": "%s is %s the safe range (target %s)."
                                       % (label, "below" if t.get("dir") == "high" else "above",
                                          _fmt_threshold(t.get("healthy"), is_pct))})

    # cost overrun vs the YTD-prorated budget (day-to-day pace)
    factor = (months_elapsed / 12.0) if months_elapsed else 0.0
    budget_prorated = round(bva["total_budget_expense"] * factor, 2)
    cost_overrun = round(bva["total_actual_expense"] - budget_prorated, 2)
    overrun_accounts = []
    for r in bva["rows"]:
        if r["type"] != "expense":
            continue
        prorated = r["budget"] * factor
        over = round(r["actual"] - prorated, 2)
        if prorated > 0 and over > 0.005:
            overrun_accounts.append({"code": r["code"], "name": r["name"],
                                     "actual": round(r["actual"], 2),
                                     "prorated_budget": round(prorated, 2), "over": over})
    overrun_accounts.sort(key=lambda x: -x["over"])
    if cost_overrun > 0 and budget_prorated > 0:
        warnings.insert(0, {"level": "danger", "key": "cost_overrun", "title": "Cost overrun",
                            "detail": "Spending is over the budget pace for %d month(s) by this amount."
                                      % months_elapsed, "amount": cost_overrun})

    net_position = round(ar - ap, 2)
    # risky AR / AP (>90 days outstanding) from the aging modules, as of today
    try:
        risky_ar = receivables_aging(conn, company_ids, today)["risky"]
    except Exception:
        risky_ar = None
    try:
        risky_ap = payables_aging(conn, company_ids, today)["risky"]
    except Exception:
        risky_ap = None

    proj = project_performance(conn, company_ids, year)
    cf = cash_flow(conn, company_ids, year)
    # weekly cash trajectory — actual vs budgeted ending balance (dashboard chart)
    try:
        wcf = weekly_cash_flow(conn, company_ids, year)
        weekly_cash = [{"week": w["week"], "ending": w["ending"],
                        "budget_ending": w["budget_ending"], "net": w["net"],
                        "budget_net": w["budget_net"]} for w in wcf["weeks"]]
        cash_budget_set = wcf["budget_total_in"] != 0 or wcf["budget_total_out"] != 0
    except Exception:
        weekly_cash, cash_budget_set = [], False

    ph, ids = _company_filter(company_ids)
    # per-company summary (useful on consolidated/holding view)
    per_company = conn.execute(
        """
        SELECT c.code, c.name, c.is_holding, a.type,
               SUM(jl.credit - jl.debit) AS cr_net
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        JOIN companies c ON c.id = je.company_id
        WHERE je.status='posted' AND je.company_id IN (%s)
          AND strftime('%%Y', je.date) = ? AND a.type IN ('revenue','expense')
        GROUP BY c.id, a.type
        """ % ph,
        ids + [str(year)],
    ).fetchall()
    comp = {}
    for r in per_company:
        c = comp.setdefault(r["code"], {"code": r["code"], "name": r["name"],
                                        "is_holding": r["is_holding"], "revenue": 0, "expense": 0})
        if r["type"] == "revenue":
            c["revenue"] = round(r["cr_net"] or 0, 2)
        else:
            c["expense"] = round(-(r["cr_net"] or 0), 2)
    for c in comp.values():
        c["profit"] = round(c["revenue"] - c["expense"], 2)

    return {
        "year": year,
        "as_of": today,
        "kpis": {
            "revenue_ytd": pnl["total_revenue"],
            "expense_ytd": pnl["total_expense"],
            "net_profit_ytd": pnl["net_profit"],
            "margin_pct": pnl["margin_pct"],
            "cash_balance": cash,
            "accounts_receivable": ar,
            "accounts_payable": ap,
            "working_capital": working_capital,
            "current_assets": current_assets,
            "current_liabilities": current_liabilities,
            "office_expense": office_expense,
            "budget_expense": bva["total_budget_expense"],
            "budget_used_pct": round(100.0 * bva["total_actual_expense"] / bva["total_budget_expense"], 1)
                if bva["total_budget_expense"] else None,
            # xlsx-style additions
            "gross_profit": gross_profit,
            "gross_margin": gross_margin,
            "operating_profit": operating_profit,
            "current_ratio": current_ratio,
            "quick_ratio": quick_ratio,
            "dso_days": dso_days,
            "cash_buffer_months": cash_buffer_months,
            "salary_ratio": salary_ratio,
            "net_position": net_position,
            "months_elapsed": months_elapsed,
        },
        "health": health,
        "warnings": warnings,
        "ar_ap": {
            "ar": ar, "ap": ap, "net_position": net_position,
            "risky_ar": risky_ar,  # >90-day outstanding from AR Aging
            "risky_ap": risky_ap,  # >90-day outstanding from AP Aging
            "free_cash": cash,
        },
        "cost_overrun": {"over": cost_overrun, "prorated_budget": budget_prorated,
                         "accounts": overrun_accounts[:6]},
        "monthly": monthly,
        "expense_breakdown": expense_breakdown,
        "projects": proj[:8],
        "cash_flow": {
            "monthly": cf["monthly"], "opening_balance": cf["opening_balance"],
            "total_in": cf["total_in"], "total_out": cf["total_out"],
            "net_change": cf["net_change"], "closing_balance": cf["closing_balance"],
        },
        "weekly_cash": weekly_cash,
        "cash_budget_set": cash_budget_set,
        "per_company": sorted(comp.values(), key=lambda c: -c["revenue"]),
    }
