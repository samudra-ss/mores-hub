"""(v1.12b) The live Google Sheet behind an SBU.

An SBU can point at a Google Sheet (shared "anyone with the link can view").
The server downloads it as .xlsx - read only, nothing is written back and
nothing is copied into the database - and reads two kinds of tab:

  * the expense register  - "Rincian Pengeluaran" (or Expenses / Biaya ...)
  * the revenue register  - "Pendapatan" (or Revenue / Income ...)

A tab is recognised by its header row (Tanggal/Date + Nominal/Amount), so the
same layout works for every SBU: download the template, fill it, upload it to
Google Drive, open it as a Google Sheet, share it and paste the link.

Columns are found by their header text, in any order:
  Tanggal | GL / Akun | Keterangan | Project | Nominal (Rp) | Referensi / Bukti
  | Nama Akun | Kelompok | Perlakuan
"Perlakuan" (treatment) sorts a line: "... (Laba Rugi)" is an expense, "Capex"
and "Deposit" are balance-sheet items and stay out of the profit.
"""
import io
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime

ALLOWED_HOSTS = ("docs.google.com", "drive.google.com")
CACHE_SECONDS = 300
MAX_BYTES = 25 * 1024 * 1024
_cache = {}
_lock = threading.Lock()


# ---- links ------------------------------------------------------------------

def clean_url(url):
    """A plain http(s) link, or '' - anything else is refused."""
    url = (url or "").strip()
    if not url:
        return ""
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ValueError("A link must start with https://")
    return url


def export_url(url):
    """The .xlsx download behind a Google Sheet / Drive link, or None when the
    link is not something the dashboard can read (a folder, a Doc, any other
    site). Only Google hosts are ever fetched."""
    p = urllib.parse.urlparse((url or "").strip())
    if p.scheme != "https" or p.hostname not in ALLOWED_HOSTS:
        return None
    m = re.match(r"^/spreadsheets/d/([A-Za-z0-9_-]{20,})", p.path)
    if p.hostname == "docs.google.com" and m:
        return "https://docs.google.com/spreadsheets/d/%s/export?format=xlsx" % m.group(1)
    m = re.match(r"^/file/d/([A-Za-z0-9_-]{20,})", p.path)
    fid = m.group(1) if m else (urllib.parse.parse_qs(p.query).get("id") or [None])[0]
    if p.hostname == "drive.google.com" and fid and re.match(r"^[A-Za-z0-9_-]{20,}$", fid):
        return "https://drive.google.com/uc?export=download&id=%s" % fid
    return None


def link_kind(url):
    """What a source link is, for its chip: sheet / drive file / folder / doc / web."""
    p = urllib.parse.urlparse(url or "")
    host, path = p.hostname or "", p.path or ""
    if host == "docs.google.com":
        for k in ("spreadsheets", "document", "presentation", "forms"):
            if path.startswith("/" + k):
                return {"spreadsheets": "sheet", "document": "doc", "presentation": "slides", "forms": "form"}[k]
    if host == "drive.google.com":
        return "folder" if "/folders/" in path else "drive"
    return "web"


def _download(xurl):
    req = urllib.request.Request(xurl, headers={"User-Agent": "MORES-HV/1.12b (live SBU sheet)"})
    with urllib.request.urlopen(req, timeout=25) as r:
        ctype = r.headers.get("Content-Type", "")
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("The sheet is larger than 25 MB")
    if data[:2] != b"PK":
        # Google answers a private sheet with its sign-in page (HTML)
        if "html" in ctype or data[:15].lower().startswith((b"<!doctype", b"<html")):
            raise PermissionError("Google did not hand the sheet over - share it as "
                                  "'Anyone with the link: Viewer' and try again")
        raise ValueError("The link did not return a spreadsheet")
    return data


def fetch(url, force=False):
    """(bytes, fetched_at) - cached for a few minutes per link."""
    xurl = export_url(url)
    if not xurl:
        raise ValueError("Only a Google Sheets (or Drive .xlsx) link can be read live")
    now = time.time()
    with _lock:
        hit = _cache.get(xurl)
        if hit and not force and now - hit[1] < CACHE_SECONDS:
            return hit[0], hit[1]
    data = _download(xurl)
    with _lock:
        _cache[xurl] = (data, now)
    return data, now


# ---- reading the tabs -------------------------------------------------------

# header text -> field; the longer phrases are tried first ("nama akun" before "akun")
HEADERS = [
    ("account_name", ("nama akun", "account name")),
    ("date", ("tanggal", "date", "tgl")),
    ("amount", ("nominal", "amount", "jumlah", "nilai")),
    ("account", ("gl / akun", "gl/akun", "kode akun", "akun", "account", "gl")),
    ("desc", ("keterangan", "description", "uraian", "deskripsi")),
    ("project", ("project", "proyek", "projek")),
    ("ref", ("referensi", "bukti", "reference", "ref")),
    ("group", ("kelompok", "group", "category", "kategori")),
    ("treatment", ("perlakuan", "treatment")),
]
EXPENSE_TABS = (r"rincian pengeluaran", r"pengeluaran|expense", r"biaya|cost|spending")
REVENUE_TABS = (r"rincian pendapatan", r"pendapatan|revenue|income|penjualan|sales")


def _norm(v):
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


def _header_map(row):
    cols = {}
    for i, cell in enumerate(row):
        h = _norm(cell)
        if not h:
            continue
        for field, words in HEADERS:
            if field not in cols and any(h == w or h.startswith(w + " ") or h.startswith(w + "(") for w in words):
                cols[field] = i
                break
    return cols if "date" in cols and "amount" in cols else None


def _as_date(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, (int, float)) and 20000 < v < 80000:      # a serial the export left as a number
        return date.fromordinal(date(1899, 12, 30).toordinal() + int(v))
    s = str(v or "").strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except ValueError:
            pass
    return None


def _as_amount(v):
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[^\d,.\-]", "", str(v or ""))
    if not s:
        return None
    if "," in s and "." in s:                 # 1.234.567,50
        s = s.replace(".", "").replace(",", ".")
    elif s.count(".") > 1 or (s.count(".") == 1 and len(s.split(".")[1]) == 3):
        s = s.replace(".", "")                # 1.234.567
    else:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _read_tab(ws):
    """(rows, header) of a register tab, or (None, None)."""
    head, cols = None, None
    for i, row in enumerate(ws.iter_rows(min_row=1, max_row=15, values_only=True), start=1):
        cols = _header_map(row)
        if cols:
            head = i
            break
    if not cols:
        return None, None
    out = []
    for row in ws.iter_rows(min_row=head + 1, values_only=True):
        get = lambda f: row[cols[f]] if f in cols and cols[f] < len(row) else None
        d, amt = _as_date(get("date")), _as_amount(get("amount"))
        if d is None or amt is None or amt == 0:
            continue
        out.append({"date": d.isoformat(), "year": d.year, "month": d.month, "amount": round(amt, 2),
                    "account": str(get("account") or "").strip(), "account_name": str(get("account_name") or "").strip(),
                    "desc": str(get("desc") or "").strip(), "project": str(get("project") or "").strip(),
                    "ref": str(get("ref") or "").strip(), "group": str(get("group") or "").strip(),
                    "treatment": str(get("treatment") or "").strip()})
    return out, [k for k, _ in sorted(cols.items(), key=lambda x: x[1])]


def _pick(wb, patterns, taken=()):
    for pat in patterns:
        for ws in wb.worksheets:
            if ws.title in taken or not re.search(pat, ws.title, re.I):
                continue
            rows, head = _read_tab(ws)
            if rows is not None:
                return ws.title, rows, head
    return None, [], None


def kind_of(r):
    """expense (in the profit) / capex / deposit / balance (other balance-sheet)."""
    t, g, a = _norm(r["treatment"]), _norm(r["group"]), _norm(r["account"])
    if "capex" in t or g == "capex" or a.startswith("capex"):
        return "capex"
    if "deposit" in t or g == "deposit" or a.startswith("deposit"):
        return "deposit"
    if "neraca" in t or "balance" in t:
        return "balance"
    return "expense"


def parse(data):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    try:
        ex_tab, ex, ex_head = _pick(wb, EXPENSE_TABS)
        rv_tab, rv, rv_head = _pick(wb, REVENUE_TABS, taken=(ex_tab,))
        tabs = [ws.title for ws in wb.worksheets]
    finally:
        wb.close()
    for r in ex:
        r["kind"] = kind_of(r)
    return {"tabs": tabs, "expense_tab": ex_tab, "revenue_tab": rv_tab,
            "expense_columns": ex_head, "revenue_columns": rv_head, "expenses": ex, "revenues": rv}


def summarise(p, year=None):
    """Totals, months, groups, projects and the latest lines for one year."""
    years = sorted({r["year"] for r in p["expenses"]} | {r["year"] for r in p["revenues"]})
    if year not in years:
        year = years[-1] if years else datetime.now().year
    ex = [r for r in p["expenses"] if r["year"] == year]
    rv = [r for r in p["revenues"] if r["year"] == year]
    s = lambda rows: round(sum(r["amount"] for r in rows), 2)
    cost = [r for r in ex if r["kind"] == "expense"]
    months = []
    for m in range(1, 13):
        months.append({"month": m, "revenue": s([r for r in rv if r["month"] == m]),
                       "expense": s([r for r in cost if r["month"] == m]),
                       "capex": s([r for r in ex if r["month"] == m and r["kind"] == "capex"])})
    filled = [x for x in months if x["expense"] or x["revenue"] or x["capex"]]
    revenue, expense = s(rv), s(cost)

    def group(rows, key):
        acc = {}
        for r in rows:
            k = r[key] or "—"
            acc[k] = acc.get(k, 0) + r["amount"]
        return [{"name": k, "amount": round(v, 2)} for k, v in sorted(acc.items(), key=lambda x: -x[1])]

    projects = {}
    for r in cost:
        projects.setdefault(r["project"] or "—", {"revenue": 0, "expense": 0})["expense"] += r["amount"]
    for r in rv:
        projects.setdefault(r["project"] or "—", {"revenue": 0, "expense": 0})["revenue"] += r["amount"]
    by_project = [{"name": k, "revenue": round(v["revenue"], 2), "expense": round(v["expense"], 2),
                   "profit": round(v["revenue"] - v["expense"], 2)}
                  for k, v in sorted(projects.items(), key=lambda x: -(x[1]["expense"] + x[1]["revenue"]))]
    every = sorted(ex + [dict(r, kind="revenue") for r in rv], key=lambda r: r["date"], reverse=True)
    all_dates = [r["date"] for r in p["expenses"] + p["revenues"]]
    return {
        "year": year, "years": years,
        "last_date": max(all_dates) if all_dates else None,
        "totals": {"revenue": revenue, "expense": expense, "profit": round(revenue - expense, 2),
                   "margin_pct": round(100.0 * (revenue - expense) / revenue, 1) if revenue else None,
                   "expense_pct": round(100.0 * expense / revenue, 1) if revenue else None,
                   "capex": s([r for r in ex if r["kind"] == "capex"]),
                   "deposit": s([r for r in ex if r["kind"] == "deposit"]),
                   "months_with_data": len(filled),
                   "avg_month_expense": round(expense / len(filled), 2) if filled else 0},
        "months": months,
        "by_group": group(cost, "group"),
        "by_account": group(cost, "account_name" if any(r["account_name"] for r in cost) else "account")[:12],
        "by_project": by_project,
        "lines": every,
        "count": {"expenses": len(ex), "revenues": len(rv)},
    }


def brief(url, year=None, force=False):
    data, at = fetch(url, force)
    p = parse(data)
    out = summarise(p, year)
    out.update({"tabs": p["tabs"], "expense_tab": p["expense_tab"], "revenue_tab": p["revenue_tab"],
                "fetched_at": datetime.fromtimestamp(at).strftime("%Y-%m-%d %H:%M"),
                "readable": bool(p["expense_tab"] or p["revenue_tab"])})
    return out


def template_workbook():
    """The layout every SBU's live sheet follows (upload it to Google Drive,
    open it as a Google Sheet, share 'Anyone with the link: Viewer')."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    wb = Workbook()
    yellow = PatternFill("solid", fgColor="FFF4C2")
    bold = Font(bold=True)
    tabs = [
        ("Rincian Pengeluaran", ["Tanggal", "GL / Akun", "Keterangan", "Project", "Nominal (Rp)", "Referensi / Bukti",
                                 "Nama Akun", "Kelompok", "Perlakuan"],
         "Expense register. One line per cost. Perlakuan: 'Beban (Laba Rugi)' = expense, 'Capex (Neraca)' = an asset, "
         "'Deposit (Neraca)' = a deposit. MORES HV reads this tab live.",
         [date(2026, 1, 31), "OPEX-RENT", "Office rent January", "Overhead", 15000000, "INV-001",
          "Office rent", "Opex Overhead", "Beban (Laba Rugi)"]),
        ("Pendapatan", ["Tanggal", "Project", "Keterangan", "Nominal (Rp)", "Referensi / Bukti"],
         "Revenue register. Tag the project so profit per project can be shown. MORES HV reads this tab live.",
         [date(2026, 3, 31), "Project A", "Termin 1", 100000000, "INV-2026-001"]),
    ]
    for i, (name, heads, note, sample) in enumerate(tabs):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = name
        ws["A1"] = name
        ws["A1"].font = Font(bold=True, size=14)
        ws["A2"] = note
        for c, h in enumerate(heads, start=1):
            cell = ws.cell(row=4, column=c, value=h)
            cell.font, cell.fill = bold, yellow
            ws.column_dimensions[cell.column_letter].width = 16 if c != 3 else 34
        for c, v in enumerate(sample, start=1):
            cell = ws.cell(row=5, column=c, value=v)
            if isinstance(v, date):
                cell.number_format = "yyyy-mm-dd"
            elif isinstance(v, (int, float)):
                cell.number_format = "#,##0"
    bio = io.BytesIO()
    wb.save(bio)
    bio.seek(0)
    return bio
