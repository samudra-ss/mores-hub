"""Remuneration - who earns what from a project (v1.12).

Per project. Shares use the project's ACTUAL gross profit (posted revenue minus
every expense line tagged to it, the same basis as the close-out report).
Bringer fees use the project VALUE (its contract value in Project Details, or
its revenue when no contract value is set).

The scheme table is the company's policy sheet:

  Scheme         Project value      Min GP  Office  Team pool         Bringer  Partner / BOD
  Type 1         partner deal       -       60%     15%               -        Partner 25%
  Type 2 Low     < Rp100m           40%     75%     25%               2%       -
  Type 2 Medium  Rp100m - Rp1bn     35%     80%     20%               2.5%     -
  Type 2 High    Rp1bn - Rp5bn      32.5%   75%     25%               3%       -
  Type 3 Low     < Rp500m           -       75%     25% team + BOD    -        within 25%
  Type 3 High    >= Rp500m          -       60%     25%               -        BOD 15%
  STP            Type 2 > Rp5bn,    -       not set 5-10% of GP       not set  not set
                 or BOD-defined

Type 1: the partner is PM; the office is fixed at 60%. Type 2: Finance sets the
PM. An agent, if used, takes 2.5% of the project value out of the office's
share. The minimum GP decides whether the team pool is paid; the bringer award
does not depend on it.

The team pool is split by points: each member's grade weight times their
involvement on the project.
"""
import json
import random

TYPES = (("t1", "Type 1 — partner deal"), ("t2", "Type 2 — Finance sets PM"),
         ("t3", "Type 3"), ("stp", "STP — BOD-defined"))
TYPE_KEYS = tuple(k for k, _ in TYPES)
ROLES = ("pm", "team", "bringer", "partner", "bod")

DEFAULT_GRADES = [
    {"grade": 1, "code": "G1", "title": "Analyst", "weight": 1.0},
    {"grade": 2, "code": "G2", "title": "Consultant", "weight": 1.5},
    {"grade": 3, "code": "G3", "title": "Project Manager", "weight": 2.0},
    {"grade": 4, "code": "G4", "title": "Partner", "weight": 3.0},
]

# value bounds are in rupiah; None = no bound
DEFAULT_SCHEMES = [
    {"key": "t1", "type": "t1", "label": "Type 1", "value_label": "Partner deal",
     "min_gp": None, "office": 0.60, "pool": 0.15, "bringer": None, "partner": 0.25, "bod": None},
    {"key": "t2_low", "type": "t2", "label": "Type 2 Low", "value_label": "< Rp100m",
     "min_gp": 0.40, "office": 0.75, "pool": 0.25, "bringer": 0.02, "partner": None, "bod": None},
    {"key": "t2_med", "type": "t2", "label": "Type 2 Medium", "value_label": "Rp100m – Rp1bn",
     "min_gp": 0.35, "office": 0.80, "pool": 0.20, "bringer": 0.025, "partner": None, "bod": None},
    {"key": "t2_high", "type": "t2", "label": "Type 2 High", "value_label": "Rp1bn – Rp5bn",
     "min_gp": 0.325, "office": 0.75, "pool": 0.25, "bringer": 0.03, "partner": None, "bod": None},
    {"key": "t3_low", "type": "t3", "label": "Type 3 Low", "value_label": "< Rp500m",
     "min_gp": None, "office": 0.75, "pool": 0.25, "bringer": None, "partner": None, "bod": None,
     "pool_with_bod": True},
    {"key": "t3_high", "type": "t3", "label": "Type 3 High", "value_label": "≥ Rp500m",
     "min_gp": None, "office": 0.60, "pool": 0.25, "bringer": None, "partner": None, "bod": 0.15},
    {"key": "stp", "type": "stp", "label": "STP", "value_label": "Type 2 > Rp5bn, or BOD-defined",
     "min_gp": None, "office": None, "pool": None, "bringer": None, "partner": None, "bod": None},
]
EDITABLE = ("min_gp", "office", "pool", "bringer", "partner", "bod")
AGENT_RATE = 0.025
STP_RANGE = (0.05, 0.10)
T2_LOW_MAX, T2_MED_MAX, T2_HIGH_MAX, T3_LOW_MAX = 100e6, 1e9, 5e9, 500e6


def _setting(conn, key):
    row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    try:
        return json.loads(row[0]) if row and row[0] else None
    except ValueError:
        return None


def config(conn):
    """Grades and schemes with any overrides from Settings applied."""
    grades = [dict(g) for g in DEFAULT_GRADES]
    for g in grades:
        o = (_setting(conn, "remu_grades") or {}).get(str(g["grade"])) or {}
        if o.get("title"):
            g["title"] = str(o["title"])
        if o.get("weight") is not None:
            g["weight"] = float(o["weight"])
    schemes = [dict(s) for s in DEFAULT_SCHEMES]
    over = _setting(conn, "remu_schemes") or {}
    for s in schemes:
        for k, v in (over.get(s["key"]) or {}).items():
            if k in EDITABLE:
                s[k] = None if v is None else float(v)
    agent = (_setting(conn, "remu_agent_rate") or {}).get("rate", AGENT_RATE)
    return {"grades": grades, "schemes": schemes, "agent_rate": float(agent), "types": [list(t) for t in TYPES],
            "roles": list(ROLES), "stp_range": list(STP_RANGE)}


def scheme_key(remu_type, value):
    """Type 1 / 2 / 3 / STP plus the project value -> the scheme row."""
    v = value or 0
    if remu_type == "t1":
        return "t1"
    if remu_type == "t2":
        if v < T2_LOW_MAX:
            return "t2_low"
        if v <= T2_MED_MAX:
            return "t2_med"
        if v <= T2_HIGH_MAX:
            return "t2_high"
        return "stp"                # Type 2 above Rp 5 bn is a special project
    if remu_type == "t3":
        return "t3_low" if v < T3_LOW_MAX else "t3_high"
    if remu_type == "stp":
        return "stp"
    return None


def project_figures(conn, company_ids, year=None):
    """Per project in scope: actual revenue, cost and gross profit (whole life,
    or one year), and its value - contract value, else revenue."""
    ph = ",".join("?" * len(company_ids))
    year_cond = " AND strftime('%Y', je.date) = ?" if year else ""
    params = ([str(year)] if year else []) + list(company_ids)
    rows = conn.execute(
        "SELECT p.id, p.code, p.name, p.status, p.company_id, c.code AS company_code,"
        " p.contract_value, p.remu_type, p.remu_stp_pct, p.remu_agent, p.type_id,"
        " pt.name AS type_name, pt.color AS type_color,"
        " COALESCE(SUM(CASE WHEN a.type='revenue' THEN jl.credit - jl.debit END), 0) AS revenue,"
        " COALESCE(SUM(CASE WHEN a.type='expense' THEN jl.debit - jl.credit END), 0) AS cost"
        " FROM projects p JOIN companies c ON c.id = p.company_id"
        " LEFT JOIN project_types pt ON pt.id = p.type_id"
        " LEFT JOIN journal_lines jl ON jl.project_id = p.id"
        " LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted'" + year_cond +
        " LEFT JOIN accounts a ON a.id = jl.account_id AND je.id IS NOT NULL"
        " WHERE p.company_id IN (%s) GROUP BY p.id ORDER BY c.code, p.code" % ph, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["revenue"], d["cost"] = round(d["revenue"], 2), round(d["cost"], 2)
        d["gp"] = round(d["revenue"] - d["cost"], 2)
        d["margin"] = round(d["gp"] / d["revenue"], 4) if d["revenue"] else None
        cv = d["contract_value"] or 0
        d["value"], d["value_source"] = (round(cv, 2), "contract") if cv > 0 else (d["revenue"], "revenue")
        out.append(d)
    return out


def _share(amount, people):
    """Split an amount equally over the people named for it."""
    if not people:
        return []
    each = round(amount / len(people), 2)
    return [(p, each) for p in people]


def compute(fig, team, people, cfg):
    """One project's remuneration.

    fig: a project_figures row (gp, revenue, value, remu_type, remu_stp_pct,
    remu_agent); team: [{person_id, role, involvement}]; people: {id: {name,
    grade}}; cfg: config(). Returns the scheme, every amount and each person's
    payout."""
    key = scheme_key(fig.get("remu_type"), fig.get("value"))
    out = {"scheme_key": key, "scheme": None, "gp": fig["gp"], "revenue": fig["revenue"], "value": fig["value"],
           "value_source": fig.get("value_source", "contract"), "margin": fig.get("margin"),
           "eligible": None, "office": 0.0, "agent_fee": 0.0, "office_net": 0.0, "pool": 0.0, "pool_pct": None,
           "partner": 0.0, "bod": 0.0, "bringer": 0.0, "undecided": 0.0, "payouts": [], "unpaid": [], "notes": []}
    if not key:
        out["notes"].append("No remuneration scheme yet - pick one on the plan.")
        return out
    s = next(x for x in cfg["schemes"] if x["key"] == key)
    out["scheme"] = {k: s.get(k) for k in ("key", "type", "label", "value_label") + EDITABLE}
    if fig.get("remu_type") == "t2" and key == "stp":
        out["notes"].append("Type 2 above Rp 5 bn is a special project (STP).")
    gp = max(0.0, fig["gp"] or 0)
    if (fig["gp"] or 0) <= 0:
        out["notes"].append("No gross profit yet - nothing to share.")
    grade = {g["grade"]: g for g in cfg["grades"]}
    by_role = {r: [m for m in team if m["role"] == r] for r in ROLES}

    # the team pool, and whether the project earned it
    if key == "stp":
        pct = fig.get("remu_stp_pct")
        pct = STP_RANGE[0] if pct in (None, "") else max(STP_RANGE[0], min(STP_RANGE[1], float(pct) / 100))
        out["pool_pct"] = pct
        out["pool"] = round(gp * pct, 2)
        out["undecided"] = round(gp - out["pool"], 2)      # office and the rest: BOD sets it
        out["notes"].append("STP: the team pool is %.1f%% of GP; the office and the rest are set by the BOD." % (pct * 100))
    else:
        out["pool_pct"] = s["pool"]
        out["office"] = round(gp * (s["office"] or 0), 2)
        if s.get("min_gp") is not None and fig.get("margin") is not None:
            out["eligible"] = fig["margin"] >= s["min_gp"] - 1e-9
        elif s.get("min_gp") is not None:
            out["eligible"] = False
        pool = round(gp * (s["pool"] or 0), 2)
        if out["eligible"] is False:
            out["notes"].append("GP margin %s is below the %.1f%% minimum - the team pool is not paid."
                                % ("n/a" if fig.get("margin") is None else "%.1f%%" % (fig["margin"] * 100), s["min_gp"] * 100))
            pool = 0.0
        out["pool"] = pool
        out["partner"] = round(gp * (s.get("partner") or 0), 2)
        out["bod"] = round(gp * (s.get("bod") or 0), 2)
    # bringer: a share of the project VALUE, whatever the GP did
    if s.get("bringer"):
        out["bringer"] = round((fig["value"] or 0) * s["bringer"], 2)
    # an agent is paid out of the office's share
    if (fig.get("remu_agent") or "").strip():
        out["agent_fee"] = round((fig["value"] or 0) * cfg["agent_rate"], 2)
        out["notes"].append("Agent %s: %.1f%% of the project value, from the office's share."
                            % (fig["remu_agent"].strip(), cfg["agent_rate"] * 100))
    out["office_net"] = round(out["office"] - out["agent_fee"], 2)

    # the pool by points: grade weight x involvement
    members = by_role["pm"] + by_role["team"] + (by_role["bod"] if s.get("pool_with_bod") else [])
    pts = []
    for m in members:
        p = people.get(m["person_id"])
        if not p:
            continue
        w = grade.get(p["grade"], {"weight": 1.0})["weight"]
        pts.append((m, round(w * float(m.get("involvement") or 100) / 100.0, 4)))
    total_pts = sum(x[1] for x in pts)
    for m, pt in pts:
        out["payouts"].append({"person_id": m["person_id"], "role": m["role"], "kind": "pool", "points": pt,
                               "amount": round(out["pool"] * pt / total_pts, 2) if total_pts else 0.0})
    if out["pool"] and not pts:
        out["unpaid"].append({"kind": "pool", "amount": out["pool"], "why": "no team members on the project"})
    for kind, role in (("partner", "partner"), ("bod", "bod"), ("bringer", "bringer")):
        amt = out[kind]
        if not amt:
            continue
        named = [m for m in by_role[role] if m["person_id"] in people]
        if kind == "bod" and s.get("pool_with_bod"):
            continue
        for m, each in _share(amt, named):
            out["payouts"].append({"person_id": m["person_id"], "role": role, "kind": kind, "points": None, "amount": each})
        if not named:
            out["unpaid"].append({"kind": kind, "amount": amt, "why": "nobody named as %s" % role})
    for po in out["payouts"]:
        p = people.get(po["person_id"]) or {}
        po["name"] = p.get("name")
        po["grade"] = p.get("grade")
    return out


# ---- simulation ---------------------------------------------------------------
FIRST = ["Adi", "Bima", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hana", "Indra", "Joko", "Kirana", "Laras",
         "Maya", "Nanda", "Oki", "Putri", "Raka", "Sari", "Tegar", "Wulan", "Yoga", "Zahra", "Bayu", "Intan",
         "Reza", "Anisa", "Dimas", "Nadia", "Arif", "Salsa"]
LAST = ["Pratama", "Wijaya", "Saputra", "Lestari", "Nugroho", "Kusuma", "Hidayat", "Siregar", "Santoso",
        "Permana", "Utami", "Halim", "Setiawan", "Rahmawati", "Gunawan", "Ramadhan", "Purnama", "Wibowo"]


def random_people(n, seed):
    """n made-up consultants with a believable grade mix (more analysts than partners)."""
    rnd = random.Random(seed)
    names = set()
    while len(names) < n:
        names.add("%s %s" % (rnd.choice(FIRST), rnd.choice(LAST)))
    mix = [1, 1, 2, 2, 3, 1, 2, 4, 3, 1, 2, 2, 3, 4, 1, 2]
    return [{"key": "s%d" % i, "name": nm, "grade": mix[i % len(mix)]} for i, nm in enumerate(sorted(names))]


def random_team(rtype, people, rnd):
    """A plausible team for one project from the simulated people."""
    by_grade = {}
    for p in people:
        by_grade.setdefault(p["grade"], []).append(p)
    pick = lambda g: rnd.choice(by_grade.get(g) or people)
    team = []
    used = set()

    def add(p, role, inv):
        if (p["key"], role) not in used:
            used.add((p["key"], role))
            team.append({"person_key": p["key"], "role": role, "involvement": inv})
    if rtype == "t1":
        add(pick(4), "partner", 100)
    else:
        add(pick(3), "pm", 100)
    for _ in range(rnd.randint(1, 3)):
        add(pick(rnd.choice([1, 1, 2])), "team", rnd.choice([50, 75, 100]))
    if rtype == "t2":
        add(rnd.choice(people), "bringer", 100)
    if rtype == "t3":
        add(pick(4), "bod", 100)
    return team
