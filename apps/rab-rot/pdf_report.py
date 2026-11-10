"""MORES RAB ROT - dependency-free PDF writer (trimmed copy of MORES HV's pdf_export).

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
        self.text(MARGIN, self.y, "MORES RAB ROT", 11, True, NAVY)
        self.rtext(PAGE_W - MARGIN, self.y, "Project cost plan & remuneration", 8, False, GREY)
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



# ---------------------------------------------------------------------------
# RAB ROT - project cost plan (v1.13)
# ---------------------------------------------------------------------------
AMBER = (0.78, 0.48, 0.03)
_SIGNAL = {"green": ("GREEN", GREEN, "green"), "amber": ("AMBER", AMBER, "orange"),
           "red": ("RED", RED, "red"), "none": ("-", GREY, "grey")}
_REMU_ROLE = {"pm": "Project Manager", "team": "Team member", "bringer": "Bringer", "partner": "Partner", "bod": "BOD"}
_REMU_KIND = {"pool": "Team pool", "partner": "Partner share", "bod": "BOD share", "bringer": "Bringer fee"}


def _qty(v):
    v = float(v or 0)
    return ("%d" % v) if v == int(v) else ("%.2f" % v).rstrip("0").replace(".", ",")


def export_rab_rot_pdf(meta, plan, calc, remu, generated_by="", generated_on=""):
    """The RAB ROT form as a signed-off document: the cost lines, the margin
    stack, the project value net of tax per PT, the Finance Review with its
    signal, and the remuneration the plan would pay."""
    d = PdfDoc()
    full_w = PAGE_W - 2 * MARGIN
    rv = calc["review"]
    sig_label, sig_col, sig_bg = _SIGNAL.get(rv["status"], _SIGNAL["none"])
    d.header("RAB ROT - Project Cost Plan",
             d.fit("%s   |   %s   |   status %s" % (plan.get("project_name") or meta.get("name"), plan.get("year") or "",
                                                  (meta.get("status") or "draft").upper()), full_w, 9))

    facts = [[("Project", plan.get("project_name") or meta.get("name") or "-"),
              ("Client / owner", plan.get("client") or "-")],
             [("Company / PT", meta.get("company") or "-"), ("Status", (meta.get("status") or "draft").upper())],
             [("Prepared by", "%s  (%s)" % (meta.get("created_by") or "-", _dmy(meta.get("created_at")))),
              ("Last updated", "%s  (%s)" % (meta.get("updated_by") or "-", _dmy(meta.get("updated_at"))))]]
    for row in facts:
        w = full_w / len(row)
        for j, (k, v) in enumerate(row):
            x = MARGIN + j * w
            d.text(x, d.y, k.upper(), 6.5, True, GREY)
            d.text(x, d.y - 10.5, d.fit(v, w - 12, 9), 9)
        d.y -= 24
    d.y -= 4

    tiles = [("PROJECT VALUE", "Rp " + money(calc["value"]), LIGHT["navy"], NAVY),
             ("NET PROJECT VALUE", "Rp " + money(calc["net"]), LIGHT["teal"], TEAL),
             ("TOTAL COST COGS", "Rp " + money(calc["cogs"]), LIGHT["orange"], ORANGE),
             ("NILAI CUAN (NCT) " + _pct(calc["nct_pct"]), "Rp " + money(calc["nct"]),
              LIGHT["green"] if calc["nct"] >= 0 else LIGHT["red"], GREEN if calc["nct"] >= 0 else RED),
             ("FINANCE REVIEW", "%s  %s" % (sig_label, _pct(rv["margin"])), LIGHT[sig_bg], sig_col)]
    tw = (full_w - 4 * 6) / 5.0
    for i, (label, val, bg, fg) in enumerate(tiles):
        x = MARGIN + i * (tw + 6)
        d.rect_fill(x, d.y - 32, tw, 42, bg)
        d.rect_fill(x, d.y - 32, 3, 42, fg)
        d.text(x + 8, d.y - 1, label, 6.5, True, GREY)
        d.text(x + 8, d.y - 20, d.fit(val, tw - 12, 9.5), 9.5, True, fg)
    d.y -= 52

    # --- the cost lines ---------------------------------------------------------
    d.text(MARGIN, d.y, "Cost lines - Harga Satuan (+tax) x JMLH x SAT x VOL", 10, True, NAVY)
    d.y -= 14
    x_no, x_lab, x_nm = MARGIN + 3, MARGIN + 20, MARGIN + 150
    x_j, x_s, x_v, x_h, x_t, x_p, x_r = (MARGIN + 248, MARGIN + 268, MARGIN + 288, MARGIN + 348,
                                         MARGIN + 406, MARGIN + 446, PAGE_W - MARGIN - 3)
    cols = [("NO", x_no, "l"), ("JENIS BIAYA", x_lab, "l"), ("NAMA", x_nm, "l"), ("JMLH", x_j, "r"),
            ("SAT", x_s, "r"), ("VOL", x_v, "r"), ("HARGA SAT.", x_h, "r"), ("TOTAL", x_t, "r"),
            ("%COGS", x_p, "r"), ("FIN. REVIEW", x_r, "r")]
    d.col_header(cols)
    rh = 11.5

    def cont():
        if d.ensure(rh + 2):
            d.col_header(cols)

    for si, sec in enumerate(calc["sections"]):
        cont()
        d.rect_fill(MARGIN, d.y - 3.5, full_w, rh, LIGHT["navy"])
        d.text(x_no, d.y, "%s." % sec["key"], 8, True, NAVY)
        d.text(x_lab, d.y, sec["title"], 8, True, NAVY)
        d.rtext(x_t, d.y, money(sec["total"]), 8, True, NAVY)
        d.rtext(x_r, d.y, money(sec["reviewed"]), 8, True, NAVY)
        d.y -= rh
        n = 0
        for gi, grp in enumerate(sec["groups"]):
            if grp["group"]:
                cont()
                d.text(x_no, d.y, str(gi + 1), 7.5, True, GREY)
                d.text(x_lab, d.y, d.fit(grp["group"], x_nm - x_lab + 90, 7.5), 7.5, True)
                d.y -= rh
            for ln in grp["lines"]:
                cont()
                d.text(x_no, d.y, "abcdefghijklmnopqrstuvwxyz"[n % 26] if grp["group"] else str(n + 1), 7.5, False, GREY)
                n += 1
                d.text(x_lab + (6 if grp["group"] else 0), d.y, d.fit(ln["label"], x_nm - x_lab - 10, 7.5), 7.5)
                d.text(x_nm, d.y, d.fit(ln["name"], x_j - x_nm - 22, 7.5), 7.5, False, GREY)
                d.rtext(x_j, d.y, _qty(ln["qty"]), 7.5)
                d.rtext(x_s, d.y, _qty(ln["sat"]), 7.5)
                d.rtext(x_v, d.y, _qty(ln["vol"]), 7.5)
                d.rtext(x_h, d.y, money(ln["unit_price"]), 7.5)
                d.rtext(x_t, d.y, money(ln["total"]), 7.5, True)
                d.rtext(x_p, d.y, _pct(ln["pct_cogs"]), 7.5, False, GREY)
                if ln["review"] is not None:
                    diff = ln["review"] - ln["total"]
                    d.rtext(x_r, d.y, money(ln["review"]), 7.5, False, RED if diff > 0.5 else (GREEN if diff < -0.5 else None))
                else:
                    d.rtext(x_r, d.y, "as plan", 7, False, GREY)
                d.y -= rh
        d.y -= 2

    # --- the margin stack + the value net of tax, side by side -------------------
    d.ensure(150)
    d.y -= 6
    top = d.y
    lw = full_w * 0.52
    lx, lr, lp = MARGIN, MARGIN + lw - 50, MARGIN + lw - 4
    d.text(lx, d.y, "Cost & margin  (% of net project value)", 10, True, NAVY)
    d.y -= 15
    rows = [("TOTAL COST AWAL", calc["cost_awal"], None, False, None),
            ("Maksimal (belum tax)", calc["contingency"], None, False, None),
            ("TOTAL COST COGS", calc["cogs"], calc["pct"]["cogs"], True, LIGHT["grey"]),
            ("SERVICE FEE (%s)" % _pct(plan["rates"]["service_fee"]), calc["service_fee"], calc["pct"]["service_fee"], False, None),
            ("PROJECT SAVING FEE PSC (%s)" % _pct(plan["rates"]["psc"]), calc["psc"], calc["pct"]["psc"], False, None),
            ("PROFIT ELEMENT", calc["profit"], calc["pct"]["profit"], True, None),
            ("TOTAL PROJECT COST", calc["total_project_cost"], calc["pct"]["total"], True, LIGHT["navy"])]
    for label, amt, pc, bold, fill in rows:
        if fill:
            d.rect_fill(lx, d.y - 3.5, lw - 2, 12, fill)
        d.text(lx + 4, d.y, label, 8, bold)
        d.rtext(lr, d.y, money(amt), 8, bold, RED if amt < 0 else None)
        d.rtext(lp, d.y, _pct(pc) if pc is not None else "", 8, False, GREY)
        d.y -= 12.5
    d.y -= 2
    d.rect_fill(lx, d.y - 4, lw - 2, 14, LIGHT["green"] if calc["nct"] >= 0 else LIGHT["red"])
    d.text(lx + 4, d.y, "NILAI CUAN TERPREDIKSI (NCT)", 8, True, GREEN if calc["nct"] >= 0 else RED)
    d.rtext(lr, d.y, money(calc["nct"]), 8, True, GREEN if calc["nct"] >= 0 else RED)
    d.rtext(lp, d.y, _pct(calc["nct_pct"]), 8, True, GREEN if calc["nct"] >= 0 else RED)
    left_end = d.y - 14

    d.y = top
    rx = MARGIN + lw + 14
    rr = PAGE_W - MARGIN - 4
    d.text(rx, d.y, "Project value (Nilai Anggaran)", 10, True, NAVY)
    d.y -= 15
    vrows = [("Project value (incl. tax)", calc["value"], True),
             ("PPN %s  (value x %s/%s)" % (_pct(plan["rates"]["ppn"]), _qty(plan["rates"]["ppn"] * 100),
                                          _qty(100 + plan["rates"]["ppn"] * 100)), -calc["ppn"], False),
             ("PPh 23 %s  (%s)" % (_pct(plan["rates"]["pph23"]), "of DPP" if calc["tax_method"] == "dpp" else "sheet formula 2/102"),
              -calc["pph23"], False),
             ("Net Project Value", calc["net"], True)]
    for label, amt, bold in vrows:
        if bold and label.startswith("Net"):
            d.rect_fill(rx, d.y - 3.5, rr - rx + 4, 12, LIGHT["teal"])
        d.text(rx + 4, d.y, d.fit(label, rr - rx - 80, 8), 8, bold)
        d.rtext(rr, d.y, money(amt), 8, bold)
        d.y -= 12.5
    d.text(rx + 4, d.y, "Net factor %s of the billed value" % ("%.2f%%" % (calc["net_factor"] * 100)).replace(".", ","), 7, False, GREY)
    d.y -= 14
    d.text(rx, d.y, "Per PT", 8.5, True, NAVY)
    d.y -= 11
    d.text(rx + 4, d.y, "PT", 6.5, True, GREY)
    d.rtext(rr - 120, d.y, "SHARE", 6.5, True, GREY)
    d.rtext(rr - 60, d.y, "VALUE", 6.5, True, GREY)
    d.rtext(rr, d.y, "NET", 6.5, True, GREY)
    d.y -= 10
    for e in calc["entities"]:
        d.text(rx + 4, d.y, d.fit(e["name"], 90, 8), 8)
        d.rtext(rr - 120, d.y, _pct(e["share"]), 8, False, GREY)
        d.rtext(rr - 60, d.y, money(e["amount"]), 8)
        d.rtext(rr, d.y, money(e["net"]), 8)
        d.y -= 11
    d.y = min(d.y, left_end) - 8

    # --- the Finance Review ------------------------------------------------------
    d.ensure(78)
    d.rect_fill(MARGIN, d.y - 52, full_w, 64, LIGHT[sig_bg])
    d.rect_fill(MARGIN, d.y - 52, 4, 64, sig_col)
    d.text(MARGIN + 12, d.y, "FINANCE REVIEW", 8, True, sig_col)
    d.rtext(PAGE_W - MARGIN - 10, d.y, sig_label, 13, True, sig_col)
    cells = [("Reviewed COGS", "Rp " + money(rv["cogs"])),
             ("vs plan", ("+" if rv["delta"] > 0 else "") + money(rv["delta"])),
             ("NCT on review", "Rp " + money(rv["nct"])),
             ("Margin", _pct(rv["margin"]))]
    cw = (full_w - 24) / 4.0
    for i, (k, v) in enumerate(cells):
        x = MARGIN + 12 + i * cw
        d.text(x, d.y - 16, k.upper(), 6.5, True, GREY)
        d.text(x, d.y - 28, d.fit(v, cw - 8, 10), 10, True)
    d.text(MARGIN + 12, d.y - 44, d.fit("%d of %d lines reviewed (the rest count as planned).  GREEN from %s%s, AMBER from %s, RED below."
                                        % (rv["lines_reviewed"], len(calc["lines"]), _pct(rv["green_at"]),
                                           (" - the minimum GP of %s" % rv["scheme"]) if rv.get("scheme") else "",
                                           _pct(rv["amber_at"])), full_w - 24, 7), 7, False, GREY)
    d.y -= 68

    notes = [ln for ln in calc["lines"] if ln.get("review_note")]
    if notes:
        d.ensure(30)
        d.text(MARGIN, d.y, "Finance notes", 9, True, NAVY)
        d.y -= 12
        for ln in notes:
            d.ensure(11)
            d.text(MARGIN + 4, d.y, d.fit("%s: %s" % (ln["label"], ln["review_note"]), full_w - 8, 7.5), 7.5)
            d.y -= 10.5
        d.y -= 6

    # --- the remuneration it would pay ----------------------------------------------
    d.ensure(140)
    d.y -= 4
    sch = remu.get("scheme") or {}
    d.text(MARGIN, d.y, "Remuneration preview - %s" % (sch.get("label") or "no scheme set"), 10, True, NAVY)
    d.y -= 12
    d.text(MARGIN, d.y, d.fit("GP = net project value - reviewed COGS.  Shares use GP, the bringer fee uses the project value.  "
                              "Paid on the actual ledger GP at close-out - this is the plan.", full_w, 7), 7, False, GREY)
    d.y -= 14
    rt = [("GP", remu["gp"]), ("Office (net)", remu["office_net"]), ("Team pool", remu["pool"]),
          ("Partner / BOD", (remu["partner"] or 0) + (remu["bod"] or 0)), ("Bringer", remu["bringer"])]
    tw2 = full_w / len(rt)
    for i, (k, v) in enumerate(rt):
        x = MARGIN + i * tw2
        d.text(x, d.y, k.upper(), 6.5, True, GREY)
        d.text(x, d.y - 11, "Rp " + money(v), 9, True)
    d.y -= 26
    if remu.get("payouts"):
        pc = [("PERSON", MARGIN + 4, "l"), ("GRADE", MARGIN + 200, "l"), ("ROLE", MARGIN + 290, "l"),
              ("FROM", MARGIN + 380, "l"), ("AMOUNT", PAGE_W - MARGIN - 4, "r")]
        d.col_header(pc)
        for po in remu["payouts"]:
            if d.ensure(12):
                d.col_header(pc)
            d.text(MARGIN + 4, d.y, d.fit(po.get("name") or "?", 190, 8), 8)
            d.text(MARGIN + 200, d.y, d.fit(po.get("grade_label") or "", 85, 8), 8, False, GREY)
            d.text(MARGIN + 290, d.y, _REMU_ROLE.get(po["role"], po["role"]), 8)
            d.text(MARGIN + 380, d.y, _REMU_KIND.get(po["kind"], po["kind"]), 8, False, GREY)
            d.rtext(PAGE_W - MARGIN - 4, d.y, money(po["amount"]), 8, True)
            d.y -= 11
    else:
        d.text(MARGIN + 4, d.y, "No team on the plan yet.", 8, False, GREY)
        d.y -= 11
    for nt in remu.get("notes") or []:
        d.ensure(10)
        d.text(MARGIN + 4, d.y, d.fit("- " + nt, full_w - 8, 7), 7, False, GREY)
        d.y -= 9.5
    if plan.get("notes"):
        d.y -= 6
        d.ensure(24)
        d.text(MARGIN, d.y, "Notes", 9, True, NAVY)
        d.y -= 11
        for part in str(plan["notes"]).splitlines():
            d.ensure(10)
            d.text(MARGIN + 4, d.y, d.fit(part, full_w - 8, 7.5), 7.5)
            d.y -= 10

    # --- sign-off --------------------------------------------------------------------
    d.ensure(80)
    d.y -= 18
    bw = (full_w - 2 * 14) / 3.0
    for i, who in enumerate(("Prepared by (PM)", "Reviewed by (Finance)", "Approved by (BOD)")):
        x = MARGIN + i * (bw + 14)
        d.text(x, d.y, who.upper(), 6.5, True, GREY)
        d.line(x, d.y - 46, x + bw, d.y - 46, 0.6, 0.5)
        d.text(x, d.y - 56, "Name / date", 6.5, False, GREY)
    d.y -= 64

    n = len(d.pages)
    for i, frags in enumerate(d.pages, start=1):
        d.cur = frags
        d.line(MARGIN, 34, PAGE_W - MARGIN, 34, 0.4, 0.8)
        d.text(MARGIN, 22, d.fit("MORES RAB ROT - %s%s" % (
            meta.get("name") or "", ("   |   generated %s by %s" % (generated_on, generated_by)) if generated_by else ""), 400, 7), 7, False, GREY)
        d.rtext(PAGE_W - MARGIN, 22, "Page %d of %d" % (i, n), 7, False, GREY)
    return d.build()
