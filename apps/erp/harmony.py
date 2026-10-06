"""Project Details is the mother, the Money Tracker follows it.

A project's contract value is set in Project Details and is the fixed number;
the Money Tracker's invoice tracks are that contract's revenue invoicing - the
termins it is billed in. This module holds the one rule that keeps them
together (the invoices of a project never add up to more than its contract),
the invoicing plan a project screen shows, and the harmonization check that
lists every place where the two have drifted apart.

Cancelled tracks are left out everywhere: a cancelled invoice bills nothing.
"""

TOL = 0.5          # sub-rupiah float noise only; a termin split is done in whole rupiah


def _num(v):
    return round(float(v or 0), 2)


def project_row(conn, project_id):
    return conn.execute(
        "SELECT p.*, c.code AS company_code, pt.name AS type_name"
        " FROM projects p JOIN companies c ON c.id = p.company_id"
        " LEFT JOIN project_types pt ON pt.id = p.type_id WHERE p.id=?", (project_id,)).fetchone()


def invoiced_total(conn, project_id, exclude_track=None):
    row = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM money_tracker"
        " WHERE project_id=? AND status != 'cancelled' AND id IS NOT ?", (project_id, exclude_track)).fetchone()
    return _num(row[0])


def check_room(conn, project_id, amount, exclude_track=None, status="active"):
    """Refuse an invoice that would take a project's invoices past its contract
    value. A project with no contract value yet has nothing to check against -
    the harmonization check reports it instead."""
    if not project_id or status == "cancelled":
        return
    p = project_row(conn, project_id)
    if not p:
        raise ValueError("Project not found")
    cv = _num(p["contract_value"])
    if cv <= 0:
        return
    total = invoiced_total(conn, project_id, exclude_track) + _num(amount)
    if total > cv + TOL:
        raise ValueError(
            "%s's contract value in Project Details is Rp %s; with this invoice its invoices would total Rp %s."
            " Project Details is the source - change the contract value there first."
            % (p["code"], "{:,.0f}".format(cv), "{:,.0f}".format(total)))


def ledger_revenue(conn, project_id):
    """Revenue posted on the project in the ledger, whole life."""
    row = conn.execute(
        "SELECT COALESCE(SUM(jl.credit - jl.debit), 0) FROM journal_lines jl"
        " JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id"
        " WHERE jl.project_id=? AND je.status='posted' AND a.type='revenue'", (project_id,)).fetchone()
    return _num(row[0])


def invoicing(conn, project_id, money_row):
    """What the project screen shows: the contract, every termin billed from it,
    and what is left to plan. money_row turns a track row into the API dict."""
    p = project_row(conn, project_id)
    if not p:
        raise ValueError("Project not found")
    tracks = [money_row(r) for r in conn.execute(
        "SELECT m.*, c.code AS company_code, p.code AS project_code, p.name AS project_name"
        " FROM money_tracker m JOIN companies c ON c.id = m.company_id"
        " LEFT JOIN projects p ON p.id = m.project_id WHERE m.project_id=? ORDER BY m.id", (project_id,))]
    live = [t for t in tracks if t["status"] != "cancelled"]
    cv = _num(p["contract_value"])
    invoiced = _num(sum(t["amount"] or 0 for t in live))
    received = _num(sum(t["amount"] or 0 for t in live if t["status"] == "done"))
    return {
        "project": {"id": p["id"], "code": p["code"], "name": p["name"], "company_id": p["company_id"],
                    "company_code": p["company_code"], "status": p["status"], "type_id": p["type_id"],
                    "contract_value": cv},
        "tracks": tracks, "invoiced": invoiced, "received": received,
        "remaining": _num(cv - invoiced) if cv else None,
        "ledger_revenue": ledger_revenue(conn, project_id),
    }


def check(conn, company_ids):
    """Every place Project Details and the Money Tracker disagree.

    Levels: danger = the two contradict each other; watch = something is
    missing or behind; info = a project not set up for invoicing at all yet."""
    ph = ",".join("?" * len(company_ids))
    projects = [dict(r) for r in conn.execute(
        "SELECT p.*, c.code AS company_code FROM projects p JOIN companies c ON c.id = p.company_id"
        " WHERE p.company_id IN (%s) ORDER BY c.code, p.code" % ph, company_ids)]
    pids = [p["id"] for p in projects]
    tracks = [dict(r) for r in conn.execute(
        "SELECT m.*, c.code AS company_code FROM money_tracker m JOIN companies c ON c.id = m.company_id"
        " LEFT JOIN projects p ON p.id = m.project_id"
        " WHERE (m.company_id IN (%s) OR p.company_id IN (%s)) AND m.status != 'cancelled'"
        " ORDER BY m.id" % (ph, ph), list(company_ids) * 2)]
    by_project = {}
    for t in tracks:
        if t["project_id"]:
            by_project.setdefault(t["project_id"], []).append(t)
    pmap = {p["id"]: p for p in projects}
    for t in tracks:                       # a track can bill a project of another company
        if t["project_id"] and t["project_id"] not in pmap:
            r = conn.execute("SELECT p.*, c.code AS company_code FROM projects p JOIN companies c ON c.id=p.company_id"
                             " WHERE p.id=?", (t["project_id"],)).fetchone()
            if r:
                pmap[r["id"]] = dict(r)
    fmt = lambda v: "Rp {:,.0f}".format(v or 0)
    issues = []

    def add(level, kind, p=None, t=None, title="", detail="", amount=None, fix=None):
        issues.append({
            "level": level, "kind": kind, "title": title, "detail": detail, "amount": amount, "fix": fix,
            "project_id": p["id"] if p else None, "project_code": p["code"] if p else None,
            "project_name": p["name"] if p else None,
            "company_code": (p or t or {}).get("company_code"),
            "track_id": t["id"] if t else None,
            "track_title": (t.get("title") or t.get("invoice_no") or "#%d" % t["id"]) if t else None})

    for pid in pids:
        p = pmap[pid]
        mine = by_project.get(pid, [])
        cv = _num(p["contract_value"])
        invoiced = _num(sum(t["amount"] or 0 for t in mine))
        received = _num(sum(t["amount"] or 0 for t in mine if t["status"] == "done"))
        if not cv and mine:
            add("danger", "no_contract", p, title="Invoiced, but no contract value",
                detail="The Money Tracker bills %s for this project, but Project Details has no contract value."
                       " Set it in Project Details - the invoices follow it." % fmt(invoiced),
                amount=invoiced, fix="invoice")
        elif not cv:
            add("info", "not_set", p, title="No contract value, no invoices",
                detail="Set the contract value in Project Details, then plan its invoicing.", fix="invoice")
        elif not mine:
            add("watch", "not_invoiced", p, title="Contract not planned for invoicing",
                detail="Contract %s in Project Details, no invoice in the Money Tracker yet." % fmt(cv),
                amount=cv, fix="invoice")
        elif invoiced < cv - TOL:
            add("watch", "under", p, title="Part of the contract has no invoice",
                detail="Invoices total %s of the %s contract - %s is not planned for invoicing yet."
                       % (fmt(invoiced), fmt(cv), fmt(cv - invoiced)), amount=_num(cv - invoiced), fix="invoice")
        elif invoiced > cv + TOL:
            add("danger", "over", p, title="Invoices exceed the contract",
                detail="Invoices total %s, %s more than the %s contract in Project Details."
                       % (fmt(invoiced), fmt(invoiced - cv), fmt(cv)), amount=_num(invoiced - cv))
        open_ = [t for t in mine if t["status"] in ("active", "on_hold", "prospectus")]
        if p["status"] == "completed" and open_:
            add("watch", "done_open", p, title="Project Done, invoices still open",
                detail="Project Details says Done, but %d invoice(s) are still in process (%s)."
                       % (len(open_), fmt(sum(t["amount"] or 0 for t in open_))),
                amount=_num(sum(t["amount"] or 0 for t in open_)))
        if p["status"] != "completed" and mine and not open_ and cv and received >= cv - TOL:
            add("watch", "paid_not_done", p, title="Fully received, project still open",
                detail="Every invoice is received (%s) but Project Details still says %s."
                       % (fmt(received), p["status"].replace("_", " ")), fix="done")
        if received:
            booked = ledger_revenue(conn, pid)
            if received > booked + TOL:
                add("watch", "unbooked", p, title="Received but not booked",
                    detail="The Money Tracker shows %s received; the ledger has %s revenue on this project."
                           % (fmt(received), fmt(booked)), amount=_num(received - booked))
    for t in tracks:
        p = pmap.get(t["project_id"]) if t["project_id"] else None
        if not t["project_id"]:
            if t["status"] != "prospectus":
                add("watch", "no_project", None, t, title="Invoice without a project",
                    detail="This invoice track is not linked to a project, so Project Details cannot steer it.",
                    amount=_num(t["amount"]))
            continue
        if not p:
            continue
        if t["company_id"] != p["company_id"]:
            add("danger", "company", p, t, title="Billed by another company",
                detail="The track sits in %s; its project belongs to %s." % (t["company_code"], p["company_code"]),
                fix="company")
        if t["type_id"] and t["type_id"] != p["type_id"]:
            add("watch", "sector", p, t, title="Sector flag differs from the project",
                detail="The track carries its own sector flag; the project's sector is the one that counts.",
                fix="sector")
    order = {"danger": 0, "watch": 1, "info": 2}
    issues.sort(key=lambda i: (order[i["level"]], i["company_code"] or "", i["project_code"] or "", i["track_id"] or 0))
    count = lambda lv: sum(1 for i in issues if i["level"] == lv)
    return {"issues": issues, "projects": len(pids), "tracks": len(tracks),
            "danger": count("danger"), "watch": count("watch"), "info": count("info"),
            "harmonized": not count("danger") and not count("watch")}


def fix(conn, kind, track_id=None, project_id=None):
    """The one-click repairs the check offers. Each moves the Money Tracker to
    what Project Details says, except "done", which marks the project Done."""
    if kind in ("sector", "company"):
        t = conn.execute("SELECT * FROM money_tracker WHERE id=?", (track_id,)).fetchone()
        if not t or not t["project_id"]:
            raise ValueError("Invoice track not found")
        p = project_row(conn, t["project_id"])
        if kind == "company":
            conn.execute("UPDATE money_tracker SET company_id=? WHERE id=?", (p["company_id"], track_id))
        else:
            if not p["type_id"] and t["type_id"]:   # one project, one sector: hand the flag over
                conn.execute("UPDATE projects SET type_id=? WHERE id=?", (t["type_id"], p["id"]))
            conn.execute("UPDATE money_tracker SET type_id=NULL WHERE id=?", (track_id,))
        return p["company_id"]
    if kind == "done":
        p = project_row(conn, project_id)
        if not p:
            raise ValueError("Project not found")
        conn.execute("UPDATE projects SET status='completed' WHERE id=?", (project_id,))
        return p["company_id"]
    raise ValueError("Nothing to fix for '%s'" % kind)
