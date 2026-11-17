"""(v1.12b) The Money Tracker <-> journal connector.

When money arrives - parsed from the bank statement (Account Parsing) or keyed
in by hand - it is posted as a journal line crediting a REVENUE account and
tagged to a project. That line is the key: revenue of project A is a payment
for one of project A's invoices.

Each time the Money Tracker opens, the posted revenue lines of the tracked
projects are read and matched to the invoices still waiting for money:

  1. lines already validated (or dismissed) by a person are taken as decided;
  2. invoices already Done without a validated line are assumed to have been
     paid by the project's earliest lines - those are used up first, oldest
     first, so old receipts are not offered again for new invoices;
  3. every line left is offered to the open invoice (active / on hold) of the
     same project whose remaining amount is closest - the amounts may differ
     (tax withheld, a partial termin), the difference is shown.

Nothing here writes: a person validates a match (paid -> the invoice is Done,
partial -> it stays open with the money counted) or dismisses it. The journal
itself is never changed.
"""

OPEN = ("active", "on_hold")


def _fit(amount, remaining):
    if remaining <= 0:
        return "over"
    r = amount / remaining
    if abs(1 - r) <= 0.005:
        return "exact"
    if r > 1:
        return "over"
    return "near" if r >= 0.85 else "partial"


def revenue_lines(conn, project_ids):
    if not project_ids:
        return []
    ph = ",".join("?" * len(project_ids))
    return [dict(r) for r in conn.execute(
        "SELECT l.id AS line_id, l.entry_id, l.project_id, l.credit AS amount, l.description AS line_desc,"
        " e.date, e.entry_no, e.source, e.description AS entry_desc, e.company_id,"
        " a.code AS acc_code, a.name AS acc_name"
        " FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id"
        " JOIN accounts a ON a.id = l.account_id"
        " WHERE a.type = 'revenue' AND l.credit > 0 AND e.status = 'posted'"
        " AND l.project_id IN (%s) ORDER BY e.date, l.id" % ph, list(project_ids))]


def _receipt(l):
    return {"line_id": l["line_id"], "entry_id": l["entry_id"], "entry_no": l["entry_no"], "date": l["date"],
            "amount": round(l["amount"], 2), "source": l["source"], "account": "%s %s" % (l["acc_code"], l["acc_name"]),
            "desc": l["line_desc"] or l["entry_desc"] or ""}


def match(conn, tracks):
    """tracks: dicts with id, project_id, amount, status, phase_index.
    -> {"tracks": {tid: {...}}, "unmatched": [...], "pending": n}"""
    by_project = {}
    for t in tracks:
        if t.get("project_id"):
            by_project.setdefault(t["project_id"], []).append(t)
    lines = revenue_lines(conn, list(by_project))
    decided = {r["line_id"]: dict(r) for r in conn.execute(
        "SELECT line_id, tracker_id, kind, amount, author, created_at FROM money_receipts")} if lines else {}
    out = {t["id"]: {"received": 0.0, "receipts": [], "suggestion": None} for t in tracks}
    unmatched, pending = [], 0
    for pid, plist in by_project.items():
        plines = [l for l in lines if l["project_id"] == pid]
        free = []
        for l in plines:
            d = decided.get(l["line_id"])
            if not d:
                free.append(l)
            elif d["kind"] in ("paid", "partial") and d["tracker_id"] in out:
                o = out[d["tracker_id"]]
                o["received"] = round(o["received"] + l["amount"], 2)
                o["receipts"].append(dict(_receipt(l), kind=d["kind"], by=d["author"], at=d["created_at"]))
        # invoices closed by hand, with no validated line, used the earliest money
        done_unlinked = sum(t["amount"] or 0 for t in plist
                            if t["status"] == "done" and not out[t["id"]]["receipts"])
        used, cands = 0.0, []
        for l in free:
            if used + l["amount"] / 2.0 <= done_unlinked:
                used += l["amount"]
            else:
                cands.append(l)
        pool = sorted([t for t in plist if t["status"] in OPEN],
                      key=lambda t: (-(t.get("phase_index") or 0), t["id"]))
        # closest amounts pair up first (a 97.1 jt payment goes to the 97 jt
        # invoice, not whichever came first); ties go to the earlier payment
        rem = {t["id"]: max(0.0, (t["amount"] or 0) - out[t["id"]]["received"]) for t in pool}
        pairs = sorted(((abs(rem[t["id"]] - l["amount"]) / max(rem[t["id"]], 1.0), l["date"], i, t["id"])
                        for i, l in enumerate(cands) for t in pool), key=lambda x: x[:3])
        given, taken = {}, set()
        for _, _, i, tid in pairs:
            if i not in given and tid not in taken:
                given[i] = tid
                taken.add(tid)
        for i, l in enumerate(cands):
            r = _receipt(l)
            if i in given:
                tid = given[i]
                r.update({"remaining": round(rem[tid], 2), "diff": round(l["amount"] - rem[tid], 2),
                          "fit": _fit(l["amount"], rem[tid])})
                out[tid]["suggestion"] = r
                pending += 1
            else:
                # every open invoice already has a payment waiting (validate it and
                # this one moves up), or the project has no open invoice at all
                r.update({"project_id": pid, "reason": "queued" if pool else "no_open"})
                unmatched.append(r)
    return {"tracks": out, "unmatched": unmatched, "pending": pending}
