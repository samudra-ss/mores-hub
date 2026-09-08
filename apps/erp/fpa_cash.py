"""MORES HV — cash planning primitives (THE ORACLE, week grain).

Pure functions: no Flask, no globals, no database handles held open. Step 5 of
the Oracle plan (the daily ledger, buffer floors, verdict, sensitivity) imports
this module rather than building a second cash bridge — there must only ever be
one.

The week grain is **(year, month, week_in_month)**, because that is how a project
manager thinks ("Prisma pays in Week 2 November"). It is deliberately NOT the
day-of-year 1..52 scheme used by the existing `cash_budget` table, which does not
line up: week 45 of 2027 starts on 12 November, which most people would call
week 3. Mapping between the two is derived from the dates, never stored.

    week_in_month   days of the month
      1             1  – 7
      2             8  – 14
      3             15 – 21
      4             22 – end of month   (7–10 days: W4 absorbs the remainder)

FOUR weeks to a month, always. The obvious alternative — a 5th bucket for days
29+ — creates a bucket that does not exist in a 28-day February, which means a
cell the UI must disable and a plan that silently loses money in leap years.
Letting W4 run to month end removes that whole class of bug: every month has
exactly four buckets and no bucket is ever empty.
"""
import calendar
import datetime

WEEKS_IN_MONTH = 4   # four weeks a month, W4 runs to month end
CERTAINTIES = ("committed", "planned", "expected", "speculative")
FLOWS = ("in", "out")
CF_CLASSES = ("", "operating", "investing", "financing", "noncash")
SETTLEMENT_MODES = ("pessimistic", "midpoint", "actual_day")


def month_days(year, month):
    return calendar.monthrange(int(year), int(month))[1]


def week_dates(year, month, week):
    """(start_iso, end_iso) for a week bucket. Never None for a valid week now
    that W4 runs to month end — with four buckets a month there is no such thing
    as an empty week, in February or anywhere else."""
    year, month, week = int(year), int(month), int(week)
    if not 1 <= month <= 12 or not 1 <= week <= WEEKS_IN_MONTH:
        return None
    last = month_days(year, month)
    start_day = (week - 1) * 7 + 1
    if start_day > last:
        return None                      # unreachable at 4 weeks; kept as a guard
    end_day = last if week == WEEKS_IN_MONTH else min(week * 7, last)
    return (datetime.date(year, month, start_day).isoformat(),
            datetime.date(year, month, end_day).isoformat())


def settlement_date(year, month, week, flow, mode="pessimistic"):
    """Turn a week bucket into the single date the money moves.

    Fail pessimistic — the middle of the bucket flatters both directions at once:
        outflows land on the FIRST day  (money leaves as early as the week allows)
        inflows  land on the LAST  day  (money arrives as late as the week allows)
    The verdict is always computed on `pessimistic`; the other modes exist only
    for comparison.
    """
    span = week_dates(year, month, week)
    if span is None:
        return None
    start, end = span
    if mode == "midpoint":
        s = datetime.date.fromisoformat(start)
        e = datetime.date.fromisoformat(end)
        return (s + (e - s) / 2).isoformat()
    if mode == "actual_day":            # caller overrides per account; default to pessimistic
        mode = "pessimistic"
    return start if flow == "out" else end


def week_of_date(iso_date):
    """(year, month, week_in_month) for a date — the inverse of week_dates()."""
    d = datetime.date.fromisoformat(str(iso_date)[:10])
    return d.year, d.month, min(WEEKS_IN_MONTH, (d.day - 1) // 7 + 1)


def weeks_of_month(year, month):
    """Every non-empty bucket of a month as
    [{week, start, end, days, label}] — drives the Cash Plan column headers."""
    out = []
    for w in range(1, WEEKS_IN_MONTH + 1):
        span = week_dates(year, month, w)
        if span is None:
            continue
        s, e = span
        days = (datetime.date.fromisoformat(e) - datetime.date.fromisoformat(s)).days + 1
        out.append({"week": w, "start": s, "end": e, "days": days,
                    "label": "W%d" % w,
                    "range": "%s–%s" % (s[8:10].lstrip("0"), e[8:10].lstrip("0"))})
    return out


def year_weeks(year):
    """Every bucket of a fiscal year, in order."""
    out = []
    for m in range(1, 13):
        for w in weeks_of_month(year, m):
            out.append(dict(w, year=int(year), month=m))
    return out


def spread_evenly(amount, buckets):
    """Split an amount across n buckets, cents-exact: the remainder lands on the
    last bucket so the parts always sum back to the whole."""
    n = len(buckets)
    if n <= 0 or not amount:
        return []
    each = round(float(amount) / n, 2)
    parts = [each] * n
    parts[-1] = round(float(amount) - each * (n - 1), 2)
    return parts


# ==========================================================================
# THE ORACLE — Step 5: materialise → daily ledger → floors → verdict
#
# Everything below is a pure function over plain dicts. The verdict is ALWAYS
# taken from the Bound run; Base and Optimistic are context, never the answer.
# ==========================================================================

# Which certainties each run may count. Straight from the plan:
#   bound       inflows: committed only          outflows: committed + planned
#   base        inflows: + expected + weighted   outflows: all
#   optimistic  inflows: all at face value       outflows: committed + planned
RUN_FILTERS = {
    "bound": {"in": ("committed",),
              "out": ("committed", "planned")},
    "base": {"in": ("committed", "expected", "speculative"),
             "out": ("committed", "planned", "expected", "speculative")},
    "optimistic": {"in": ("committed", "planned", "expected", "speculative"),
                   "out": ("committed", "planned")},
}
RUNS = ("bound", "base", "optimistic")

DEFAULT_BUFFER_POLICY = {
    "months_cover": 2.0,
    "absolute_floor": {},          # per company CODE; 0 when unset — deliberately wrong
    "cash_pooling": False,         # the group is safe only if EVERY entity is safe
    "interest_class": "operating",
    "horizon": "fiscal_year",
    "week_settlement": "pessimistic",
    "speculative_weight": 0.5,     # how much of a speculative inflow Base counts
    "default_collection_lag_days": 14,
}

VERDICTS = ("KRITIS", "TOLAK", "WASPADA", "LULUS")
VERDICT_RANK = {"KRITIS": 0, "TOLAK": 1, "WASPADA": 2, "LULUS": 3}
VERDICT_TEXT = {
    "KRITIS": "Critical - cash goes below zero: a payment will not clear",
    "TOLAK": "Reject - cash stays positive but breaks the buffer floor",
    "WASPADA": "Watch - inside the floor but with little room, or Base breaches",
    "LULUS": "Pass - headroom stays above 25% of the floor every day",
}


def _daterange(start_iso, end_iso):
    d = datetime.date.fromisoformat(start_iso)
    end = datetime.date.fromisoformat(end_iso)
    while d <= end:
        yield d.isoformat()
        d += datetime.timedelta(days=1)


def _rp(n):
    return "IDR " + format(int(round(n or 0)), ",d").replace(",", ".")


def item(date, company_id, flow, amount, certainty, source, label,
         cf_class="", deferrable=1, ref=""):
    """One dated cash movement. materialise() returns these; the ledger and the
    remedy engine only ever see this shape."""
    return {"date": str(date)[:10], "company_id": company_id, "flow": flow,
            "amount": round(float(amount or 0), 2), "certainty": certainty,
            "source": source, "label": label, "cf_class": cf_class,
            "deferrable": int(deferrable), "ref": ref}


LIVE_BUDGET = "live"          # what a falsy version_id means: the Budget Center


def resolve_version(conn, version_id, year=None):
    """A plan version, or the pseudo-version standing for the live budget.

    Returns a plain dict for the live case so every `ver["name"]` / `ver["year"]`
    reader downstream keeps working untouched. A dict is deliberate: there is no
    plan_versions row to point at, and inventing a real one would let the copy and
    delete endpoints clone or cascade-delete the live budget.
    """
    if version_id:
        row = conn.execute("SELECT * FROM plan_versions WHERE id=?", (version_id,)).fetchone()
        if row is None:
            raise ValueError("Plan version not found")
        return row
    return {"id": None, "name": "Live budget (Budget Center)",
            "year": int(year or datetime.date.today().year),
            "status": LIVE_BUDGET, "kind": "budget", "company_id": None}


def materialise(conn, version_id, policy=None, year=None, company_ids=None):
    """Every dated cash movement the Oracle should see, from all sources.

    Returns (items, warnings). READ-ONLY — this must never write (test O8).
    """
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    mode = policy.get("week_settlement", "pessimistic")
    items, warnings = [], []

    try:
        ver = resolve_version(conn, version_id, year)
    except ValueError as e:
        return [], [str(e)]
    year = int(year or ver["year"])
    scope = list(company_ids) if company_ids else [
        r["id"] for r in conn.execute("SELECT id FROM companies WHERE is_active=1")]
    if not scope:
        return [], ["No companies in scope"]
    ph = ",".join("?" * len(scope))

    # ---- 1) the weekly plan: the live budget, or a frozen plan version ------
    if version_id:
        for r in conn.execute(
                "SELECT w.*, a.code AS acode, a.name AS aname, a.cash_flow_class AS acls "
                "FROM plan_weeks w JOIN accounts a ON a.id = w.account_id "
                "WHERE w.version_id=? AND w.year=? AND w.company_id IN (%s)" % ph,
                [version_id, year] + scope):
            when = settlement_date(r["year"], r["month"], r["week"], r["flow"], mode)
            if not when:
                continue
            items.append(item(when, r["company_id"], r["flow"], r["amount"], r["certainty"],
                              "plan", "%s %s" % (r["acode"], r["aname"]),
                              r["cf_class"] or r["acls"] or "", 1, "plan:%s" % r["id"]))
    else:
        # The budget carries no direction of its own, so it comes from the account
        # type: revenue is money in, expense is money out. Nothing else has an
        # unambiguous direction, and a noncash line (depreciation) never moves cash
        # at all - counting it would also contradict buffer_floors, which excludes
        # noncash from the floor. Both exclusions are reported, never silent.
        skipped_type, skipped_noncash = {}, {}
        for r in conn.execute(
                "SELECT b.*, a.code AS acode, a.name AS aname, a.type AS atype, "
                "a.cash_flow_class AS acls FROM budgets b JOIN accounts a ON a.id = b.account_id "
                "WHERE b.year=? AND b.company_id IN (%s)" % ph,
                [year] + scope):
            if not r["amount"]:
                continue
            cls = r["cf_class"] or r["acls"] or ""
            if cls == "noncash":
                skipped_noncash[r["acode"]] = round(
                    skipped_noncash.get(r["acode"], 0) + r["amount"], 2)
                continue
            flow = {"revenue": "in", "expense": "out"}.get(r["atype"])
            if not flow:
                skipped_type[r["acode"]] = round(
                    skipped_type.get(r["acode"], 0) + r["amount"], 2)
                continue
            when = settlement_date(r["year"], r["month"], r["week"], flow, mode)
            if not when:
                continue
            items.append(item(when, r["company_id"], flow, r["amount"],
                              r["certainty"] or "planned", "budget",
                              "%s %s" % (r["acode"], r["aname"]), cls, 1,
                              "budget:%s" % r["id"]))
        for code, amt in sorted(skipped_noncash.items()):
            warnings.append(
                "%s on %s is budgeted but classed 'noncash', so it never moves cash and "
                "is not in this forecast. That is deliberate - depreciation does not "
                "empty a bank account." % (_rp(amt), code))
        for code, amt in sorted(skipped_type.items()):
            warnings.append(
                "%s is budgeted on %s, which is neither revenue nor expense, so the "
                "Oracle cannot tell whether it is money in or money out and has left it "
                "out. Plan it in a saved plan version, where direction is explicit."
                % (_rp(amt), code))
        # the same account budgeted at BOTH company level and project level is
        # counted twice here - additive is the right rule for genuinely separate
        # scopes, so the only safe thing is to say when it looks like a roll-up
        for r in conn.execute(
                "SELECT a.code AS acode, COUNT(*) AS n FROM budgets b "
                "JOIN accounts a ON a.id = b.account_id "
                "WHERE b.year=? AND b.company_id IN (%s) AND b.amount<>0 "
                "GROUP BY b.company_id, a.code "
                "HAVING SUM(CASE WHEN b.project_id IS NULL THEN 1 ELSE 0 END) > 0 "
                "AND SUM(CASE WHEN b.project_id IS NOT NULL THEN 1 ELSE 0 END) > 0" % ph,
                [year] + scope):
            warnings.append(
                "%s is budgeted at BOTH company level and project level. Both are counted, "
                "so if the company-level line is a summary of the projects it is being "
                "double counted. Budget each account at one level only." % r["acode"])

    # ---- 2) payables: committed outflows on their due date ------------------
    for r in conn.execute(
            "SELECT id, company_id, vendor, bill_no, due_date, amount, paid "
            "FROM payables WHERE company_id IN (%s)" % ph, scope):
        out = round((r["amount"] or 0) - (r["paid"] or 0), 2)
        if out <= 0.005 or not r["due_date"]:
            continue
        if not str(r["due_date"]).startswith(str(year)):
            continue
        items.append(item(r["due_date"], r["company_id"], "out", out, "committed",
                          "payable", "AP %s %s" % (r["vendor"], r["bill_no"]),
                          "operating", 0, "ap:%s" % r["id"]))

    # ---- 3) receivables: committed inflows, due date + the client's lag -----
    lag_default = int(policy.get("default_collection_lag_days", 14))
    lag_guessed = 0
    for r in conn.execute(
            "SELECT id, company_id, client, invoice_no, due_date, amount, paid, paid_date "
            "FROM receivables WHERE company_id IN (%s)" % ph, scope):
        outstanding = round((r["amount"] or 0) - (r["paid"] or 0), 2)
        if outstanding <= 0.005 or not r["due_date"]:
            continue
        lag, lag_source = lag_default, "default"
        if r["paid_date"]:
            try:
                lag = max(0, (datetime.date.fromisoformat(str(r["paid_date"])[:10])
                              - datetime.date.fromisoformat(str(r["due_date"])[:10])).days)
                lag_source = "observed"
            except ValueError:
                pass
        if lag_source == "default":
            lag_guessed += 1
        try:
            when = (datetime.date.fromisoformat(str(r["due_date"])[:10])
                    + datetime.timedelta(days=lag)).isoformat()
        except ValueError:
            continue
        if not when.startswith(str(year)):
            continue
        it = item(when, r["company_id"], "in", outstanding, "committed", "receivable",
                  "AR %s %s" % (r["client"], r["invoice_no"]), "operating", 0,
                  "ar:%s" % r["id"])
        it["lag_source"] = lag_source
        items.append(it)
    if lag_guessed:
        warnings.append(
            "%d receivable(s) have no recorded payment date, so collection is assumed "
            "%d days after the due date. Record the paid date to replace the guess."
            % (lag_guessed, lag_default))

    # ---- 4) investment commitments, and the undated remainder --------------
    for inv in conn.execute(
            "SELECT id, company_id, name, committed_amount FROM investments "
            "WHERE company_id IN (%s)" % ph, scope).fetchall():
        scheduled = 0.0
        for c in conn.execute(
                "SELECT * FROM investment_commitments WHERE investment_id=?", (inv["id"],)):
            scheduled += c["amount"] or 0
            if int(c["year"]) != year:
                continue
            when = settlement_date(c["year"], c["month"], c["week"], "out", mode)
            if not when:
                continue
            items.append(item(when, inv["company_id"], "out", c["amount"], c["certainty"],
                              "investment", "Investment: %s" % inv["name"],
                              "investing", 0, "ic:%s" % c["id"]))
        already_out = conn.execute(
            "SELECT COALESCE(SUM(amount),0) FROM investment_events "
            "WHERE investment_id=? AND kind='outflow'", (inv["id"],)).fetchone()[0] or 0
        unscheduled = round(max(0.0, (inv["committed_amount"] or 0) - scheduled - already_out), 2)
        if unscheduled <= 0.005:
            continue
        # Money the group is LEGALLY COMMITTED to with NO date. Dropping it makes
        # the Oracle optimistic, the one direction it must never fail in. Spread
        # it evenly across the remaining weeks — and say so, loudly.
        today = datetime.date.today()
        remaining = [w for w in year_weeks(year)
                     if datetime.date.fromisoformat(w["end"]) >= today]
        if not remaining:
            remaining = year_weeks(year)[-1:]
        for w, part in zip(remaining, spread_evenly(unscheduled, remaining)):
            when = settlement_date(w["year"], w["month"], w["week"], "out", mode)
            if not when:
                continue
            it = item(when, inv["company_id"], "out", part, "committed",
                      "investment_unscheduled",
                      "Investment (unscheduled): %s" % inv["name"], "investing", 1,
                      "icu:%s" % inv["id"])
            it["assumed"] = True
            items.append(it)
        warnings.append(
            "%s of investment commitment on %r has no schedule. Spread evenly across "
            "the %d remaining weeks. Set the schedule in the Investment Center to replace "
            "this assumption." % (_rp(unscheduled), inv["name"], len(remaining)))

    items.sort(key=lambda i: (i["date"], i["company_id"]))
    return items, warnings


def filter_run(items, run, policy=None):
    """The items a run may count, with speculative inflows weighted down in Base."""
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    allowed = RUN_FILTERS.get(run, RUN_FILTERS["bound"])
    weight = float(policy.get("speculative_weight", 0.5))
    out = []
    for i in items:
        if i["certainty"] not in allowed[i["flow"]]:
            continue
        j = dict(i)
        if run == "base" and i["flow"] == "in" and i["certainty"] == "speculative":
            j["amount"] = round(i["amount"] * weight, 2)
        out.append(j)
    return out


def opening_cash(conn, company_ids, as_of, cash_codes=None):
    """Posted cash immediately before as_of, using the ONE cash definition
    (reports.cash_condition) so the Oracle and the dashboard cannot disagree."""
    import reports
    ids = list(company_ids)
    ph = ",".join("?" * len(ids))
    cond, cparams = reports.cash_condition(cash_codes, exclude_intercompany=len(ids) > 1)
    row = conn.execute(
        "SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl "
        "JOIN journal_entries je ON je.id = jl.entry_id "
        "JOIN accounts a ON a.id = jl.account_id "
        "WHERE je.status='posted' AND je.company_id IN (%s) AND %s AND je.date < ?"
        % (ph, cond), ids + cparams + [as_of]).fetchone()
    return round(row[0] or 0, 2)


def daily_ledger(items, opening, start, end):
    """[{date, cash_in, cash_out, net, balance}] for every day in the horizon.

    Daily because payables carry real due dates and payroll lands on the 25th.
    The screen aggregates to weeks, but the BREACH DATE stays exact.
    """
    by_day = {}
    for i in items:
        d = i["date"]
        if d < start or d > end:
            continue
        slot = by_day.setdefault(d, [0.0, 0.0])
        slot[0 if i["flow"] == "in" else 1] += i["amount"]
    bal, out = round(opening, 2), []
    for day in _daterange(start, end):
        cin, cout = by_day.get(day, (0.0, 0.0))
        net = round(cin - cout, 2)
        bal = round(bal + net, 2)
        out.append({"date": day, "cash_in": round(cin, 2), "cash_out": round(cout, 2),
                    "net": net, "balance": bal})
    return out


def buffer_floors(conn, company_ids, policy=None, year=None):
    """floor(entity) = max(absolute_floor, months_cover x monthly fixed cash opex)

    Monthly fixed cash opex = trailing 3-month average of posted 6xxx accounts
    classified 'operating' — which EXCLUDES 6500 depreciation, because it is
    classified noncash and never moves cash.
    """
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    months_cover = float(policy.get("months_cover", 2.0))
    abs_floor = policy.get("absolute_floor") or {}
    year = int(year or datetime.date.today().year)
    end = datetime.date.today()
    if end.year != year:
        end = datetime.date(year, 12, 31)
    start = (end - datetime.timedelta(days=92)).isoformat()
    floors, warnings = {}, []
    for cid in company_ids:
        row = conn.execute(
            "SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl "
            "JOIN journal_entries je ON je.id = jl.entry_id "
            "JOIN accounts a ON a.id = jl.account_id "
            "WHERE je.status='posted' AND je.company_id=? AND a.type='expense' "
            "AND a.code LIKE '6%' AND a.cash_flow_class='operating' "
            "AND je.date >= ? AND je.date <= ?",
            (cid, start, end.isoformat())).fetchone()
        monthly = round((row[0] or 0) / 3.0, 2)
        crow = conn.execute("SELECT code FROM companies WHERE id=?", (cid,)).fetchone()
        code = crow["code"] if crow else str(cid)
        # keyed by company CODE (what the policy screen sends); the id is accepted
        # too so a renamed code can never silently drop a company's minimum cash
        floor_abs = float(abs_floor.get(code, abs_floor.get(str(cid), 0)) or 0)
        floors[cid] = {"company_id": cid, "company_code": code,
                       "monthly_fixed_cash_opex": monthly,
                       "absolute_floor": floor_abs,
                       "floor": round(max(floor_abs, months_cover * monthly), 2)}
        if not floor_abs:
            warnings.append(
                "%s has no absolute cash floor set, so it defaults to 0 — almost certainly "
                "wrong. Set it in the buffer policy." % code)
    return floors, warnings


def headroom(ledger, floor):
    return [round(d["balance"] - floor, 2) for d in ledger]


def verdict(bound_ledger, base_ledger, floor):
    """The ladder. Below zero and below the floor are DIFFERENT failures: below
    zero is not a policy breach, it is a bounced payment."""
    if not bound_ledger:
        return "LULUS", {"reason": "nothing planned", "floor": floor}
    min_cash = min(d["balance"] for d in bound_ledger)
    hb = headroom(bound_ledger, floor)
    min_head = min(hb)
    detail = {
        "min_cash": min_cash, "min_headroom": min_head, "floor": floor,
        "worst_date": bound_ledger[hb.index(min_head)]["date"],
        "first_negative_cash": next((d["date"] for d in bound_ledger if d["balance"] < 0), None),
        "first_below_floor": next((d["date"] for d, h in zip(bound_ledger, hb) if h < 0), None),
    }
    base_breach = None
    if base_ledger:
        base_breach = next((d["date"] for d in base_ledger if d["balance"] - floor < 0), None)
    detail["base_first_below_floor"] = base_breach
    if min_cash < 0:
        return "KRITIS", detail
    if min_head < 0:
        return "TOLAK", detail
    if base_breach or min_head < 0.25 * floor:
        return "WASPADA", detail
    return "LULUS", detail


def consolidate(entity_results, policy=None):
    """Requirement 5. With cash_pooling FALSE (the pessimistic reading, and the
    user's answer) the group verdict is the WORST entity verdict, not a verdict
    on the summed line — cash trapped in MLT does not pay MDA's payroll."""
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    pooled = bool(policy.get("cash_pooling"))
    if not entity_results:
        return {"verdict": "LULUS", "cash_pooling": pooled, "entities": []}
    worst = min(entity_results, key=lambda e: VERDICT_RANK.get(e["verdict"], 3))
    return {
        "verdict": worst["verdict"],
        "verdict_text": VERDICT_TEXT.get(worst["verdict"], ""),
        "driven_by": worst["company_code"],
        "cash_pooling": pooled,
        "rule": ("one pooled ledger, one floor, one verdict" if pooled else
                 "the group is safe only if EVERY entity is safe - the group verdict is "
                 "the worst entity verdict, not a verdict on the summed line"),
        "entities": entity_results,
    }


def contributors(items, worst_date, n=5, days=14):
    """The biggest outflows in the fortnight before the worst point."""
    if not worst_date:
        return []
    end = datetime.date.fromisoformat(worst_date)
    start = (end - datetime.timedelta(days=days)).isoformat()
    outs = [i for i in items if i["flow"] == "out" and start <= i["date"] <= worst_date]
    outs.sort(key=lambda i: -i["amount"])
    return outs[:n]


def weekly_view(ledger, year):
    """Aggregate the daily ledger to the week buckets the user plans in."""
    by_date = {d["date"]: d for d in ledger}
    out = []
    for b in year_weeks(year):
        days = [by_date[d] for d in _daterange(b["start"], b["end"]) if d in by_date]
        if not days:
            continue
        out.append({"year": b["year"], "month": b["month"], "week": b["week"],
                    "label": "%02d-%s" % (b["month"], b["label"]),
                    "start": b["start"], "end": b["end"],
                    "cash_in": round(sum(d["cash_in"] for d in days), 2),
                    "cash_out": round(sum(d["cash_out"] for d in days), 2),
                    "ending": days[-1]["balance"],
                    "low": min(d["balance"] for d in days)})
    return out


def consult(conn, version_id, policy=None, company_ids=None, year=None,
            cash_codes=None):
    """The whole answer: per-entity verdicts plus the consolidated one.

    READ-ONLY. Returns a dict ready to serialise.
    """
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    ver = resolve_version(conn, version_id, year)
    year = int(year or ver["year"])
    scope = list(company_ids) if company_ids else [
        r["id"] for r in conn.execute("SELECT id FROM companies WHERE is_active=1")]
    start, end = "%d-01-01" % year, "%d-12-31" % year

    items, warnings = materialise(conn, version_id, policy, year, scope)
    floors, fwarn = buffer_floors(conn, scope, policy, year)
    warnings += fwarn

    entities = []
    for cid in scope:
        mine = [i for i in items if i["company_id"] == cid]
        opening = opening_cash(conn, [cid], start, cash_codes)
        bound = daily_ledger(filter_run(mine, "bound", policy), opening, start, end)
        base = daily_ledger(filter_run(mine, "base", policy), opening, start, end)
        opt = daily_ledger(filter_run(mine, "optimistic", policy), opening, start, end)
        floor = floors[cid]["floor"]
        v, detail = verdict(bound, base, floor)
        entities.append({
            "company_id": cid, "company_code": floors[cid]["company_code"],
            "verdict": v, "verdict_text": VERDICT_TEXT.get(v, ""),
            "opening_cash": opening, "floor": floor,
            "monthly_fixed_cash_opex": floors[cid]["monthly_fixed_cash_opex"],
            "absolute_floor": floors[cid]["absolute_floor"],
            "detail": detail,
            "closing_bound": bound[-1]["balance"] if bound else opening,
            "closing_base": base[-1]["balance"] if base else opening,
            "closing_optimistic": opt[-1]["balance"] if opt else opening,
            "weekly": weekly_view(bound, year),
            "weekly_base": [w["ending"] for w in weekly_view(base, year)],
            "contributors": contributors(mine, detail.get("worst_date")),
            "safe": safe_period(bound, floor),
            "recommend": recommend(filter_run(mine, "bound", policy), bound, floor, policy),
        })

    # A plan seeded straight from the monthly budget is 100% 'planned', and Bound
    # counts NO planned inflow - so the verdict would read KRITIS purely because
    # nothing has been marked as contracted yet. Say that plainly rather than
    # letting the number look like a bug.
    excluded_in = round(sum(i["amount"] for i in items
                            if i["flow"] == "in" and i["certainty"] != "committed"), 2)
    committed_in = round(sum(i["amount"] for i in items
                             if i["flow"] == "in" and i["certainty"] == "committed"), 2)
    if excluded_in > 0 and excluded_in > committed_in * 2:
        warnings.append(
            "%s of planned/expected inflow is NOT counted in the Bound run - only "
            "'committed' money in counts there. A budget line starts life as 'planned', "
            "so a freshly entered budget reads KRITIS by construction, not by bad luck. "
            "Set the certainty of contracted revenue to 'committed' in Budget Center and "
            "the verdict will move. (Committed inflow currently: %s.)"
            % (_rp(excluded_in), _rp(committed_in)))

    group = consolidate(entities, policy)
    group.update({
        "version_id": version_id, "version_name": ver["name"], "year": year,
        "policy": policy, "warnings": warnings, "items": len(items),
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    return group


# ==========================================================================
# Sensitivity, the crisis shock, and recommended actions
#
# The verdict answers "are we safe". Sensitivity answers "how wrong can we be
# before we are not", which is the number management actually needs. It always
# runs on BOUND — running it on Base would report a safety margin that depends
# on money nobody has promised.
# ==========================================================================

SENS_AXES = {
    "revenue_realisation": {
        "label": "Revenue realisation",
        "help": "How much of the planned cash in actually arrives. The budget is a target, not a contract.",
        "levels": [1.0, 0.9, 0.8, 0.7], "unit": "x", "worse": "down",
    },
    "expense_overrun": {
        "label": "Expense overrun",
        "help": "How much more the planned cash out actually costs. Overruns are the norm, not the exception.",
        "levels": [0.0, 0.05, 0.10, 0.20], "unit": "+%", "worse": "up",
    },
    "collection_lag": {
        "label": "Collection lag",
        "help": "Extra days before money in actually lands. 60-day-plus collections are the known weak point.",
        "levels": [0, 15, 30, 45], "unit": "days", "worse": "up",
    },
    "crisis_shock": {
        "label": "Crisis — sudden expense boom",
        "help": "A one-off unbudgeted expense landing at the worst moment, as a share of the year's planned cash out.",
        "levels": [0.0, 0.05, 0.10, 0.20], "unit": "+% of annual out", "worse": "up",
    },
    "investment_timing": {
        "label": "Investment called early",
        "help": "Unscheduled investment commitments pulled into the first half of the year.",
        "levels": [0, 1], "unit": "pulled forward", "worse": "up",
    },
}


def apply_axis(items, axis, level, year=None, crisis_date=None):
    """Return a NEW item list with one axis varied. Never mutates the input."""
    if not level and axis != "revenue_realisation":
        return [dict(i) for i in items]
    out = []
    for i in items:
        j = dict(i)
        if axis == "revenue_realisation" and i["flow"] == "in":
            j["amount"] = round(i["amount"] * float(level), 2)
        elif axis == "expense_overrun" and i["flow"] == "out":
            j["amount"] = round(i["amount"] * (1.0 + float(level)), 2)
        elif axis == "collection_lag" and i["flow"] == "in":
            try:
                j["date"] = (datetime.date.fromisoformat(i["date"])
                             + datetime.timedelta(days=int(level))).isoformat()
            except ValueError:
                pass
        elif axis == "investment_timing" and level and i["source"] == "investment_unscheduled":
            # pull every undated commitment into the first half of the year
            try:
                d = datetime.date.fromisoformat(i["date"])
                if d.month > 6:
                    j["date"] = datetime.date(d.year, ((d.month - 1) % 6) + 1, d.day).isoformat()
            except ValueError:
                pass
        out.append(j)
    if axis == "crisis_shock" and level:
        annual_out = sum(i["amount"] for i in items if i["flow"] == "out")
        shock = round(annual_out * float(level), 2)
        if shock:
            # land it at the worst moment we can find: the day cash is lowest
            when = crisis_date or (("%d-07-01" % year) if year else None)
            by_company = {}
            for i in items:
                by_company[i["company_id"]] = by_company.get(i["company_id"], 0) + (
                    i["amount"] if i["flow"] == "out" else 0)
            total = sum(by_company.values()) or 1
            for cid, share in by_company.items():
                part = round(shock * share / total, 2)
                if part:
                    out.append(item(when, cid, "out", part, "committed", "crisis",
                                    "Crisis: sudden unbudgeted expense", "operating", 1,
                                    "crisis"))
    return out


def _run_axis(conn_items, axis, level, opening_by_company, floors, start, end,
              policy, year, crisis_date=None):
    """Score one axis level: worst headroom and verdict across the entities."""
    varied = apply_axis(conn_items, axis, level, year, crisis_date)
    bound = filter_run(varied, "bound", policy)
    ents, worst_head, first_breach = [], None, None
    for cid, floor in floors.items():
        mine = [i for i in bound if i["company_id"] == cid]
        led = daily_ledger(mine, opening_by_company.get(cid, 0), start, end)
        v, det = verdict(led, [], floor["floor"])
        ents.append({"company_id": cid, "company_code": floor["company_code"], "verdict": v})
        h = det.get("min_headroom")
        if h is not None and (worst_head is None or h < worst_head):
            worst_head = h
        fb = det.get("first_below_floor") or det.get("first_negative_cash")
        if fb and (first_breach is None or fb < first_breach):
            first_breach = fb
    group = consolidate(ents, policy)
    return {"level": level, "min_headroom": worst_head, "verdict": group["verdict"],
            "first_breach": first_breach, "driven_by": group.get("driven_by")}


def sensitivity(conn, version_id, policy=None, company_ids=None, year=None,
                cash_codes=None, axes=None):
    """One-way tornado + break-even + the two-way grid. READ-ONLY (test S3)."""
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    ver = resolve_version(conn, version_id, year)
    year = int(year or ver["year"])
    scope = list(company_ids) if company_ids else [
        r["id"] for r in conn.execute("SELECT id FROM companies WHERE is_active=1")]
    start, end = "%d-01-01" % year, "%d-12-31" % year

    items, warnings = materialise(conn, version_id, policy, year, scope)
    floors, fw = buffer_floors(conn, scope, policy, year)
    warnings += fw
    opening = {cid: opening_cash(conn, [cid], start, cash_codes) for cid in scope}

    base_point = _run_axis(items, "revenue_realisation", 1.0, opening, floors,
                           start, end, policy, year)
    crisis_date = base_point.get("first_breach") or ("%d-07-01" % year)

    wanted = axes or list(SENS_AXES)
    tornado = []
    for axis in wanted:
        spec = SENS_AXES[axis]
        # nothing to vary on this axis? say "not applicable", never a flat zero bar
        if axis == "investment_timing" and not any(
                i["source"] == "investment_unscheduled" for i in items):
            tornado.append({"axis": axis, "label": spec["label"], "help": spec["help"],
                            "unit": spec["unit"], "levels": [], "swing": None,
                            "not_applicable": "no unscheduled investment commitments"})
            continue
        rows = [_run_axis(items, axis, lv, opening, floors, start, end, policy, year,
                          crisis_date) for lv in spec["levels"]]
        heads = [r["min_headroom"] for r in rows if r["min_headroom"] is not None]
        tornado.append({
            "axis": axis, "label": spec["label"], "help": spec["help"],
            "unit": spec["unit"], "levels": rows,
            "swing": round(max(heads) - min(heads), 2) if len(heads) > 1 else 0.0,
        })
    # widest bar first — that ordering IS the management recommendation
    tornado.sort(key=lambda t: -(t["swing"] or 0))

    # ---- break-even: how far each axis can move before the verdict crosses
    def crosses(axis, level, target):
        r = _run_axis(items, axis, level, opening, floors, start, end, policy, year, crisis_date)
        if target == "floor":
            return VERDICT_RANK.get(r["verdict"], 3) <= VERDICT_RANK["TOLAK"]
        return r["verdict"] == "KRITIS"

    breakevens = []
    for axis, lo, hi, worse_is in (("revenue_realisation", 0.0, 1.0, "low"),
                                   ("expense_overrun", 0.0, 2.0, "high"),
                                   ("crisis_shock", 0.0, 2.0, "high")):
        best = hi if worse_is == "low" else lo      # the no-stress end of the axis
        for target in ("floor", "zero"):
            # already failing with NO stress applied? then there is no margin to
            # report, and a bisected number here would be a fiction
            if crosses(axis, best, target):
                breakevens.append({"axis": axis, "label": SENS_AXES[axis]["label"],
                                   "target": target, "value": None,
                                   "already_breached": True,
                                   "note": "the plan already breaches before any stress "
                                           "is applied - there is no margin to measure"})
                continue
            # Bisect with ONE invariant, whichever way the axis runs: `a` is always
            # a level that breaches and `b` one that does not. Keeping the two ends
            # named by what they mean - rather than by which is numerically larger -
            # is what stops the low-side axis (revenue falling) from being searched
            # backwards, which silently pins its break-even to "no margin at all".
            a, b = (lo, hi) if worse_is == "low" else (hi, lo)
            if not crosses(axis, a, target):
                breakevens.append({"axis": axis, "label": SENS_AXES[axis]["label"],
                                   "target": target, "value": None,
                                   "note": "never crosses within the tested range"})
                continue
            for _ in range(18):                       # bisection, ~1% precision
                mid = (a + b) / 2.0
                a, b = (mid, b) if crosses(axis, mid, target) else (a, mid)
            breakevens.append({"axis": axis, "label": SENS_AXES[axis]["label"],
                               "target": target,
                               "value": round((a + b) / 2.0, 4),
                               "unit": SENS_AXES[axis]["unit"]})

    # ---- two-way grid: revenue realisation x expense overrun
    rev_levels = [1.0, 0.95, 0.9, 0.85, 0.8]
    exp_levels = [0.0, 0.05, 0.10, 0.15, 0.20]
    grid = []
    for rv in rev_levels:
        row = []
        for ex in exp_levels:
            varied = apply_axis(apply_axis(items, "revenue_realisation", rv, year),
                                "expense_overrun", ex, year)
            bound = filter_run(varied, "bound", policy)
            ents = []
            for cid, floor in floors.items():
                led = daily_ledger([i for i in bound if i["company_id"] == cid],
                                   opening.get(cid, 0), start, end)
                v, _d = verdict(led, [], floor["floor"])
                ents.append({"company_id": cid, "company_code": floor["company_code"],
                             "verdict": v})
            row.append(consolidate(ents, policy)["verdict"])
        grid.append({"revenue": rv, "cells": row})

    already = VERDICT_RANK.get(base_point["verdict"], 3) <= VERDICT_RANK["TOLAK"]
    return {
        "version_id": version_id, "version_name": ver["name"], "year": year,
        "run": "bound",
        "base_verdict": base_point["verdict"],
        "base_min_headroom": base_point["min_headroom"],
        "base_already_breached": already,
        "base_note": ("This plan already fails before any stress is applied, so sensitivity "
                      "cannot tell you how much room you have - there is none. Fix the plan "
                      "first (mark contracted revenue as committed, or move the outflows the "
                      "Oracle listed), then come back to see how much shock it can absorb."
                      if already else ""),
        "tornado": tornado, "breakevens": breakevens,
        "grid": {"revenue_levels": rev_levels, "expense_levels": exp_levels, "rows": grid},
        "crisis_date": crisis_date,
        "warnings": warnings,
        "honesty": ("Sensitivity runs on Bound, the same as the verdict. A one-way bar varies "
                    "ONE axis and holds everything else at plan — revenue falling and "
                    "collection slowing usually happen together, and only the two-way grid "
                    "shows that."),
    }


# ---- recommended actions --------------------------------------------------

def safe_period(ledger, floor):
    """How long the plan holds: the last day before the first breach of either
    the floor or zero, and how many weeks that is from the start."""
    if not ledger:
        return {"safe_until": None, "weeks_safe": None, "breach": None, "kind": None}
    first_zero = next((d["date"] for d in ledger if d["balance"] < 0), None)
    first_floor = next((d["date"] for d in ledger if d["balance"] - floor < 0), None)
    breach = min([d for d in (first_zero, first_floor) if d], default=None)
    kind = None
    if breach:
        kind = "zero" if breach == first_zero and (not first_floor or first_zero <= first_floor) else "floor"
        if first_floor and first_zero and first_floor < first_zero:
            kind = "floor"
    if not breach:
        return {"safe_until": ledger[-1]["date"], "weeks_safe": len(ledger) // 7,
                "breach": None, "kind": None}
    start = datetime.date.fromisoformat(ledger[0]["date"])
    bd = datetime.date.fromisoformat(breach)
    prev = (bd - datetime.timedelta(days=1)).isoformat()
    # A breach on day one has no safe period at all. Reporting "safe until
    # 31 Dec 2025" for a 2026 plan is arithmetically true and completely
    # misleading - it reads as a date the plan survives to.
    if bd <= start:
        return {"safe_until": None, "weeks_safe": 0, "never_safe": True,
                "breach": breach, "kind": kind,
                "first_below_floor": first_floor, "first_negative_cash": first_zero}
    return {"safe_until": prev, "weeks_safe": max(0, (bd - start).days // 7),
            "never_safe": False,
            "breach": breach, "kind": kind,
            "first_below_floor": first_floor, "first_negative_cash": first_zero}


def recommend(items, ledger, floor, policy=None, top=5):
    """Plain-sentence actions that would close the gap, biggest lever first.

    Only suggests moving what CAN be moved: committed items and items marked
    deferrable=0 are never proposed for delay.
    """
    policy = dict(DEFAULT_BUFFER_POLICY, **(policy or {}))
    sp = safe_period(ledger, floor)
    if not sp["breach"]:
        return {"needed": 0.0, "safe": sp, "actions": [
            {"kind": "none",
             "text": "No action needed: cash stays above the buffer floor all year on the "
                     "Bound run."}]}
    hb = [d["balance"] - floor for d in ledger]
    gap = round(-min(hb), 2)                       # how much headroom is missing
    worst_date = ledger[hb.index(min(hb))]["date"]
    actions = []

    # 1) delay a deferrable outflow that lands before the worst day
    movable = [i for i in items
               if i["flow"] == "out" and i["deferrable"] and i["date"] <= worst_date
               and i["certainty"] != "committed"]
    movable.sort(key=lambda i: -i["amount"])
    for m in movable[:top]:
        actions.append({
            "kind": "delay", "amount": m["amount"], "date": m["date"], "ref": m.get("ref"),
            "text": "Delay %s (%s, %s) to after %s — it is planned, not committed, and on "
                    "its own covers %s of the %s shortfall."
                    % (_rp(m["amount"]), m["label"], m["date"], worst_date,
                       ("all" if m["amount"] >= gap else "part"), _rp(gap)),
        })
        if m["amount"] >= gap:
            break

    # 2) pull collections in
    late_in = [i for i in items if i["flow"] == "in" and i["date"] <= worst_date]
    if late_in:
        biggest = max(late_in, key=lambda i: i["amount"])
        actions.append({
            "kind": "collect", "amount": biggest["amount"], "date": biggest["date"],
            "text": "Collect %s (%s) earlier than %s — bringing it forward is worth more "
                    "than any cost cut of the same size, because it moves cash into the "
                    "window that breaches."
                    % (_rp(biggest["amount"]), biggest["label"], biggest["date"]),
        })

    # 3) the blunt instrument
    total_out = sum(i["amount"] for i in items
                    if i["flow"] == "out" and i["date"] <= worst_date)
    if total_out:
        pct = min(100, round(100.0 * gap / total_out, 1))
        actions.append({
            "kind": "cut", "amount": gap,
            "text": "Or cut %s%% of every planned outflow before %s (%s of %s). Use this "
                    "only if nothing above can move — an across-the-board cut is the "
                    "least targeted option."
                    % (pct, worst_date, _rp(gap), _rp(total_out)),
        })

    # 4) unscheduled investment money is the hidden lever
    unsched = [i for i in items if i["source"] == "investment_unscheduled"]
    if unsched:
        tot = round(sum(i["amount"] for i in unsched), 2)
        actions.append({
            "kind": "schedule", "amount": tot,
            "text": "Schedule the %s of undated investment commitment in the Investment "
                    "Center. Right now the Oracle has to assume it is spread evenly, and "
                    "that assumption is doing real damage to this verdict."
                    % _rp(tot),
        })
    return {"needed": gap, "worst_date": worst_date, "safe": sp, "actions": actions}
