"""RAB ROT - the project cost plan behind a project's remuneration (v1.13).

The form follows the "PROJECT RAB ROT ACTUAL" sheet (ROT Outlook Parekraf 2026)
line for line, so Finance fills in the same thing they filled in Excel:

  A. Biaya Langsung Personil       - experts and support staff
  B. Biaya Langsung Non Personil   - printing, operations, ...
     line total  = Harga Satuan x JMLH x SAT x VOL
     % to COGS   = line total / TOTAL COST AWAL
  TOTAL COST AWAL                  = sum of the lines
  + maksimal (belum tax)           = a contingency on top
  TOTAL COST COGS
  SERVICE FEE                      = 10% of the net project value
  PROJECT SAVING FEE (PSC)         = 5% of the net project value
  PROFIT ELEMENT                   = net value - COGS - service fee - PSC
  TOTAL PROJECT COST               = the net project value

  Project value (Nilai Anggaran)   = what each PT bills, tax included
  - PPN 11%                        = value x 11/111
  - PPh 23 2%                      = 2% of DPP (value before PPN)
  = Net Project Value              = value x 98/111 (88.29%)

  NILAI CUAN TERPREDIKSI (NCT)     = service fee + PSC + profit = net - COGS

Finance Review: Finance may write its own figure next to any line (what the
deal really costs, e.g. with PPh 21 on top). The reviewed COGS and the NCT on
it decide the status - GREEN / AMBER / RED.

PPh 23 note: the sheet's own formula (value x 2/102) treats the withholding as
if it were on the gross amount. PPh 23 is withheld on DPP, the value before
PPN, which is what the Finance Review's 88.29% already assumes. The form uses
DPP; "excel" reproduces the old sheet for reconciling with it.
"""
import json
import re

PPN_RATE = 0.11
PPH23_RATE = 0.02
SERVICE_FEE_RATE = 0.10
PSC_RATE = 0.05
TAX_METHODS = ("dpp", "excel")
STATUSES = ("draft", "review", "approved")
SECTIONS = (("A", "BIAYA LANGSUNG PERSONIL"), ("B", "BIAYA LANGSUNG NON PERSONIL"))
# the NCT margin the status reads: GREEN at or above the scheme's minimum GP
# (40% when the scheme has none), AMBER up to 10 points below it, RED under that
DEFAULT_GREEN = 0.40
AMBER_BAND = 0.10


def _num(v, default=0.0):
    if v in (None, ""):
        return default
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("Rp", "").replace(" ", "")
    # Indonesian style 1.250.000,50 -> 1250000.50
    if re.match(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return default


def blank_plan():
    """A new, empty plan with the sheet's structure and rates."""
    return {
        "project_name": "", "client": "", "year": 2027, "notes": "",
        "lines": [
            {"section": "A", "group": "Biaya Tenaga Ahli", "label": "", "name": "", "qty": 1, "sat": 1, "vol": 1,
             "unit_price": 0, "review": None, "review_note": ""},
            {"section": "A", "group": "Biaya Tenaga Pendukung", "label": "", "name": "", "qty": 1, "sat": 1, "vol": 1,
             "unit_price": 0, "review": None, "review_note": ""},
            {"section": "B", "group": "", "label": "", "name": "LS", "qty": 1, "sat": 1, "vol": 1,
             "unit_price": 0, "review": None, "review_note": ""},
        ],
        "contingency": 0,
        "entities": [{"name": "PT 1 : Mores", "amount": 0}],
        "rates": {"ppn": PPN_RATE, "pph23": PPH23_RATE, "service_fee": SERVICE_FEE_RATE, "psc": PSC_RATE},
        "tax_method": "dpp",
        "remu_type": "t2",
        "team": [],
    }


def clean(data):
    """Normalise a plan sent by the form: numbers are numbers, unknown keys go."""
    d = blank_plan()
    data = data or {}
    for k in ("project_name", "client", "notes"):
        d[k] = str(data.get(k) or "").strip()
    d["year"] = int(_num(data.get("year"), 2027)) or 2027
    lines = []
    for ln in data.get("lines") or []:
        sec = "B" if str(ln.get("section") or "A").upper().startswith("B") else "A"
        rv = ln.get("review")
        lines.append({
            "section": sec, "group": str(ln.get("group") or "").strip(),
            "label": str(ln.get("label") or "").strip(), "name": str(ln.get("name") or "").strip(),
            "qty": _num(ln.get("qty"), 1), "sat": _num(ln.get("sat"), 1), "vol": _num(ln.get("vol"), 1),
            "unit_price": _num(ln.get("unit_price")),
            "review": None if rv in (None, "") else _num(rv),
            "review_note": str(ln.get("review_note") or "").strip(),
        })
    d["lines"] = lines
    d["contingency"] = _num(data.get("contingency"))
    d["entities"] = [{"name": str(e.get("name") or "").strip(), "amount": _num(e.get("amount"))}
                     for e in (data.get("entities") or [])]
    r = data.get("rates") or {}
    d["rates"] = {k: _num(r.get(k), v) for k, v in
                  (("ppn", PPN_RATE), ("pph23", PPH23_RATE), ("service_fee", SERVICE_FEE_RATE), ("psc", PSC_RATE))}
    for k, v in d["rates"].items():
        if not 0 <= v < 1:
            raise ValueError("Rate %s must be between 0%% and 100%%" % k)
    d["tax_method"] = data.get("tax_method") if data.get("tax_method") in TAX_METHODS else "dpp"
    rt = data.get("remu_type")
    d["remu_type"] = rt if rt in ("t1", "t2", "t3", "stp") else None
    team = []
    for m in data.get("team") or []:
        try:
            pid = int(m.get("person_id"))
        except (TypeError, ValueError):
            continue
        inv = _num(m.get("involvement"), 100)
        team.append({"person_id": pid, "role": m.get("role") or "team", "involvement": max(1.0, min(100.0, inv))})
    d["team"] = team
    return d


def net_factor(rates, method="dpp"):
    """What is left of 1 rupiah billed (tax included) after PPN and PPh 23."""
    ppn, pph = rates["ppn"], rates["pph23"]
    if method == "excel":
        return 1 - ppn / (1 + ppn) - pph / (1 + pph)
    return (1 - pph) / (1 + ppn)


def taxes(gross, rates, method="dpp"):
    ppn_amt = gross * rates["ppn"] / (1 + rates["ppn"])
    dpp = gross - ppn_amt
    pph = gross * rates["pph23"] / (1 + rates["pph23"]) if method == "excel" else dpp * rates["pph23"]
    return {"gross": gross, "dpp": dpp, "ppn": ppn_amt, "pph23": pph, "net": gross - ppn_amt - pph}


def status_for(margin, green):
    if margin is None:
        return "none"
    if margin >= green - 1e-9:
        return "green"
    if margin >= green - AMBER_BAND - 1e-9:
        return "amber"
    return "red"


def compute(plan, remu_cfg=None):
    """Every figure of the sheet, from a clean() plan.

    remu_cfg: remuneration.config(), to read the scheme's minimum GP as the
    GREEN line. Without it the status reads 40%."""
    rates, method = plan["rates"], plan["tax_method"]
    lines = []
    for i, ln in enumerate(plan["lines"]):
        total = ln["unit_price"] * ln["qty"] * ln["sat"] * ln["vol"]
        lines.append({**ln, "index": i, "total": total,
                      "reviewed": total if ln["review"] is None else ln["review"]})
    cost_awal = sum(x["total"] for x in lines)
    for x in lines:
        x["pct_cogs"] = x["total"] / cost_awal if cost_awal else 0.0
    cogs = cost_awal + plan["contingency"]

    gross = sum(e["amount"] for e in plan["entities"])
    tx = taxes(gross, rates, method)
    net = tx["net"]
    fee = net * rates["service_fee"]
    psc = net * rates["psc"]
    profit = net - cogs - fee - psc
    nct = fee + psc + profit
    pct = (lambda v: v / net) if net else (lambda v: None)

    # per section / group subtotals, in the order they appear
    sections = []
    for key, title in SECTIONS:
        rows = [x for x in lines if x["section"] == key]
        groups = []
        for x in rows:
            if not groups or groups[-1]["group"] != x["group"]:
                groups.append({"group": x["group"], "lines": [], "total": 0.0, "reviewed": 0.0})
            groups[-1]["lines"].append(x)
            groups[-1]["total"] += x["total"]
            groups[-1]["reviewed"] += x["reviewed"]
        sections.append({"key": key, "title": title, "groups": groups,
                         "total": sum(x["total"] for x in rows), "reviewed": sum(x["reviewed"] for x in rows)})

    # Finance Review: each PT's net, less the reviewed COGS
    nf = net_factor(rates, method)
    entities = [{**e, "net": e["amount"] * nf, "share": e["amount"] / gross if gross else 0.0}
                for e in plan["entities"]]
    review_cogs = sum(x["reviewed"] for x in lines) + plan["contingency"]
    review_nct = net - review_cogs
    review_margin = review_nct / net if net else None
    reviewed_lines = sum(1 for x in lines if x["review"] is not None)

    # the status line: the remuneration scheme's minimum GP, else 40%
    green, scheme_label = DEFAULT_GREEN, None
    if remu_cfg and plan.get("remu_type"):
        import remuneration
        key = remuneration.scheme_key(plan["remu_type"], gross)
        s = next((x for x in remu_cfg["schemes"] if x["key"] == key), None)
        if s:
            scheme_label = s["label"]
            if s.get("min_gp") is not None:
                green = s["min_gp"]
    return {
        "lines": lines, "sections": sections,
        "cost_awal": cost_awal, "contingency": plan["contingency"], "cogs": cogs,
        "service_fee": fee, "psc": psc, "profit": profit, "total_project_cost": net,
        "pct": {"cogs": pct(cogs), "service_fee": pct(fee), "psc": pct(psc), "profit": pct(profit),
                "total": 1.0 if net else None},
        "value": gross, "dpp": tx["dpp"], "ppn": tx["ppn"], "pph23": tx["pph23"], "net": net,
        "net_factor": nf, "tax_method": method,
        "nct": nct, "nct_pct": pct(nct),
        "entities": entities,
        "review": {"cogs": review_cogs, "nct": review_nct, "margin": review_margin,
                   "lines_reviewed": reviewed_lines, "delta": review_cogs - cogs,
                   "status": status_for(review_margin, green), "green_at": green,
                   "amber_at": max(0.0, green - AMBER_BAND), "scheme": scheme_label},
        # what the sheet's old PPh 23 formula would say, for reconciling with it
        "excel_net": taxes(gross, rates, "excel")["net"],
    }


def remuneration_preview(plan, calc, people, remu_cfg):
    """The remuneration this plan would pay if the reviewed numbers hold:
    revenue = net project value, cost = reviewed COGS, value = billed value."""
    import remuneration
    rev, cost = calc["net"], calc["review"]["cogs"]
    gp = rev - cost
    fig = {"gp": round(gp, 2), "revenue": round(rev, 2), "value": round(calc["value"], 2),
           "value_source": "contract", "margin": round(gp / rev, 4) if rev else None,
           "remu_type": plan.get("remu_type"), "remu_stp_pct": None, "remu_agent": ""}
    team = [m for m in plan.get("team") or [] if m["person_id"] in people]
    return remuneration.compute(fig, team, people, remu_cfg)


# ---- import the Excel sheet ------------------------------------------------------
def _cell_text(v):
    return re.sub(r"\s+", " ", str(v or "")).strip()


def import_xlsx(fileobj):
    """Read a "PROJECT RAB ROT" sheet laid out like the Parekraf file into a plan.

    Columns are found by their headings (JENIS BIAYA, Nama, JMLH, SAT, VOL,
    Harga Satuan, FINANCE REVIEW), so a moved column still reads. Values are
    taken as typed, formulas are recomputed by the form."""
    import openpyxl
    wb = openpyxl.load_workbook(fileobj, data_only=True)
    best = None
    for ws in wb.worksheets:
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 40)):
            for c in row:
                if _cell_text(c.value).upper() == "JENIS BIAYA":
                    best = (ws, c.row)
                    break
            if best:
                break
        if best:
            break
    if not best:
        raise ValueError("No RAB ROT sheet found - the file needs a 'JENIS BIAYA' heading")
    ws, hrow = best
    cols = {}
    for r in (hrow, hrow + 1):
        for c in ws[r]:
            t = _cell_text(c.value).upper()
            if not t:
                continue
            for key, test in (("label", t == "JENIS BIAYA"), ("name", t == "NAMA"), ("qty", t == "JMLH"),
                              ("sat", t == "SAT"), ("vol", t == "VOL"), ("price", t.startswith("HARGA SATUAN")),
                              ("total", t.startswith("TOTAL TRANS")), ("review", t.startswith("FINANCE REVIEW"))):
                if test and key not in cols:
                    cols[key] = c.column
    for need in ("label", "price"):
        if need not in cols:
            raise ValueError("The sheet has no '%s' column" % ("JENIS BIAYA" if need == "label" else "Harga Satuan"))
    num_col = cols["label"] - 1          # 'A.' / 1 / 'a' sit just left of JENIS BIAYA
    rev_col = cols.get("review")
    note_col = rev_col                     # Finance's note sits under the heading, its figure one column right
    rev_amt_col = rev_col + 1 if rev_col else None   # FINANCE REVIEW heading is merged over note + amount

    plan = blank_plan()
    plan["lines"], plan["entities"] = [], []
    # the project name sits above the table
    for r in range(1, hrow):
        for c in ws[r]:
            t = _cell_text(c.value)
            m = re.match(r"(?i)project\s*name\s*:?\s*(.+)", t)
            if m:
                plan["project_name"] = m.group(1).strip()
                y = re.search(r"(20\d\d)", plan["project_name"])
                if y:
                    plan["year"] = int(y.group(1))

    merged = {}
    if rev_amt_col:
        for rng in ws.merged_cells.ranges:
            if rng.min_col <= rev_amt_col <= rng.max_col:
                merged[rng.min_row] = rng.max_row

    section, group = "A", ""
    by_row = {}
    r = hrow + 2
    stop = None
    while r <= ws.max_row:
        num = _cell_text(ws.cell(r, num_col).value)
        label = _cell_text(ws.cell(r, cols["label"]).value)
        up = label.upper()
        if up.startswith("TOTAL COST AWAL"):
            stop = r
            break
        price = ws.cell(r, cols["price"]).value
        name = _cell_text(ws.cell(r, cols["name"]).value) if "name" in cols else ""
        priced = isinstance(price, (int, float))
        if re.match(r"^[A-Z]\.$", num):                       # A. / B. - a section
            section = "B" if num.upper().startswith("B") else "A"
            group = ""
        elif label and not priced and not name:               # 1 Biaya Tenaga Ahli: - a group
            group = label.rstrip(":").strip()
        elif label and (priced or name):                      # a line (no price = Rp 0, e.g. "include in PhD")
            price = price if priced else 0
            ln = {"section": section, "group": group, "label": label, "name": name,
                  "qty": _num(ws.cell(r, cols["qty"]).value, 1) if "qty" in cols else 1,
                  "sat": _num(ws.cell(r, cols["sat"]).value, 1) if "sat" in cols else 1,
                  "vol": _num(ws.cell(r, cols["vol"]).value, 1) if "vol" in cols else 1,
                  "unit_price": float(price), "review": None, "review_note": ""}
            plan["lines"].append(ln)
            by_row[r] = ln
        r += 1

    # Finance Review amounts: on the line's row, or - when Finance wrote it a
    # row or two lower - on the nearest line above that has none yet. A review
    # merged over several lines is their total: the first line carries it.
    if rev_amt_col:
        line_rows = sorted(by_row)
        spans = []
        for rr in range(hrow + 2, (stop or ws.max_row) + 1):
            v = ws.cell(rr, rev_amt_col).value
            if not isinstance(v, (int, float)):
                continue
            note = _cell_text(ws.cell(rr, note_col).value) if note_col else ""
            if re.match(r"(?i)\s*(nilai cogs|total|nct|rab rot|sp2d)\b", note):
                continue                                     # a total row, not a review
            target = rr if rr in by_row and by_row[rr]["review"] is None else None
            if target is None:
                above = [x for x in line_rows if x <= rr and by_row[x]["review"] is None and by_row[x]["unit_price"]]
                target = above[-1] if above else None
            if target is None:
                continue
            by_row[target]["review"] = float(v)
            by_row[target]["review_note"] = note
            spans.append((target, merged.get(rr, rr)))
        # lines under a merged review that no other review claimed are in it
        for target, end in spans:
            for other in line_rows:
                if target < other <= end and by_row[other]["review"] is None:
                    by_row[other]["review"] = 0.0
                    by_row[other]["review_note"] = "in the review figure above"

    # below the table: the contingency, the PTs' values
    in_entities = False
    for rr in range((stop or hrow) + 1, ws.max_row + 1):
        texts = [_cell_text(c.value) for c in ws[rr]]
        joined = " ".join(t for t in texts if t).upper()
        if "MAKSIMAL" in joined and "total" in cols:
            plan["contingency"] = _num(ws.cell(rr, cols["total"]).value)
        if "TOTAL NILAI ANGGARAN" in joined:
            in_entities = True
            continue
        if in_entities:
            label = _cell_text(ws.cell(rr, cols["label"]).value)
            amt = next((c.value for c in ws[rr] if isinstance(c.value, (int, float)) and c.column > cols["label"]), None)
            if label and amt:
                plan["entities"].append({"name": label, "amount": float(amt)})
            elif not label and plan["entities"]:
                break
    if not plan["entities"]:
        plan["entities"] = [{"name": "PT 1", "amount": 0}]
    return clean(plan)


def dumps(plan):
    return json.dumps(plan, ensure_ascii=False)
