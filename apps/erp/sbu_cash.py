"""SBU cash brief - the small popup behind each SBU on the CEO Dashboard.

Cash in, cash out and the outflow per project for one SBU in one year. It reads
the same way as the SBU report's cash flow: revenue booked to the SBU's projects
is money in, cost booked to them is money out (depreciation, 65xx, is left out -
it is not cash).

Which projects belong to the SBU: the projects linked to it in its report
settings PLUS every project of its source company. The source company is the
one chosen for the SBU (products.cash_company_id) or, when none is chosen, the
company most of its linked projects belong to. On the real data that is
SIBERNETIKA MEDIA ANTARA (MORES NX): its NX-01..NX-04 projects carry all of the
NX cost, although the entries themselves are booked in MDA - so lines are read
from every company the user may see, not only the source company's books."""
from collections import Counter

NONCASH_PREFIX = ("65",)          # depreciation & amortisation


def _in(ids):
    return ",".join("?" * len(ids))


def source_company(conn, product):
    """(company row or None, how it was decided: 'chosen' | 'linked' | 'none')."""
    cid = product["cash_company_id"] if "cash_company_id" in product.keys() else None
    if cid:
        row = conn.execute("SELECT id, code, name FROM companies WHERE id=?", (cid,)).fetchone()
        if row:
            return dict(row), "chosen"
    linked = [r[0] for r in conn.execute(
        "SELECT p.company_id FROM product_projects pp JOIN projects p ON p.id = pp.project_id"
        " WHERE pp.product_id=?", (product["id"],))]
    if linked:
        top = Counter(linked).most_common(1)[0][0]
        row = conn.execute("SELECT id, code, name FROM companies WHERE id=?", (top,)).fetchone()
        if row:
            return dict(row), "linked"
    return None, "none"


def projects_of(conn, product_id, company_id):
    rows = conn.execute(
        "SELECT p.id, p.code, p.name, p.status, p.company_id, c.code AS company_code, 1 AS linked"
        " FROM product_projects pp JOIN projects p ON p.id = pp.project_id"
        " JOIN companies c ON c.id = p.company_id WHERE pp.product_id=?", (product_id,)).fetchall()
    out = {r["id"]: dict(r) for r in rows}
    if company_id:
        for r in conn.execute(
                "SELECT p.id, p.code, p.name, p.status, p.company_id, c.code AS company_code, 0 AS linked"
                " FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.company_id=?", (company_id,)):
            out.setdefault(r["id"], dict(r))
    return sorted(out.values(), key=lambda p: (p["code"] or "", p["id"]))


def brief(conn, product, company_ids, year):
    src, how = source_company(conn, product)
    projects = projects_of(conn, product["id"], src["id"] if src else None)
    per = {p["id"]: dict(p, cash_in=0.0, cash_out=0.0, lines=0) for p in projects}
    if per and company_ids:
        rows = conn.execute(
            "SELECT jl.project_id, a.code, a.type, jl.debit, jl.credit"
            " FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id"
            " JOIN accounts a ON a.id = jl.account_id"
            " WHERE je.status='posted' AND jl.project_id IN (%s) AND je.company_id IN (%s)"
            " AND je.date BETWEEN ? AND ? AND a.type IN ('revenue', 'expense')"
            % (_in(per), _in(company_ids)),
            list(per) + list(company_ids) + ["%d-01-01" % year, "%d-12-31" % year]).fetchall()
        for r in rows:
            slot = per[r["project_id"]]
            if r["type"] == "revenue":
                slot["cash_in"] += (r["credit"] or 0) - (r["debit"] or 0)
            elif not str(r["code"] or "").startswith(NONCASH_PREFIX):
                slot["cash_out"] += (r["debit"] or 0) - (r["credit"] or 0)
            slot["lines"] += 1
    items = []
    for p in per.values():
        p["cash_in"], p["cash_out"] = round(p["cash_in"], 2), round(p["cash_out"], 2)
        p["net"] = round(p["cash_in"] - p["cash_out"], 2)
        items.append(p)
    items.sort(key=lambda p: (-p["cash_out"], p["code"] or ""))
    cin = round(sum(p["cash_in"] for p in items), 2)
    cout = round(sum(p["cash_out"] for p in items), 2)
    return {"product_id": product["id"], "year": int(year),
            "source_company": src, "source": how,
            "cash_in": cin, "cash_out": cout, "net": round(cin - cout, 2),
            "projects": items}
