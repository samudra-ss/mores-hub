"""MORES HV - dependency-free PDF export for financial statements.

PDF is a text-based format, so this writes valid single/multi-page PDFs using the
built-in Helvetica / Helvetica-Bold fonts (no embedding, no third-party libs).
Produces real selectable-text PDFs sized A4 portrait.
"""
import io
import math

PAGE_W, PAGE_H = 595.0, 842.0  # A4 portrait, points
MARGIN = 40.0
BOTTOM = MARGIN + 24.0

NAVY = (0.122, 0.184, 0.255)   # header fill
GREY = (0.42, 0.45, 0.49)
RED = (0.74, 0.21, 0.18)
TEAL = (0.0, 0.635, 0.714)     # cash in  (#00a2b6)
ORANGE = (0.973, 0.580, 0.024)  # cash out (#f89406)


def _short(n):
    a = abs(n or 0)
    sign = "-" if (n or 0) < 0 else ""
    if a >= 1e12:
        return "%s%.1fT" % (sign, a / 1e12)
    if a >= 1e9:
        return "%s%.1fB" % (sign, a / 1e9)
    if a >= 1e6:
        return "%s%.0fM" % (sign, a / 1e6)
    if a >= 1e3:
        return "%s%.0fK" % (sign, a / 1e3)
    return "%s%.0f" % (sign, a)

# Helvetica glyph widths (per 1000 em) for ASCII 32..126
_HELV_W = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
_REPL = {"—": "-", "–": "-", "·": "-", "…": "...",
         "’": "'", "‘": "'", "“": '"', "”": '"',
         "✓": "OK", "⚠": "!", "→": "->", "×": "x"}


def _char_w(ch, size):
    o = ord(ch)
    w = _HELV_W[o - 32] if 32 <= o <= 126 else 556
    return w / 1000.0 * size


def _san(s):
    out = []
    for c in str(s):
        if c in _REPL:
            out.append(_REPL[c])
        else:
            out.append(c if 32 <= ord(c) <= 126 else "?")
    return "".join(out)


def text_width(s, size):
    return sum(_char_w(c, size) for c in _san(s))


def _esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def money(n):
    if n is None:
        return "-"
    n = int(round(n))
    s = "{:,}".format(abs(n)).replace(",", ".")
    return ("(" + s + ")") if n < 0 else s


class PdfDoc:
    def __init__(self):
        self.pages = []
        self.cur = None
        self._new_page()

    def _new_page(self):
        self.cur = []
        self.pages.append(self.cur)
        self.y = PAGE_H - MARGIN

    def ensure(self, needed=16.0):
        if self.y - needed < BOTTOM:
            self._new_page()
            return True
        return False

    def text(self, x, y, s, size=10, bold=False, color=None):
        font = "F2" if bold else "F1"
        body = "BT /%s %d Tf %.2f %.2f Td (%s) Tj ET" % (font, size, x, y, _esc(_san(s)))
        if color:
            self.cur.append("%.3f %.3f %.3f rg %s 0 0 0 rg" % (color[0], color[1], color[2], body))
        else:
            self.cur.append(body)

    def rtext(self, xr, y, s, size=10, bold=False, color=None):
        self.text(xr - text_width(s, size), y, s, size, bold, color)

    def line(self, x1, y1, x2, y2, w=0.6, gray=0.8):
        self.cur.append("%.2f G %.2f w %.2f %.2f m %.2f %.2f l S 0 G 1 w" % (gray, w, x1, y1, x2, y2))

    def rect_fill(self, x, y, w, h, color):
        self.cur.append("%.3f %.3f %.3f rg %.2f %.2f %.2f %.2f re f 0 0 0 rg"
                        % (color[0], color[1], color[2], x, y, w, h))

    def cline(self, x1, y1, x2, y2, color, w=1.0):
        """Coloured stroked line."""
        self.cur.append("%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S 0 0 0 RG 1 w"
                        % (color[0], color[1], color[2], w, x1, y1, x2, y2))

    def cashflow_chart(self, cf, months):
        """Native vector bar+line chart: cash in / cash out bars + ending-balance line."""
        self.ensure(225)
        chart_x = MARGIN + 34
        chart_w = PAGE_W - MARGIN - chart_x
        top = self.y
        chart_h = 165.0
        base = top - chart_h
        vals = []
        for m in cf["monthly"]:
            vals += [m["cash_in"], m["cash_out"], m["ending"]]
        maxv = max(vals + [1.0]) * 1.08

        def yv(v):
            return base + (v / maxv) * chart_h

        for i in range(5):  # gridlines + y-axis labels
            gy = base + (i / 4.0) * chart_h
            self.line(chart_x, gy, chart_x + chart_w, gy, 0.4, 0.88)
            self.rtext(chart_x - 5, gy - 3, _short(maxv * i / 4.0), 6.5, False, GREY)
        gw = chart_w / 12.0
        bw = gw * 0.30
        for i, m in enumerate(cf["monthly"]):
            gx = chart_x + i * gw
            self.rect_fill(gx + gw * 0.12, base, bw, yv(m["cash_in"]) - base, TEAL)
            self.rect_fill(gx + gw * 0.12 + bw + 2, base, bw, yv(m["cash_out"]) - base, ORANGE)
            self.text(gx + gw * 0.22, base - 10, months[i], 6.5, False, GREY)
        prev = None  # ending-balance line
        for i, m in enumerate(cf["monthly"]):
            cx = chart_x + i * gw + gw / 2.0
            cy = yv(m["ending"])
            if prev:
                self.cline(prev[0], prev[1], cx, cy, NAVY, 1.3)
            prev = (cx, cy)
        # legend
        ly = base - 22
        self.rect_fill(chart_x, ly, 9, 7, TEAL)
        self.text(chart_x + 13, ly, "Cash In", 7.5, False, GREY)
        self.rect_fill(chart_x + 70, ly, 9, 7, ORANGE)
        self.text(chart_x + 83, ly, "Cash Out", 7.5, False, GREY)
        self.cline(chart_x + 150, ly + 3, chart_x + 165, ly + 3, NAVY, 1.3)
        self.text(chart_x + 169, ly, "Ending Balance", 7.5, False, GREY)
        self.y = ly - 18

    def fit(self, s, maxw, size):
        s = _san(s)
        if text_width(s, size) <= maxw:
            return s
        while s and text_width(s + "...", size) > maxw:
            s = s[:-1]
        return s + "..."

    # --- high level helpers ------------------------------------------------
    def header(self, title, subtitle=""):
        self.text(MARGIN, self.y, "MORES HV", 11, True, NAVY)
        self.rtext(PAGE_W - MARGIN, self.y, "Helicopter View - Group Finance", 8, False, GREY)
        self.y -= 20
        self.text(MARGIN, self.y, title, 15, True)
        self.y -= 16
        if subtitle:
            self.text(MARGIN, self.y, subtitle, 9, False, GREY)
            self.y -= 14
        self.line(MARGIN, self.y, PAGE_W - MARGIN, self.y, 0.8, 0.6)
        self.y -= 16

    def col_header(self, cols):
        """cols: list of (label, x, align) align in 'l'/'r'."""
        self.rect_fill(MARGIN, self.y - 4, PAGE_W - 2 * MARGIN, 16, NAVY)
        for label, x, align in cols:
            if align == "r":
                self.rtext(x, self.y, label, 8.5, True, (1, 1, 1))
            else:
                self.text(x, self.y, label, 8.5, True, (1, 1, 1))
        self.y -= 18

    def build(self):
        objs = {}
        objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
        objs[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
        page_nums = []
        n = 5
        for frags in self.pages:
            stream = (" ".join(frags)).encode("latin-1", "replace")
            content_num, page_num = n, n + 1
            n += 2
            objs[content_num] = (b"<< /Length %d >>\nstream\n" % len(stream)) + stream + b"\nendstream"
            objs[page_num] = (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                b"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>" % content_num)
            page_nums.append(page_num)
        kids = b" ".join(b"%d 0 R" % p for p in page_nums)
        objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
        objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_nums))

        out = io.BytesIO()
        out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        for num in sorted(objs):
            offsets[num] = out.tell()
            out.write(b"%d 0 obj\n" % num)
            out.write(objs[num])
            out.write(b"\nendobj\n")
        xref_pos = out.tell()
        count = max(objs) + 1
        out.write(b"xref\n0 %d\n" % count)
        out.write(b"0000000000 65535 f \n")
        for i in range(1, count):
            out.write(b"%010d 00000 n \n" % offsets.get(i, 0))
        out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (count, xref_pos))
        out.seek(0)
        return out


# ---------------------------------------------------------------------------
# Report renderers
# ---------------------------------------------------------------------------

def export_pnl_pdf(pnl, scope, period):
    d = PdfDoc()
    d.header("Profit & Loss Statement", "%s   |   %s" % (scope, period))
    ax, name_x, amt_x = MARGIN, MARGIN + 55, PAGE_W - MARGIN
    d.col_header([("CODE", ax, "l"), ("ACCOUNT", name_x, "l"), ("AMOUNT", amt_x, "r")])

    def section(label, rows, total_label, total):
        d.ensure()
        d.text(ax, d.y, label, 9.5, True, NAVY)
        d.y -= 15
        for r in rows:
            d.ensure()
            d.text(ax, d.y, r["code"], 9)
            d.text(name_x, d.y, d.fit(r["name"], amt_x - name_x - 90, 9), 9)
            d.rtext(amt_x, d.y, money(r["balance"]), 9)
            d.y -= 14
        d.line(ax, d.y + 4, amt_x, d.y + 4, 0.5, 0.85)
        d.text(name_x, d.y - 8, total_label, 9, True)
        d.rtext(amt_x, d.y - 8, money(total), 9, True)
        d.y -= 24

    section("REVENUE", pnl["revenue"], "Total Revenue", pnl["total_revenue"])
    section("EXPENSES", pnl["expense"], "Total Expenses", pnl["total_expense"])
    d.ensure()
    d.rect_fill(ax, d.y - 5, PAGE_W - 2 * MARGIN, 18, (0.93, 0.95, 0.97))
    d.text(name_x, d.y, "NET PROFIT  (margin %s%%)" % pnl["margin_pct"], 10.5, True)
    d.rtext(amt_x, d.y, money(pnl["net_profit"]), 10.5, True,
            None if pnl["net_profit"] >= 0 else RED)
    return d.build()


def export_balance_sheet_pdf(bs, scope, period):
    d = PdfDoc()
    d.header("Balance Sheet", "%s   |   %s" % (scope, period))
    ax, name_x, amt_x = MARGIN, MARGIN + 55, PAGE_W - MARGIN
    d.col_header([("CODE", ax, "l"), ("ACCOUNT", name_x, "l"), ("AMOUNT", amt_x, "r")])
    for label, rows, total in [
        ("ASSETS", bs["assets"], bs["total_assets"]),
        ("LIABILITIES", bs["liabilities"], bs["total_liabilities"]),
        ("EQUITY", bs["equity"], bs["total_equity"]),
    ]:
        d.ensure()
        d.text(ax, d.y, label, 9.5, True, NAVY)
        d.y -= 15
        for r in rows:
            d.ensure()
            d.text(ax, d.y, r["code"], 9)
            d.text(name_x, d.y, d.fit(r["name"], amt_x - name_x - 90, 9), 9)
            d.rtext(amt_x, d.y, money(r["balance"]), 9)
            d.y -= 14
        d.line(ax, d.y + 4, amt_x, d.y + 4, 0.5, 0.85)
        d.text(name_x, d.y - 8, "Total %s" % label.title(), 9, True)
        d.rtext(amt_x, d.y - 8, money(total), 9, True)
        d.y -= 24
    d.ensure()
    ok = bs.get("balanced")
    d.text(ax, d.y, ("Balanced: Assets = Liabilities + Equity" if ok
                     else "NOT balanced - check entries"), 9, True, None if ok else RED)
    return d.build()


def export_trial_balance_pdf(tb, scope, period):
    d = PdfDoc()
    d.header("Trial Balance", "%s   |   %s" % (scope, period))
    cx, nx, tx = MARGIN, MARGIN + 42, 232
    debit_x, credit_x, bal_x = 360, 458, PAGE_W - MARGIN
    d.col_header([("CODE", cx, "l"), ("ACCOUNT", nx, "l"), ("TYPE", tx, "l"),
                  ("DEBIT", debit_x, "r"), ("CREDIT", credit_x, "r"), ("BALANCE", bal_x, "r")])
    display = tb.get("grouped") or [dict(x, level=0, is_group=False) for x in tb["rows"]]
    for r in display:
        d.ensure()
        grp = bool(r.get("is_group"))
        ind = 9 * r.get("level", 0)
        d.text(cx, d.y, r["code"], 8.5, grp)
        d.text(nx + ind, d.y, d.fit(r["name"], tx - (nx + ind) - 4, 8.5), 8.5, grp)
        d.text(tx, d.y, r["type"], 8.5, grp)
        d.rtext(debit_x, d.y, money(r["debit"]) if r["debit"] else "", 8.5, grp)
        d.rtext(credit_x, d.y, money(r["credit"]) if r["credit"] else "", 8.5, grp)
        d.rtext(bal_x, d.y, money(r["balance"]), 8.5, grp)
        d.y -= 13
    d.line(cx, d.y + 4, bal_x, d.y + 4, 0.6, 0.6)
    d.text(cx, d.y - 8, "TOTAL", 9, True)
    d.rtext(debit_x, d.y - 8, money(tb["total_debit"]), 9, True)
    d.rtext(credit_x, d.y - 8, money(tb["total_credit"]), 9, True)
    return d.build()


def export_cash_flow_pdf(cf, scope):
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    d = PdfDoc()
    d.header("Cash Flow Statement", "%s   |   Year %s" % (scope, cf["year"]))
    d.cashflow_chart(cf, months)  # monthly cash-flow chart (cash in/out + ending balance)
    mx = MARGIN
    in_x, out_x, net_x, end_x = 200, 320, 430, PAGE_W - MARGIN
    d.col_header([("MONTH", mx, "l"), ("CASH IN", in_x, "r"), ("CASH OUT", out_x, "r"),
                  ("NET", net_x, "r"), ("ENDING BALANCE", end_x, "r")])
    d.text(mx, d.y, "Opening balance", 9, True)
    d.rtext(end_x, d.y, money(cf["opening_balance"]), 9, True)
    d.y -= 15
    for m in cf["monthly"]:
        d.ensure()
        d.text(mx, d.y, months[m["month"] - 1], 9)
        d.rtext(in_x, d.y, money(m["cash_in"]), 9)
        d.rtext(out_x, d.y, money(m["cash_out"]), 9)
        d.rtext(net_x, d.y, money(m["net"]), 9, False, None if m["net"] >= 0 else RED)
        d.rtext(end_x, d.y, money(m["ending"]), 9)
        d.y -= 13
    d.line(mx, d.y + 4, end_x, d.y + 4, 0.6, 0.6)
    d.text(mx, d.y - 8, "TOTAL / CLOSING", 9, True)
    d.rtext(in_x, d.y - 8, money(cf["total_in"]), 9, True)
    d.rtext(out_x, d.y - 8, money(cf["total_out"]), 9, True)
    d.rtext(net_x, d.y - 8, money(cf["net_change"]), 9, True)
    d.rtext(end_x, d.y - 8, money(cf["closing_balance"]), 9, True)
    d.y -= 26
    # sources & uses
    for title, rows in [("SOURCES OF CASH", cf.get("sources", [])),
                        ("USES OF CASH", cf.get("uses", []))]:
        d.ensure(40)
        d.text(mx, d.y, title, 9.5, True, NAVY)
        d.y -= 15
        for r in rows:
            d.ensure()
            d.text(mx, d.y, d.fit("%s %s" % (r["code"], r["name"]), 360, 9), 9)
            d.rtext(end_x, d.y, money(r["amount"]), 9)
            d.y -= 13
        d.y -= 10
    return d.build()


def export_budget_vs_actual_pdf(bva, scope, project=None):
    d = PdfDoc()
    sub = "%s   |   Year %s" % (scope, bva["year"])
    if project:
        sub = "Project %s   |   %s" % (project, sub)
    d.header("Budget vs Realization", sub)
    cx, nx, tx = MARGIN, MARGIN + 42, 210
    bud_x, real_x, var_x, used_x = 330, 425, 510, PAGE_W - MARGIN
    d.col_header([("CODE", cx, "l"), ("ACCOUNT", nx, "l"), ("TYPE", tx, "l"),
                  ("BUDGET", bud_x, "r"), ("REALIZATION", real_x, "r"),
                  ("VARIANCE", var_x, "r"), ("USED", used_x, "r")])
    for r in bva["rows"]:
        d.ensure()
        bad = (r["variance"] > 0) if r["type"] == "expense" else (r["variance"] < 0)
        d.text(cx, d.y, r["code"], 8)
        d.text(nx, d.y, d.fit(r["name"], tx - nx - 4, 8), 8)
        d.text(tx, d.y, r["type"], 8)
        d.rtext(bud_x, d.y, money(r["budget"]), 8)
        d.rtext(real_x, d.y, money(r["actual"]), 8)
        d.rtext(var_x, d.y, money(r["variance"]), 8, False, RED if bad else None)
        d.rtext(used_x, d.y, ("-" if r["used_pct"] is None else "%s%%" % r["used_pct"]), 8)
        d.y -= 12.5
    d.text(cx, d.y - 2, "Realization = posted actuals (Realisasi).", 8, False, GREY)
    return d.build()


# ---------------------------------------------------------------------------
# Project close-out report (v1.11) - page 1 the gross profit with a chart and a
# budget vs realization table, page 2 on the detail of every account it used.
# ---------------------------------------------------------------------------

GREEN = (0.122, 0.616, 0.341)
LIGHT = {"navy": (0.91, 0.93, 0.96), "teal": (0.88, 0.96, 0.97), "orange": (1.0, 0.95, 0.88),
         "green": (0.91, 0.97, 0.93), "red": (0.99, 0.91, 0.90), "grey": (0.95, 0.96, 0.97)}


def _dmy(iso):
    s = str(iso or "")[:10]
    return "%s/%s/%s" % (s[8:10], s[5:7], s[:4]) if len(s) == 10 and s[4] == "-" else (s or "-")


def _pct(v):
    return "-" if v is None else ("%.1f%%" % (v * 100)).replace(".", ",")


def _nice_step(span, n=4):
    """A round tick step (1, 2, 2.5 or 5 x 10^k) that splits span into about n parts."""
    raw = max(span, 1.0) / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def _waterfall(d, data, chart_h=118.0):
    """Revenue, then each cost account taken out of it, ending at gross profit."""
    cost = data["cost"]
    top = cost[:7]
    rest = round(sum(a["actual"] for a in cost[7:]), 2)
    steps = [("Revenue", data["total_revenue"], "rev")]
    steps += [(a["code"], a["actual"], "cost") for a in top if a["actual"]]
    if rest:
        steps.append(("Other", rest, "cost"))
    steps.append(("Gross profit", data["gross_profit"], "gp"))
    # every level the bars touch, so a loss-making project draws below zero
    level, levels = 0.0, [0.0]
    for label, v, kind in steps:
        if kind == "rev":
            level = v
            levels.append(v)
        elif kind == "cost":
            level -= v
            levels.append(level)
        else:
            levels.append(v)
    step = _nice_step(max(levels) - min(levels))
    lo = math.floor(min(levels) / step) * step
    hi = math.ceil(max(max(levels), 1.0) / step) * step
    top_v = hi + step * 0.25                        # room for the value labels
    chart_x = MARGIN + 38
    chart_w = PAGE_W - MARGIN - chart_x
    y0 = d.y - 8 - chart_h

    def yv(v):
        return y0 + (v - lo) / (top_v - lo) * chart_h

    t = lo
    while t <= hi + step / 2.0:
        d.line(chart_x, yv(t), chart_x + chart_w, yv(t), 0.4 if t else 0.8, 0.9 if t else 0.45)
        d.rtext(chart_x - 5, yv(t) - 3, _short(t), 6.5, False, GREY)
        t += step
    gw = chart_w / len(steps)
    bw = min(46.0, gw * 0.62)
    level = 0.0
    for i, (label, v, kind) in enumerate(steps):
        x = chart_x + i * gw + (gw - bw) / 2.0
        if kind == "rev":
            a, b, col = 0.0, v, TEAL
            level = v
        elif kind == "cost":
            a, b, col = level - v, level, ORANGE
            level -= v
        else:
            a, b, col = 0.0, v, GREEN if v >= 0 else RED
        y1, y2 = sorted((yv(a), yv(b)))
        d.rect_fill(x, y1, bw, max(0.6, y2 - y1), col)
        d.text(x + bw / 2.0 - text_width(_short(v), 6.5) / 2.0, y2 + 3, _short(v), 6.5, True, GREY)
        lab = d.fit(label, gw - 2, 6.5)
        d.text(chart_x + i * gw + gw / 2.0 - text_width(lab, 6.5) / 2.0, y0 - 10, lab, 6.5, False, GREY)
    ly = y0 - 23
    for j, (name, col) in enumerate((("Revenue", TEAL), ("Cost accounts", ORANGE), ("Gross profit", GREEN))):
        lx = chart_x + j * 100
        d.rect_fill(lx, ly, 9, 7, col)
        d.text(lx + 13, ly, name, 7.5, False, GREY)
    d.y = ly - 16


def export_project_closeout_pdf(data, generated_by="", generated_on=""):
    p = data["project"]
    tracks = data.get("tracks") or []
    d = PdfDoc()
    d.header("Project Close-out Report",
             d.fit("%s - %s   |   %s   |   Sector: %s" % (p["code"], p["name"], p["company_code"],
                                                        p["type_name"] or "Unassigned"), PAGE_W - 2 * MARGIN, 9))

    # --- the facts -----------------------------------------------------------
    invoiced = sum(t.get("amount") or 0 for t in tracks)
    done = [t for t in tracks if t.get("status") == "done"]
    facts = [
        [("Project", "%s - %s" % (p["code"], p["name"]))],
        [("Company", "%s - %s" % (p["company_code"], p["company_name"])), ("Sector", p["type_name"] or "Unassigned")],
        [("Status", "DONE"), ("Timeline", "%s  to  %s" % (_dmy(p["start_date"]), _dmy(p["end_date"])))],
        [("Ledger activity", ("%s  to  %s  (%d lines)" % (_dmy(data["first_date"]), _dmy(data["last_date"]),
                                                        data["line_count"])) if data["line_count"] else "no posted lines"),
         ("Client", ", ".join(sorted({t["client"] for t in tracks if t.get("client")})) or "-")],
        [("Contract value", "Rp " + money(data["contract_value"])
          + ("  (from the revenue budget)" if data["contract_from_budget"] else "")),
         ("Invoicing (Money Tracker)", ("Rp %s in %d track%s, %d paid" % (money(invoiced), len(tracks),
                                        "" if len(tracks) == 1 else "s", len(done))) if tracks else "no tracks")],
    ]
    full_w = PAGE_W - 2 * MARGIN
    for row in facts:
        w = full_w / len(row)
        for j, (k, v) in enumerate(row):
            x = MARGIN + j * w
            d.text(x, d.y, k.upper(), 6.5, True, GREY)
            d.text(x, d.y - 10.5, d.fit(v, w - 12, 9), 9)
        d.y -= 24
    d.y -= 8

    # --- the headline numbers -------------------------------------------------
    gp, gm = data["gross_profit"], data["gross_margin"]
    tiles = [("CONTRACT VALUE", "Rp " + money(data["contract_value"]), LIGHT["navy"], NAVY),
             ("REVENUE", "Rp " + money(data["total_revenue"]), LIGHT["teal"], TEAL),
             ("TOTAL COST", "Rp " + money(data["total_cost"]), LIGHT["orange"], ORANGE),
             ("GROSS PROFIT", "Rp " + money(gp), LIGHT["green"] if gp >= 0 else LIGHT["red"], GREEN if gp >= 0 else RED),
             ("GROSS MARGIN", _pct(gm), LIGHT["green"] if (gm or 0) >= 0 else LIGHT["red"], GREEN if (gm or 0) >= 0 else RED)]
    tw = (full_w - 4 * 6) / 5.0
    for i, (label, val, bg, fg) in enumerate(tiles):
        x = MARGIN + i * (tw + 6)
        d.rect_fill(x, d.y - 32, tw, 42, bg)
        d.rect_fill(x, d.y - 32, 3, 42, fg)
        d.text(x + 8, d.y - 1, label, 6.5, True, GREY)
        d.text(x + 8, d.y - 20, d.fit(val, tw - 12, 10), 10, True, fg)
    d.y -= 52

    # --- the chart ------------------------------------------------------------
    d.text(MARGIN, d.y, "Gross profit - revenue, less every cost account tagged to the project", 10, True, NAVY)
    _waterfall(d, data)

    # --- the table: always on this page, the smallest cost accounts folded ----
    d.text(MARGIN, d.y, "Gross profit - budget vs realization (whole project)", 10, True, NAVY)
    d.y -= 14
    xb, xa, xv, xs = MARGIN + 305, MARGIN + 385, MARGIN + 460, PAGE_W - MARGIN
    d.col_header([("ACCOUNT", MARGIN + 4, "l"), ("BUDGET", xb, "r"), ("REALIZATION", xa, "r"),
                  ("VARIANCE", xv, "r"), ("% OF REV", xs, "r")])
    rh = 12.0
    fixed = 2 * 11 + 3 * rh + 2 + 14 + 2 * 9 + 4      # group labels, totals, GP, margin, notes
    cap = max(4, int((d.y - BOTTOM - fixed) / rh))
    rev_rows, cost_rows = list(data["revenue"]), list(data["cost"])
    folded = None
    if len(rev_rows) + len(cost_rows) > cap:
        keep = max(1, cap - len(rev_rows) - 1)
        extra = cost_rows[keep:]
        cost_rows = cost_rows[:keep]
        folded = ("   Other cost accounts (%d) - itemised on the detail pages" % len(extra),
                  sum(a["budget"] for a in extra), sum(a["actual"] for a in extra))
    rev_total = data["total_revenue"]

    def row(label, bud, act, var, bold=False, fill=None, color=None):
        if fill:
            d.rect_fill(MARGIN, d.y - 3.5, full_w, rh, fill)
        d.text(MARGIN + 4, d.y, d.fit(label, xb - 80 - MARGIN, 8), 8, bold, color)
        d.rtext(xb, d.y, money(bud), 8, bold)
        d.rtext(xa, d.y, money(act), 8, bold)
        d.rtext(xv, d.y, money(var), 8, bold, RED if var < 0 else None)
        d.rtext(xs, d.y, _pct(act / rev_total) if rev_total else "-", 8, bold, GREY)
        d.y -= rh

    def group(title):
        d.text(MARGIN + 4, d.y, title, 7.5, True, GREY)
        d.y -= 11

    group("REVENUE")
    for a in rev_rows:
        row("   %s  %s" % (a["code"], a["name"]), a["budget"], a["actual"], a["actual"] - a["budget"])
    row("Total revenue", data["budget_revenue"], rev_total, rev_total - data["budget_revenue"], True, LIGHT["grey"])
    group("COST OF THE PROJECT")
    for a in cost_rows:
        row("   %s  %s" % (a["code"], a["name"]), a["budget"], a["actual"], a["budget"] - a["actual"])
    if folded:
        row(folded[0], folded[1], folded[2], folded[1] - folded[2])
    row("Total cost", data["budget_cost"], data["total_cost"], data["budget_cost"] - data["total_cost"], True, LIGHT["grey"])
    d.y -= 2
    row("GROSS PROFIT", data["budget_gross_profit"], gp, gp - data["budget_gross_profit"], True,
        LIGHT["green"] if gp >= 0 else LIGHT["red"], GREEN if gp >= 0 else RED)
    bm = (data["budget_gross_profit"] / data["budget_revenue"]) if data["budget_revenue"] else None
    d.text(MARGIN + 4, d.y, "Gross margin", 8, True)
    d.rtext(xb, d.y, _pct(bm), 8, True)
    d.rtext(xa, d.y, _pct(gm), 8, True)
    d.y -= 14
    d.text(MARGIN, d.y, "Variance: revenue and profit rows read realization minus budget, cost rows budget minus "
           "realization - a negative figure is always the unfavourable one.", 6.5, False, GREY)
    d.y -= 9
    d.text(MARGIN, d.y, "Budget = every year's Budget Center rows on this project. Realization = every posted journal "
           "line tagged to it, in any company's books.", 6.5, False, GREY)

    # --- page 2 on: the detail of every account --------------------------------
    d._new_page()
    d.header("Detail per account", d.fit("%s - %s   |   every posted line tagged to the project, by account"
                                         % (p["code"], p["name"]), full_w, 9))
    accounts = [("revenue", a) for a in data["revenue"]] + [("cost", a) for a in data["cost"]]
    if not accounts or not data["line_count"]:
        d.text(MARGIN, d.y, "No posted journal lines are tagged to this project.", 9, False, GREY)
    else:
        # the accounts at a glance first, then each one's lines
        d.text(MARGIN, d.y, "Accounts used", 10, True, NAVY)
        d.y -= 14
        xs1, xs2, xs3, xs4 = MARGIN + 330, MARGIN + 395, MARGIN + 455, PAGE_W - MARGIN
        sum_cols = [("ACCOUNT", MARGIN + 4, "l"), ("LINES", xs1, "r"), ("DEBIT", xs2, "r"),
                    ("CREDIT", xs3, "r"), ("NET", xs4, "r")]
        d.col_header(sum_cols)
        for kind, a in accounts:
            if d.ensure(12):
                d.col_header(sum_cols)
            d.text(MARGIN + 4, d.y, d.fit("%s  %s  (%s)" % (a["code"], a["name"], kind), xs1 - 60 - MARGIN, 8), 8)
            d.rtext(xs1, d.y, str(len(a["lines"])), 8, False, GREY)
            d.rtext(xs2, d.y, money(a["debit"]), 8)
            d.rtext(xs3, d.y, money(a["credit"]), 8)
            d.rtext(xs4, d.y, money(a["actual"]), 8, True)
            d.y -= 11
        d.y -= 12

    xd, xe, xc, xdesc, xdr, xcr = MARGIN + 4, MARGIN + 58, MARGIN + 140, MARGIN + 180, MARGIN + 440, PAGE_W - MARGIN
    det_cols = [("DATE", xd, "l"), ("ENTRY", xe, "l"), ("CO.", xc, "l"), ("DESCRIPTION", xdesc, "l"),
                ("DEBIT", xdr, "r"), ("CREDIT", xcr, "r")]
    for kind, a in accounts:
        if not a["lines"]:
            continue
        d.ensure(52)
        d.rect_fill(MARGIN, d.y - 5, full_w, 17, LIGHT["navy"])
        d.text(MARGIN + 4, d.y, d.fit("%s  %s   (%s)" % (a["code"], a["name"], kind), 330, 9.5), 9.5, True, NAVY)
        d.rtext(PAGE_W - MARGIN - 4, d.y, "%d line%s   -   Rp %s" % (len(a["lines"]), "" if len(a["lines"]) == 1 else "s",
                                                                money(a["actual"])), 8.5, True, NAVY)
        d.y -= 20
        d.col_header(det_cols)
        for ln in a["lines"]:
            if d.ensure(12):
                d.text(MARGIN, d.y, d.fit("%s  %s  (continued)" % (a["code"], a["name"]), 400, 8.5), 8.5, True, NAVY)
                d.y -= 14
                d.col_header(det_cols)
            d.text(xd, d.y, _dmy(ln["date"]), 7.5)
            d.text(xe, d.y, d.fit(ln["entry_no"], xc - xe - 4, 7.5), 7.5)
            d.text(xc, d.y, d.fit(ln["company_code"], xdesc - xc - 4, 7.5), 7.5, False, GREY)
            d.text(xdesc, d.y, d.fit(ln["description"], xdr - 60 - xdesc, 7.5), 7.5)
            d.rtext(xdr, d.y, money(ln["debit"]) if ln["debit"] else "", 7.5)
            d.rtext(xcr, d.y, money(ln["credit"]) if ln["credit"] else "", 7.5)
            d.y -= 11
        d.ensure(16)
        d.line(MARGIN, d.y + 7, PAGE_W - MARGIN, d.y + 7, 0.6, 0.7)
        d.text(xdesc, d.y - 2, "Total %s" % a["code"], 8, True)
        d.rtext(xdr, d.y - 2, money(a["debit"]), 8, True)
        d.rtext(xcr, d.y - 2, money(a["credit"]), 8, True)
        d.y -= 22

    # --- footer on every page ----------------------------------------------------
    n = len(d.pages)
    for i, frags in enumerate(d.pages, start=1):
        d.cur = frags
        d.line(MARGIN, 34, PAGE_W - MARGIN, 34, 0.4, 0.8)
        d.text(MARGIN, 22, d.fit("MORES HV - Project close-out - %s%s" % (
            p["code"], ("   |   generated %s by %s" % (generated_on, generated_by)) if generated_by else ""), 400, 7), 7, False, GREY)
        d.rtext(PAGE_W - MARGIN, 22, "Page %d of %d" % (i, n), 7, False, GREY)
    return d.build()
