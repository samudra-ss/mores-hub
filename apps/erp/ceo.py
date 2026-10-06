"""CEO Dashboard - the few things a CEO opens the app for.

  cash control      closing cash month by month: actual from the ledger, then a
                    forecast that carries the last actual closing forward with
                    the Budget Center's net for each month, against the minimum
                    cash the Oracle's policy asks for
  project highlights what the Money Tracker says about getting paid: tracks past
                    their phase's planned days, tracks in the SPM-to-SP2D payment
                    stretch, and what is done
  SBU / investments  assembled in server.py from the SBU report and the
                    Investment Center, which already own those numbers

Pure functions over a connection; nothing here writes.
"""
import calendar
import datetime

import fpa_cash

MON3 = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# the payment stretch of the Money Tracker: SPM, SPP, approval, KASDA, SP2D
SPM_PHASES = ("p7", "p8", "p9", "p10", "p11")


def _next_first(year, month):
    return "%04d-%02d-01" % (year + (month == 12), 1 if month == 12 else month + 1)


def _in(ids):
    return ",".join("?" * len(ids))


def last_posted(conn, company_ids, today):
    row = conn.execute(
        "SELECT MAX(date) FROM journal_entries WHERE status='posted' AND company_id IN (%s) AND date <= ?"
        % _in(company_ids), list(company_ids) + [today.isoformat()]).fetchone()
    return row[0]


def through_month(conn, company_ids, year, today):
    """The last month the ledger has actually reached in this year. Months after
    it are forecast, whatever the calendar says - a ledger that stops in July
    must not draw August as a fact."""
    last = last_posted(conn, company_ids, today)
    if not last:
        return 0
    ly, lm = int(last[:4]), int(last[5:7])
    if ly > year:
        return 12
    if ly < year:
        return 0
    return lm


def budget_net_by_month(conn, company_ids, year):
    """Money in less money out the Budget Center plans per month. Non-cash lines
    (depreciation, anything classed noncash) are left out, and intercompany
    accounts too when more than one company is in scope."""
    ic = " AND a.is_intercompany = 0" if len(company_ids) > 1 else ""
    rows = conn.execute(
        "SELECT b.month, SUM(CASE WHEN a.type='revenue' THEN b.amount ELSE -b.amount END) AS net"
        " FROM budgets b JOIN accounts a ON a.id = b.account_id"
        " WHERE b.company_id IN (%s) AND b.year = ? AND a.type IN ('revenue','expense')"
        " AND COALESCE(b.cf_class,'') <> 'noncash' AND COALESCE(a.cash_flow_class,'') <> 'noncash'"
        " AND a.code NOT LIKE '65%%'%s GROUP BY b.month" % (_in(company_ids), ic),
        list(company_ids) + [year]).fetchall()
    out = [0.0] * 12
    for r in rows:
        if 1 <= int(r["month"]) <= 12:
            out[int(r["month"]) - 1] = round(r["net"] or 0, 2)
    return out


def cash_accounts(conn, company_ids, as_of, cash_codes=None):
    import reports
    cond, params = reports.cash_condition(cash_codes, exclude_intercompany=len(company_ids) > 1)
    return [dict(r) for r in conn.execute(
        "SELECT c.code AS company_code, a.code, a.name, ROUND(SUM(jl.debit - jl.credit), 2) AS balance"
        " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
        " JOIN accounts a ON a.id = jl.account_id JOIN companies c ON c.id = je.company_id"
        " WHERE je.status='posted' AND je.company_id IN (%s) AND %s AND je.date < ?"
        " GROUP BY a.id ORDER BY c.code, a.code" % (_in(company_ids), cond),
        list(company_ids) + params + [as_of])]


def cash_control(conn, company_ids, year, cash_codes=None, policy=None, today=None):
    today = today or datetime.date.today()
    ids = list(company_ids)
    year = int(year)
    T = through_month(conn, ids, year, today)
    opening = fpa_cash.opening_cash(conn, ids, "%d-01-01" % year, cash_codes)
    net = budget_net_by_month(conn, ids, year)
    actual = [None] * 12
    for m in range(1, T + 1):
        actual[m - 1] = fpa_cash.opening_cash(conn, ids, _next_first(year, m), cash_codes)
    budget, run = [], opening
    for m in range(12):
        run += net[m]
        budget.append(round(run, 2))
    # the forecast starts FROM the last actual closing, so the dashed line joins
    # the solid one; with no actual month yet it starts from the year's opening
    forecast = [None] * 12
    anchor = actual[T - 1] if T else opening
    run = anchor
    if T:
        forecast[T - 1] = anchor
    for m in range(T, 12):
        run += net[m]
        forecast[m] = round(run, 2)
    floors, warnings = fpa_cash.buffer_floors(conn, ids, policy, year)
    minimum = round(sum(f["floor"] for f in floors.values()), 2)
    latest = actual[T - 1] if T else opening
    year_end = forecast[11] if forecast[11] is not None else actual[11]
    low_m = None
    for m in range(T, 12):
        if forecast[m] is not None and forecast[m] < minimum and low_m is None:
            low_m = m + 1
    as_of = _next_first(year, T) if T else "%d-01-01" % year
    return {
        "year": year, "through": T, "through_label": ("%s %d" % (MON3[T - 1], year)) if T else "",
        "opening": opening, "latest": latest, "minimum": minimum,
        "status": "above" if latest >= minimum else "below",
        "year_end": year_end, "first_below_month": low_m,
        "months": [{"month": "%d-%02d" % (year, m + 1), "label": MON3[m], "actual": actual[m],
                    "forecast": forecast[m], "budget": budget[m], "budget_net": net[m]} for m in range(12)],
        "accounts": cash_accounts(conn, ids, as_of, cash_codes), "accounts_as_of": as_of,
        "floors": list(floors.values()), "warnings": warnings,
    }


def _date(s):
    try:
        return datetime.date(int(s[:4]), int(s[5:7]), int(s[8:10]))
    except (TypeError, ValueError, IndexError):
        return None


def project_highlights(conn, company_ids, phases, today=None, limit=8):
    """phases: server.MONEY_PHASES - (key, label, name, plan days) in order."""
    today = today or datetime.date.today()
    order = [p[0] for p in phases]
    by_key = {p[0]: p for p in phases}
    tracks = [dict(r) for r in conn.execute(
        "SELECT m.*, c.code AS company_code, p.code AS project_code, p.name AS project_name"
        " FROM money_tracker m JOIN companies c ON c.id = m.company_id"
        " LEFT JOIN projects p ON p.id = m.project_id"
        " WHERE m.company_id IN (%s) AND m.status <> 'cancelled'" % _in(company_ids), list(company_ids))]
    stages = {}
    if tracks:
        for s in conn.execute(
                "SELECT * FROM money_tracker_stages WHERE tracker_id IN (%s) ORDER BY id"
                % _in([t["id"] for t in tracks]), [t["id"] for t in tracks]):
            stages.setdefault(s["tracker_id"], []).append(dict(s))
    delayed, spm, done = [], [], []
    for t in tracks:
        key = t["phase_key"] if t["phase_key"] in by_key else order[0]
        idx = order.index(key)
        cur = [s for s in stages.get(t["id"], []) if s["phase_key"] == key]
        cur = cur[-1] if cur else {}
        plan = cur.get("plan_days") or by_key[key][3]
        entered = _date(cur.get("entered_at") or t.get("started_at"))
        due = entered + datetime.timedelta(days=int(plan or 0)) if entered else None
        late = (today - due).days if (due and t["status"] == "active") else 0
        row = {"id": t["id"], "project_code": t["project_code"] or "", "project_name": t["project_name"] or "",
               "title": t["title"] or "", "client": t["client"] or "", "company_code": t["company_code"],
               "amount": round(t["amount"] or 0, 2), "status": t["status"], "phase_key": key,
               "phase_label": by_key[key][1], "phase_name": by_key[key][2], "phase_no": idx + 1,
               "phase_total": len(order), "entered_at": entered.isoformat() if entered else None,
               "due": due.isoformat() if due else None, "days_late": max(0, late),
               "days_in_phase": (today - entered).days if entered else None, "is_hot": bool(t.get("is_hot"))}
        if t["status"] == "done" or key == order[-1]:
            done.append(row)
        elif t["status"] == "active":
            if late > 0:
                delayed.append(row)
            if key in SPM_PHASES:
                spm.append(row)
    # projects marked Done in Project Details that the tracker has not covered
    seen = {r["project_code"] for r in done if r["project_code"]}
    for p in conn.execute(
            "SELECT p.id, p.code, p.name, p.end_date, c.code AS company_code FROM projects p"
            " JOIN companies c ON c.id = p.company_id WHERE p.status='completed' AND p.company_id IN (%s)"
            % _in(company_ids), list(company_ids)):
        if p["code"] not in seen:
            done.append({"id": None, "project_id": p["id"], "project_code": p["code"], "project_name": p["name"],
                         "title": "", "client": "", "company_code": p["company_code"], "amount": 0.0,
                         "status": "done", "phase_label": "Project done", "phase_name": "marked Done in Project Details",
                         "due": p["end_date"], "days_late": 0, "is_hot": False})
    delayed.sort(key=lambda r: -r["days_late"])
    spm.sort(key=lambda r: (-(r["days_late"] or 0), -(r["amount"] or 0)))
    done.sort(key=lambda r: -(r["amount"] or 0))

    def pack(rows):
        return {"count": len(rows), "amount": round(sum(r["amount"] for r in rows), 2), "rows": rows[:limit]}

    return {"delayed": pack(delayed), "spm": pack(spm), "done": pack(done), "today": today.isoformat()}
