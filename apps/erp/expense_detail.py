"""Expense Breakdown - the devil in the detail.

Two sources of small, frequent spending that the ledger books one line at a
time and nobody reads one line at a time:

  Petty Cash Monit   every movement on the petty-cash account (1130): top-ups
                     in, spending out, and what each rupiah out was spent on
  Grab for Business  every ride, delivery and meal Grab bills the company,
                     per person and per trip, from the Account Parsing import

Only POSTED entries count, as in every report. The money always comes from the
ledger; grab_transactions only adds who took the ride and where it went, so an
entry edited after import still reports what the ledger now says.
"""
import calendar

GRAB_ACCOUNT_NAME = "CORP PAY - GRAB"
GRAB_SERVICES = ("Express", "Transport", "Food")
_CHUNK = 800  # stay well under SQLite's bound-parameter limit


def period(year, month=None):
    """(first day, last day) of a year, or of one month in it."""
    year = int(year)
    if month:
        m = int(month)
        return "%04d-%02d-01" % (year, m), "%04d-%02d-%02d" % (year, m, calendar.monthrange(year, m)[1])
    return "%04d-01-01" % year, "%04d-12-31" % year


def _in(ids):
    return ",".join("?" * len(ids))


def _accounts(conn, company_ids, where, params=()):
    if not company_ids:
        return []
    return [dict(r) for r in conn.execute(
        "SELECT a.id, a.company_id, a.code, a.name, c.code AS company_code"
        " FROM accounts a JOIN companies c ON c.id = a.company_id"
        " WHERE a.company_id IN (%s) AND a.type = 'asset' AND (%s)"
        " ORDER BY c.code, a.code" % (_in(company_ids), where),
        list(company_ids) + list(params))]


def petty_accounts(conn, company_ids):
    return _accounts(conn, company_ids, "a.code = '1130' OR UPPER(a.name) LIKE '%PETTY CASH%'")


def grab_accounts(conn, company_ids):
    return _accounts(conn, company_ids, "UPPER(TRIM(a.name)) = ?", (GRAB_ACCOUNT_NAME,))


def movements(conn, account_ids, start, end):
    """Every posted line on the given accounts between start and end, each with
    the counter-accounts its money went to (OUT) or came from (IN).

    A line's amount is split across the other side of its entry in proportion,
    so a three-line entry reports each cost account at its real share instead
    of pinning the whole amount on the first one."""
    if not account_ids:
        return 0.0, []
    ids = list(account_ids)
    opening = conn.execute(
        "SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl"
        " JOIN journal_entries je ON je.id = jl.entry_id"
        " WHERE jl.account_id IN (%s) AND je.status = 'posted' AND je.date < ?" % _in(ids),
        ids + [start]).fetchone()[0]
    lines = [dict(r) for r in conn.execute(
        "SELECT jl.id, jl.entry_id, jl.account_id, jl.debit, jl.credit, jl.description AS line_desc,"
        " je.date, je.entry_no, je.description, je.reference, je.source, je.company_id,"
        " c.code AS company_code"
        " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
        " JOIN companies c ON c.id = je.company_id"
        " WHERE jl.account_id IN (%s) AND je.status = 'posted' AND je.date BETWEEN ? AND ?"
        " ORDER BY je.date, je.id, jl.id" % _in(ids), ids + [start, end])]
    entry_ids = sorted({ln["entry_id"] for ln in lines})
    others = {}
    for i in range(0, len(entry_ids), _CHUNK):
        chunk = entry_ids[i:i + _CHUNK]
        for r in conn.execute(
                "SELECT jl.entry_id, jl.debit, jl.credit, a.code, a.name, a.type,"
                " p.code AS project_code"
                " FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id"
                " LEFT JOIN projects p ON p.id = jl.project_id"
                " WHERE jl.entry_id IN (%s) AND jl.account_id NOT IN (%s)"
                % (_in(chunk), _in(ids)), chunk + ids):
            others.setdefault(r["entry_id"], []).append(dict(r))
    rows = []
    for ln in lines:
        net = round((ln["debit"] or 0) - (ln["credit"] or 0), 2)
        if not net:
            continue
        direction = "in" if net > 0 else "out"
        amount = abs(net)
        # the other side of the entry: debits pay for an OUT, credits fund an IN
        side = [o for o in others.get(ln["entry_id"], [])
                if (o["debit"] if direction == "out" else o["credit"]) > 0]
        weight = sum((o["debit"] if direction == "out" else o["credit"]) for o in side)
        counter = []
        for o in side:
            w = o["debit"] if direction == "out" else o["credit"]
            counter.append({"code": o["code"], "name": o["name"], "type": o["type"],
                            "project_code": o["project_code"] or "",
                            "amount": round(amount * w / weight, 2) if weight else 0.0})
        if not counter:
            counter = [{"code": "", "name": "(no counter account)", "type": "",
                        "project_code": "", "amount": amount}]
        main = max(counter, key=lambda c: c["amount"])
        rows.append({
            "entry_id": ln["entry_id"], "date": ln["date"], "entry_no": ln["entry_no"],
            "description": ln["description"] or ln["line_desc"] or "",
            "reference": ln["reference"], "source": ln["source"],
            "company_code": ln["company_code"], "direction": direction,
            "in": amount if direction == "in" else 0.0,
            "out": amount if direction == "out" else 0.0,
            "counter": counter, "counter_code": main["code"], "counter_name": main["name"],
            "projects": sorted({c["project_code"] for c in counter if c["project_code"]}),
        })
    bal = round(opening, 2)
    for r in rows:
        bal = round(bal + r["in"] - r["out"], 2)
        r["balance"] = bal
    return round(opening, 2), rows


def _roll_up(rows, direction):
    out = {}
    for r in rows:
        if r["direction"] != direction:
            continue
        for c in r["counter"]:
            key = c["code"] or c["name"]
            slot = out.setdefault(key, {"code": c["code"], "name": c["name"], "amount": 0.0, "count": 0})
            slot["amount"] = round(slot["amount"] + c["amount"], 2)
            slot["count"] += 1
    return sorted(out.values(), key=lambda x: -x["amount"])


def _by_month(rows, year):
    months = [{"month": "%04d-%02d" % (int(year), m), "in": 0.0, "out": 0.0} for m in range(1, 13)]
    for r in rows:
        m = int(r["date"][5:7])
        months[m - 1]["in"] = round(months[m - 1]["in"] + r["in"], 2)
        months[m - 1]["out"] = round(months[m - 1]["out"] + r["out"], 2)
    return months


def account_section(conn, accounts, year, month=None):
    start, end = period(year, month)
    opening, rows = movements(conn, [a["id"] for a in accounts], start, end)
    tin = round(sum(r["in"] for r in rows), 2)
    tout = round(sum(r["out"] for r in rows), 2)
    return {
        "accounts": accounts, "start": start, "end": end,
        "opening": opening, "in_total": tin, "out_total": tout,
        "closing": round(opening + tin - tout, 2), "count": len(rows),
        "usage": _roll_up(rows, "out"), "sources": _roll_up(rows, "in"),
        "months": _by_month(rows, year), "rows": rows,
    }


def grab_detail(conn, company_ids, year, month=None):
    """Per-person, per-trip Grab spending. The amount and the cost account are
    read from the journal as it stands now; the Grab row adds the who and where."""
    start, end = period(year, month)
    if not company_ids:
        return []
    rows = [dict(r) for r in conn.execute(
        "SELECT g.*, je.date, je.entry_no, je.description AS entry_desc, c.code AS company_code,"
        " (SELECT COALESCE(SUM(x.debit), 0) FROM journal_lines x WHERE x.entry_id = je.id) AS entry_amount"
        " FROM grab_transactions g JOIN journal_entries je ON je.id = g.entry_id"
        " JOIN companies c ON c.id = je.company_id"
        " WHERE je.company_id IN (%s) AND je.status = 'posted' AND je.date BETWEEN ? AND ?"
        " ORDER BY je.date, g.time, g.id" % _in(company_ids),
        list(company_ids) + [start, end])]
    if not rows:
        return []
    ids = [r["entry_id"] for r in rows]
    cost = {}
    for i in range(0, len(ids), _CHUNK):
        chunk = ids[i:i + _CHUNK]
        for r in conn.execute(
                "SELECT jl.entry_id, a.code, a.name, p.code AS project_code, jl.debit"
                " FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id"
                " LEFT JOIN projects p ON p.id = jl.project_id"
                " WHERE jl.entry_id IN (%s) AND jl.debit > 0 AND a.type IN ('expense', 'revenue')"
                " ORDER BY jl.debit DESC" % _in(chunk), chunk):
            cost.setdefault(r["entry_id"], dict(r))
    out = []
    for r in rows:
        c = cost.get(r["entry_id"], {})
        out.append({
            "entry_id": r["entry_id"], "entry_no": r["entry_no"], "date": r["date"],
            "time": r["time"], "company_code": r["company_code"],
            "employee": r["employee"] or "?", "employee_group": r["employee_group"],
            "service": r["service"] if r["service"] in GRAB_SERVICES else (r["service"] or "Other"),
            "service_type": r["service_type"], "booking_id": r["booking_id"],
            "pickup": r["pickup"], "dropoff": r["dropoff"], "merchant": r["merchant"],
            "items": r["items"], "cost_code": r["cost_code"], "trip_description": r["trip_description"],
            "city": r["city"], "tips": r["tips"],
            "amount": round(r["entry_amount"] or r["amount"] or 0, 2),
            "account_code": c.get("code", ""), "account_name": c.get("name", ""),
            "project_code": c.get("project_code") or "",
        })
    return out


def grab_summary(trips):
    by_service = {s: {"service": s, "amount": 0.0, "count": 0} for s in GRAB_SERVICES}
    people, accounts = {}, {}
    for t in trips:
        s = by_service.setdefault(t["service"], {"service": t["service"], "amount": 0.0, "count": 0})
        s["amount"] = round(s["amount"] + t["amount"], 2)
        s["count"] += 1
        p = people.setdefault(t["employee"], {
            "employee": t["employee"], "group": t["employee_group"], "total": 0.0, "count": 0,
            "services": {x: {"amount": 0.0, "count": 0} for x in GRAB_SERVICES}})
        p["total"] = round(p["total"] + t["amount"], 2)
        p["count"] += 1
        ps = p["services"].setdefault(t["service"], {"amount": 0.0, "count": 0})
        ps["amount"] = round(ps["amount"] + t["amount"], 2)
        ps["count"] += 1
        if t["employee_group"] and not p["group"]:
            p["group"] = t["employee_group"]
        key = t["account_code"] or "?"
        a = accounts.setdefault(key, {"code": t["account_code"], "name": t["account_name"],
                                      "amount": 0.0, "count": 0})
        a["amount"] = round(a["amount"] + t["amount"], 2)
        a["count"] += 1
    total = round(sum(t["amount"] for t in trips), 2)
    return {
        "total": total, "count": len(trips), "people": len(people),
        "average": round(total / len(trips), 2) if trips else 0.0,
        "by_service": [v for v in by_service.values() if v["count"] or v["service"] in GRAB_SERVICES],
        "by_person": sorted(people.values(), key=lambda p: -p["total"]),
        "by_account": sorted(accounts.values(), key=lambda a: -a["amount"]),
    }


def expense_detail(conn, company_ids, year, month=None):
    petty = account_section(conn, petty_accounts(conn, company_ids), year, month)
    gaccts = grab_accounts(conn, company_ids)
    gacc = account_section(conn, gaccts, year, month)
    trips = grab_detail(conn, company_ids, year, month)
    grab = grab_summary(trips)
    grab.update({"accounts": gaccts, "trips": trips,
                 "billed": gacc["out_total"], "settled": gacc["in_total"],
                 "opening": gacc["opening"], "closing": gacc["closing"],
                 "account_rows": gacc["rows"], "months": _grab_months(trips, year)})
    return {"year": int(year), "month": int(month) if month else None,
            "start": petty["start"], "end": petty["end"], "petty": petty, "grab": grab}


def _grab_months(trips, year):
    months = [{"month": "%04d-%02d" % (int(year), m), **{s: 0.0 for s in GRAB_SERVICES}}
              for m in range(1, 13)]
    for t in trips:
        slot = months[int(t["date"][5:7]) - 1]
        slot[t["service"]] = round(slot.get(t["service"], 0.0) + t["amount"], 2)
    return months
