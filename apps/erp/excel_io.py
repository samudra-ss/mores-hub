"""MORES ERP - Excel import/export built on openpyxl."""
import io
import re
from datetime import datetime, date

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

HEADER_FILL = PatternFill("solid", fgColor="1F3864")
HEADER_FONT = Font(color="FFFFFF", bold=True)
TITLE_FONT = Font(bold=True, size=14)
BOLD = Font(bold=True)
NUM_FMT = "#,##0;[Red](#,##0)"
THIN = Border(bottom=Side(style="thin", color="CCCCCC"))


def _sheet(wb, title, report_title, subtitle=""):
    ws = wb.active if wb.active.max_row == 1 and wb.active.max_column == 1 else wb.create_sheet()
    ws.title = title[:31]
    ws["A1"] = report_title
    ws["A1"].font = TITLE_FONT
    if subtitle:
        ws["A2"] = subtitle
        ws["A2"].font = Font(color="666666", italic=True)
    return ws


def _header_row(ws, row, headers, widths=None):
    for i, h in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=i, value=h)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center")
    if widths:
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w


def _num(ws, row, col, value, bold=False):
    cell = ws.cell(row=row, column=col, value=round(value or 0, 2))
    cell.number_format = NUM_FMT
    if bold:
        cell.font = BOLD
    return cell


def _to_bytes(wb):
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


# --------------------------------------------------------------------------
# Exports
# --------------------------------------------------------------------------

def export_trial_balance(tb, scope_label, period_label):
    wb = Workbook()
    ws = _sheet(wb, "Trial Balance", "Trial Balance — %s" % scope_label, period_label)
    _header_row(ws, 4, ["Code", "Account", "Type", "Debit", "Credit", "Balance"],
                [14, 40, 12, 18, 18, 18])
    r = 5
    # grouped by parent account when available: parent rows bold, children
    # indented; balances still reconcile because only leaf rows carry raw amounts
    display = tb.get("grouped") or [dict(x, level=0, is_group=False) for x in tb["rows"]]
    for row in display:
        is_group = row.get("is_group")
        indent = "    " * row.get("level", 0)
        c1 = ws.cell(row=r, column=1, value=row["code"])
        c2 = ws.cell(row=r, column=2, value=indent + row["name"])
        ws.cell(row=r, column=3, value=row["type"].title())
        _num(ws, r, 4, row["debit"], bold=is_group)
        _num(ws, r, 5, row["credit"], bold=is_group)
        _num(ws, r, 6, row["balance"], bold=is_group)
        if is_group:
            c1.font = BOLD
            c2.font = BOLD
        r += 1
    ws.cell(row=r, column=2, value="TOTAL").font = BOLD
    _num(ws, r, 4, tb["total_debit"], bold=True)
    _num(ws, r, 5, tb["total_credit"], bold=True)
    return _to_bytes(wb)


def export_receivables(aging, scope_label):
    wb = Workbook()
    ws = _sheet(wb, "Piutang", "AR Aging (Piutang) — %s" % scope_label,
                "As of %s" % aging["as_of"])
    _header_row(ws, 4, ["No", "Client", "Invoice", "Invoice Date", "Due Date",
                        "Amount", "Outstanding", "Not Due", "1-30 d", "31-60 d",
                        "61-90 d", "> 90 d", "Days Late", "Status"],
                [5, 28, 16, 13, 13, 16, 16, 14, 12, 12, 12, 12, 10, 20])
    bcol = {"not_due": 8, "d1_30": 9, "d31_60": 10, "d61_90": 11, "d90": 12}
    r = 5
    for i, it in enumerate(aging["items"], 1):
        ws.cell(row=r, column=1, value=i)
        ws.cell(row=r, column=2, value=it["client"])
        ws.cell(row=r, column=3, value=it["invoice_no"])
        _date_cell(ws, r, 4, it["invoice_date"])
        _date_cell(ws, r, 5, it["due_date"])
        _num(ws, r, 6, it["amount"])
        _num(ws, r, 7, it["outstanding"])
        if it["bucket"]:
            _num(ws, r, bcol[it["bucket"]], it["outstanding"])
        ws.cell(row=r, column=13, value=it["days_overdue"] or 0)
        ws.cell(row=r, column=14, value=it["status_label"])
        r += 1
    ws.cell(row=r, column=2, value="TOTAL").font = BOLD
    _num(ws, r, 6, aging["total_amount"], bold=True)
    _num(ws, r, 7, aging["total_outstanding"], bold=True)
    for b, col in bcol.items():
        _num(ws, r, col, aging["buckets"][b], bold=True)
    r += 3
    ws.cell(row=r, column=2, value="AGING SUMMARY").font = BOLD
    r += 1
    for s in aging["summary"]:
        ws.cell(row=r, column=2, value=s["label"])
        _num(ws, r, 6, s["amount"])
        pc = ws.cell(row=r, column=7, value=(s["pct"] or 0) / 100.0)
        pc.number_format = "0.0%"
        r += 1
    ws.cell(row=r, column=2, value="TOTAL OUTSTANDING").font = BOLD
    _num(ws, r, 6, aging["total_outstanding"], bold=True)
    return _to_bytes(wb)


def export_payables(aging, scope_label):
    wb = Workbook()
    ws = _sheet(wb, "Hutang", "AP Aging (Hutang) — %s" % scope_label,
                "As of %s" % aging["as_of"])
    _header_row(ws, 4, ["No", "Vendor", "Bill", "Bill Date", "Due Date",
                        "Amount", "Outstanding", "Not Due", "1-30 d", "31-60 d",
                        "61-90 d", "> 90 d", "Days Late", "Status"],
                [5, 28, 16, 13, 13, 16, 16, 14, 12, 12, 12, 12, 10, 20])
    bcol = {"not_due": 8, "d1_30": 9, "d31_60": 10, "d61_90": 11, "d90": 12}
    r = 5
    for i, it in enumerate(aging["items"], 1):
        ws.cell(row=r, column=1, value=i)
        ws.cell(row=r, column=2, value=it["vendor"])
        ws.cell(row=r, column=3, value=it["bill_no"])
        _date_cell(ws, r, 4, it["bill_date"])
        _date_cell(ws, r, 5, it["due_date"])
        _num(ws, r, 6, it["amount"])
        _num(ws, r, 7, it["outstanding"])
        if it["bucket"]:
            _num(ws, r, bcol[it["bucket"]], it["outstanding"])
        ws.cell(row=r, column=13, value=it["days_overdue"] or 0)
        ws.cell(row=r, column=14, value=it["status_label"])
        r += 1
    ws.cell(row=r, column=2, value="TOTAL").font = BOLD
    _num(ws, r, 6, aging["total_amount"], bold=True)
    _num(ws, r, 7, aging["total_outstanding"], bold=True)
    for b, col in bcol.items():
        _num(ws, r, col, aging["buckets"][b], bold=True)
    r += 3
    ws.cell(row=r, column=2, value="AGING SUMMARY").font = BOLD
    r += 1
    for s in aging["summary"]:
        ws.cell(row=r, column=2, value=s["label"])
        _num(ws, r, 6, s["amount"])
        pc = ws.cell(row=r, column=7, value=(s["pct"] or 0) / 100.0)
        pc.number_format = "0.0%"
        r += 1
    ws.cell(row=r, column=2, value="TOTAL OUTSTANDING").font = BOLD
    _num(ws, r, 6, aging["total_outstanding"], bold=True)
    return _to_bytes(wb)


# Wallet / card Excel import — downloadable template + format documentation.
# Column names must match exactly (any column ORDER is fine — lookup is by
# header name); extra columns are ignored.
WALLET_TEMPLATE_COLUMNS = [
    # (header, required, format / accepted values, how it is used)
    ("Transaction Type", "Optional",
     "e.g. PAYMENT · INTERNAL_TRANSFER · CARD_ADD_BALANCE · CARD_REFUND_BALANCE",
     "Internal types (transfers between your own wallets/cards) are detected and left unticked."),
    ("Reference ID", "Recommended", "Any unique text, e.g. WLT-2026-0001",
     "Duplicate detection — a Reference ID already booked is flagged. Blank = auto fingerprint."),
    ("Status", "Optional", "SUCCESS · SETTLED · COMPLETED (anything else = row skipped)",
     "Only successful transactions are imported."),
    ("Category", "Optional",
     "FOOD_AND_BEVERAGE · TRANSPORTATION · EXPEDITION_EXPENSES · OFFICE_SUPPLIES · "
     "SOFTWARE · TELECOMMUNICATION · MISCELLANEOUS",
     "Suggests the expense account: OFFICE_SUPPLIES→6600, SOFTWARE/TELECOMMUNICATION→6300, others→6900."),
    ("Transaction Datetime", "REQUIRED", "YYYY-MM-DD HH:MM:SS or DD/MM/YYYY",
     "The journal entry date."),
    ("Amount", "REQUIRED", "Number. NEGATIVE = money out (spending), positive = money in",
     "Spending is booked: DEBIT the expense account (5000–8000) · CREDIT the Petty Cash / Cash & Bank account."),
    ("Description", "Optional", "Free text", "Journal entry description."),
    ("Account Name", "Optional", "Wallet/account label", "Shown as the source account."),
    ("Card Name", "Optional", "Card label", "Shown with the transaction."),
    ("Recipient Holder Name", "Optional", "Counterparty name", "Merged into the description."),
    ("Notes", "Optional", "Free text", "Merged into the description."),
]

WALLET_TEMPLATE_EXAMPLES = [
    ("PAYMENT", "WLT-2026-0001", "SUCCESS", "FOOD_AND_BEVERAGE",
     "2026-06-10 12:30:00", -150000, "Team lunch", "Ops Wallet", "", "Warung Padang Jaya", ""),
    ("PAYMENT", "WLT-2026-0002", "SUCCESS", "TRANSPORTATION",
     "2026-06-11 09:15:00", -85000, "Ride to client meeting", "Ops Wallet", "Corporate Card", "", ""),
    ("PAYMENT", "WLT-2026-0003", "SETTLED", "OFFICE_SUPPLIES",
     "13/06/2026", -230000, "Printer paper & toner", "Ops Wallet", "", "Toko ATK Sentosa", "Q2 restock"),
    ("INTERNAL_TRANSFER", "WLT-2026-0004", "SUCCESS", "",
     "2026-06-14 10:00:00", 5000000, "Top-up from bank", "Ops Wallet", "", "", "left unticked automatically"),
]


def export_wallet_template():
    """The wallet/card import template: a Transactions sheet ready to fill in
    plus a Format Guide sheet documenting every column and the booking rules."""
    wb = Workbook()
    # Transactions sheet: headers on ROW 1 (exactly like the real wallet
    # export) so the filled-in template parses without any preamble handling
    ws = wb.active
    ws.title = "Transactions"
    headers = [c[0] for c in WALLET_TEMPLATE_COLUMNS]
    _header_row(ws, 1, headers, [20, 16, 12, 22, 21, 14, 28, 14, 14, 22, 20])
    r = 2
    for row in WALLET_TEMPLATE_EXAMPLES:
        for col, val in enumerate(row, start=1):
            cell = ws.cell(row=r, column=col, value=val)
            if headers[col - 1] == "Amount":
                cell.number_format = NUM_FMT
        r += 1

    gd = _sheet(wb, "Format Guide", "Wallet / Card Excel — Format Guide",
                "Fill the Transactions sheet (delete the example rows) and upload it in "
                "Account Parsing → Wallet / Card Excel. Column ORDER does not matter "
                "(lookup is by header name); extra columns are ignored.")
    _header_row(gd, 4, ["Column", "Required", "Format / accepted values", "How it is used"],
                [22, 14, 52, 62])
    r = 5
    for name, req, fmt, use in WALLET_TEMPLATE_COLUMNS:
        gd.cell(row=r, column=1, value=name).font = BOLD
        gd.cell(row=r, column=2, value=req)
        gd.cell(row=r, column=3, value=fmt)
        gd.cell(row=r, column=4, value=use)
        r += 1
    r += 1
    gd.cell(row=r, column=1, value="BOOKING RULES").font = BOLD
    for rule in (
        "Money OUT (negative Amount): DEBIT the expense account you pick (5000–8000 only) "
        "· CREDIT the Petty Cash / Cash & Bank account selected above the table.",
        "Money IN (positive Amount): DEBIT Petty Cash / Cash & Bank · CREDIT the account you pick.",
        "Internal types (INTERNAL_TRANSFER, CARD_ADD_BALANCE, CARD_REFUND_BALANCE) are "
        "detected as moves between your own wallets and left unticked.",
        "Rows whose Status is not SUCCESS / SETTLED / COMPLETED are skipped.",
        "Re-uploading the same file is safe — rows already booked (same Reference ID) are "
        "flagged as duplicates and unticked.",
    ):
        r += 1
        gd.cell(row=r, column=1, value="•")
        gd.cell(row=r, column=2, value=rule)
        gd.merge_cells(start_row=r, start_column=2, end_row=r, end_column=4)
    return _to_bytes(wb)


def export_pnl(pnl, scope_label, period_label):
    wb = Workbook()
    ws = _sheet(wb, "Profit & Loss", "Profit & Loss — %s" % scope_label, period_label)
    _header_row(ws, 4, ["Code", "Account", "Amount"], [10, 42, 20])
    r = 5
    ws.cell(row=r, column=2, value="REVENUE").font = BOLD
    r += 1
    for row in pnl["revenue"]:
        ws.cell(row=r, column=1, value=row["code"])
        ws.cell(row=r, column=2, value=row["name"])
        _num(ws, r, 3, row["balance"])
        r += 1
    ws.cell(row=r, column=2, value="Total Revenue").font = BOLD
    _num(ws, r, 3, pnl["total_revenue"], bold=True)
    r += 2
    ws.cell(row=r, column=2, value="EXPENSES").font = BOLD
    r += 1
    for row in pnl["expense"]:
        ws.cell(row=r, column=1, value=row["code"])
        ws.cell(row=r, column=2, value=row["name"])
        _num(ws, r, 3, row["balance"])
        r += 1
    ws.cell(row=r, column=2, value="Total Expenses").font = BOLD
    _num(ws, r, 3, pnl["total_expense"], bold=True)
    r += 2
    ws.cell(row=r, column=2, value="NET PROFIT").font = Font(bold=True, size=12)
    _num(ws, r, 3, pnl["net_profit"], bold=True)
    return _to_bytes(wb)


def export_balance_sheet(bs, scope_label, period_label):
    wb = Workbook()
    ws = _sheet(wb, "Balance Sheet", "Balance Sheet — %s" % scope_label, period_label)
    _header_row(ws, 4, ["Code", "Account", "Amount"], [10, 42, 20])
    r = 5
    for section, rows, total in [
        ("ASSETS", bs["assets"], bs["total_assets"]),
        ("LIABILITIES", bs["liabilities"], bs["total_liabilities"]),
        ("EQUITY", bs["equity"], bs["total_equity"]),
    ]:
        ws.cell(row=r, column=2, value=section).font = BOLD
        r += 1
        for row in rows:
            ws.cell(row=r, column=1, value=row["code"])
            ws.cell(row=r, column=2, value=row["name"])
            _num(ws, r, 3, row["balance"])
            r += 1
        ws.cell(row=r, column=2, value="Total %s" % section.title()).font = BOLD
        _num(ws, r, 3, total, bold=True)
        r += 2
    return _to_bytes(wb)


def export_budget_vs_actual(bva, scope_label):
    wb = Workbook()
    ws = _sheet(wb, "Budget vs Realization",
                "Budget vs Realization — %s" % scope_label, "Year %s" % bva["year"])
    _header_row(ws, 4, ["Code", "Account", "Type", "Budget", "Realization", "Variance", "Used %"],
                [10, 36, 12, 18, 18, 18, 10])
    r = 5
    for row in bva["rows"]:
        ws.cell(row=r, column=1, value=row["code"])
        ws.cell(row=r, column=2, value=row["name"])
        ws.cell(row=r, column=3, value=row["type"].title())
        _num(ws, r, 4, row["budget"])
        _num(ws, r, 5, row["actual"])
        _num(ws, r, 6, row["variance"])
        if row["used_pct"] is not None:
            ws.cell(row=r, column=7, value=row["used_pct"] / 100).number_format = "0.0%"
        r += 1
    return _to_bytes(wb)


def export_budget_grid(rows, scope_label, year, project_codes=None):
    """rows: [{code, name, project_id, amounts:[12]}]

    Column 2 is the PROJECT CODE, not the account name, so the file this writes
    can be fed straight back into the budget import. It used to write the name
    there, which meant every re-imported row was rejected with "Project code
    'Salaries & Benefits' not found". The name moved to the end, where it is
    still readable and no longer sits in a column the importer reads positionally.
    """
    project_codes = project_codes or {}
    wb = Workbook()
    ws = _sheet(wb, "Budget %s" % year, "Budget — %s" % scope_label, "Year %s" % year)
    _header_row(ws, 4,
                ["Account Code", "Project Code (optional)"] + MONTHS + ["Total", "Account Name"],
                [14, 20] + [13] * 13 + [32])
    r = 5
    for row in rows:
        ws.cell(row=r, column=1, value=row["code"])
        ws.cell(row=r, column=2, value=project_codes.get(row.get("project_id"), ""))
        for m in range(12):
            _num(ws, r, 3 + m, row["amounts"][m])
        _num(ws, r, 15, sum(row["amounts"]), bold=True)
        ws.cell(row=r, column=16, value=row["name"])
        r += 1
    return _to_bytes(wb)


def export_journals(entries, scope_label, period_label):
    """entries: [{entry_no, date, status, description, reference, lines:[{account_code, account_name, project_code, description, debit, credit}]}]"""
    wb = Workbook()
    ws = _sheet(wb, "Journal Entries", "Journal Entries — %s" % scope_label, period_label)
    _header_row(ws, 4, ["Entry No", "Date", "Status", "Entry Description", "Account Code",
                        "Account Name", "Project", "Line Description", "Debit", "Credit"],
                [16, 12, 9, 32, 12, 28, 12, 30, 17, 17])
    r = 5
    for e in entries:
        for ln in e["lines"]:
            ws.cell(row=r, column=1, value=e["entry_no"])
            _date_cell(ws, r, 2, e["date"])
            ws.cell(row=r, column=3, value=e["status"])
            ws.cell(row=r, column=4, value=e["description"])
            ws.cell(row=r, column=5, value=ln["account_code"])
            ws.cell(row=r, column=6, value=ln["account_name"])
            ws.cell(row=r, column=7, value=ln.get("project_code") or "")
            ws.cell(row=r, column=8, value=ln["description"])
            _num(ws, r, 9, ln["debit"])
            _num(ws, r, 10, ln["credit"])
            r += 1
    return _to_bytes(wb)


def export_coa(accounts, scope_label):
    wb = Workbook()
    ws = _sheet(wb, "Chart of Accounts", "Chart of Accounts — %s" % scope_label)
    _header_row(ws, 4, ["Code", "Name", "Type", "Parent Code", "Intercompany", "Active"],
                [10, 40, 12, 12, 13, 8])
    r = 5
    for a in accounts:
        ws.cell(row=r, column=1, value=a["code"])
        ws.cell(row=r, column=2, value=a["name"])
        ws.cell(row=r, column=3, value=a["type"].title())
        ws.cell(row=r, column=4, value=a["parent_code"] or "")
        ws.cell(row=r, column=5, value="Y" if a["is_intercompany"] else "")
        ws.cell(row=r, column=6, value="Y" if a["is_active"] else "N")
        r += 1
    return _to_bytes(wb)


def export_project_performance(rows, scope_label, year):
    wb = Workbook()
    ws = _sheet(wb, "Project Performance",
                "Project Performance — %s" % scope_label, "Year %s" % year)
    _header_row(ws, 4, ["Company", "Code", "Project", "Status", "Revenue", "Expense",
                        "Profit", "Margin %", "Budget Rev", "Budget Exp"],
                [10, 12, 32, 10, 18, 18, 18, 10, 18, 18])
    r = 5
    for p in rows:
        ws.cell(row=r, column=1, value=p["company"])
        ws.cell(row=r, column=2, value=p["code"])
        ws.cell(row=r, column=3, value=p["name"])
        ws.cell(row=r, column=4, value=p["status"])
        _num(ws, r, 5, p["revenue"])
        _num(ws, r, 6, p["expense"])
        _num(ws, r, 7, p["profit"])
        ws.cell(row=r, column=8, value=p["margin_pct"] / 100).number_format = "0.0%"
        _num(ws, r, 9, p["budget_revenue"])
        _num(ws, r, 10, p["budget_expense"])
        r += 1
    return _to_bytes(wb)


def export_cash_flow(cf, scope_label):
    wb = Workbook()
    ws = _sheet(wb, "Cash Flow", "Cash Flow Analysis — %s" % scope_label, "Year %s" % cf["year"])
    _header_row(ws, 4, ["Month", "Cash In", "Cash Out", "Net", "Ending Balance"],
                [12, 20, 20, 20, 20])
    ws.cell(row=5, column=1, value="Opening").font = BOLD
    _num(ws, 5, 5, cf["opening_balance"], bold=True)
    r = 6
    for m in cf["monthly"]:
        ws.cell(row=r, column=1, value=MONTHS[m["month"] - 1])
        _num(ws, r, 2, m["cash_in"])
        _num(ws, r, 3, m["cash_out"])
        _num(ws, r, 4, m["net"])
        _num(ws, r, 5, m["ending"])
        r += 1
    ws.cell(row=r, column=1, value="TOTAL").font = BOLD
    _num(ws, r, 2, cf["total_in"], bold=True)
    _num(ws, r, 3, cf["total_out"], bold=True)
    _num(ws, r, 4, cf["net_change"], bold=True)
    _num(ws, r, 5, cf["closing_balance"], bold=True)
    r += 2
    ws.cell(row=r, column=1, value="SOURCES OF CASH").font = BOLD
    ws.cell(row=r, column=4, value="USES OF CASH").font = BOLD
    r += 1
    for i in range(max(len(cf["sources"]), len(cf["uses"]))):
        if i < len(cf["sources"]):
            s = cf["sources"][i]
            ws.cell(row=r + i, column=1, value="%s %s" % (s["code"], s["name"]))
            _num(ws, r + i, 2, s["amount"])
        if i < len(cf["uses"]):
            u = cf["uses"][i]
            ws.cell(row=r + i, column=4, value="%s %s" % (u["code"], u["name"]))
            _num(ws, r + i, 5, u["amount"])
    return _to_bytes(wb)


# --------------------------------------------------------------------------
# Templates
# --------------------------------------------------------------------------

def template_journals():
    wb = Workbook()
    ws = _sheet(wb, "Journals", "Journal Import Template",
                "One row per line. Rows sharing the same Entry Ref form one entry; debits must equal credits.")
    _header_row(ws, 4, ["Entry Ref", "Date (YYYY-MM-DD)", "Description", "Account Code",
                        "Line Description", "Debit", "Credit", "Project Code"],
                [12, 18, 32, 14, 30, 16, 16, 14])
    sample = [
        ("INV-001", "2026-06-01", "Customer invoice", "1200", "Invoice #123", 50000000, 0, "PRJ-APP"),
        ("INV-001", "2026-06-01", "Customer invoice", "4100", "Invoice #123", 0, 50000000, "PRJ-APP"),
        ("PAY-001", "2026-06-05", "Office supplies", "6600", "Stationery", 1500000, 0, ""),
        ("PAY-001", "2026-06-05", "Office supplies", "1120", "Bank payment", 0, 1500000, ""),
    ]
    for i, row in enumerate(sample):
        for j, v in enumerate(row, start=1):
            ws.cell(row=5 + i, column=j, value=v)
    return _to_bytes(wb)


def template_coa():
    wb = Workbook()
    ws = _sheet(wb, "COA", "Chart of Accounts Import Template",
                "Type must be one of: Asset, Liability, Equity, Revenue, Expense")
    _header_row(ws, 4, ["Code", "Name", "Type", "Parent Code", "Intercompany (Y/N)"],
                [10, 40, 12, 12, 16])
    ws.append([])
    for row in [("1130", "Petty Cash Branch", "Asset", "1100", ""),
                ("6800", "Travel & Entertainment", "Expense", "6000", "")]:
        ws.append(row)
    return _to_bytes(wb)


def template_budget(year):
    wb = Workbook()
    ws = _sheet(wb, "Budget", "Budget Import Template",
                "Amounts per month for year %s. Account Code must exist in the company COA." % year)
    _header_row(ws, 4, ["Account Code", "Project Code (optional)"] + MONTHS, [14, 20] + [13] * 12)
    ws.cell(row=5, column=1, value="6100")
    for m in range(12):
        ws.cell(row=5, column=3 + m, value=500000000)
    return _to_bytes(wb)


# --------------------------------------------------------------------------
# Imports
# --------------------------------------------------------------------------

def upsert_budget_month(conn, company_id, account_id, project_id, year, month, amount):
    """Write a MONTH total into a week-grain budget without destroying the shape.

    Excel is month grain and the budget is week grain, so an import has to decide
    where in the month the money goes. Dumping it all in week 1 would silently
    undo whatever week placement the user set in Budget Center - export, re-import,
    and a deliberately W4-heavy month is a W1 spike again. So: if the month
    already has a shape, keep the shape and rescale it to the new total; only a
    month with nothing in it falls back to week 1.
    """
    existing = conn.execute(
        "SELECT week, amount FROM budgets WHERE company_id=? AND account_id=?"
        " AND project_id IS ? AND year=? AND month=?",
        (company_id, account_id, project_id, year, month)).fetchall()
    shape = [(r[0], r[1]) for r in existing if r[1]]
    total_now = sum(a for _, a in shape)
    amount = round(amount or 0, 2)
    if not shape or not total_now:
        for wk, _ in existing:
            if wk != 1:
                conn.execute(
                    "DELETE FROM budgets WHERE company_id=? AND account_id=?"
                    " AND project_id IS ? AND year=? AND month=? AND week=?",
                    (company_id, account_id, project_id, year, month, wk))
        upsert_budget(conn, company_id, account_id, project_id, year, month, amount, week=1)
        return
    # rescale, and give the last bucket the rounding remainder so the month is exact
    allocated = 0.0
    for i, (wk, a) in enumerate(shape):
        part = (round(amount - allocated, 2) if i == len(shape) - 1
                else round(amount * a / total_now, 2))
        allocated = round(allocated + part, 2)
        upsert_budget(conn, company_id, account_id, project_id, year, month, part, week=wk)


def upsert_budget(conn, company_id, account_id, project_id, year, month, amount, week=1):
    """NULL-safe budget upsert into ONE week bucket."""
    cur = conn.execute(
        "UPDATE budgets SET amount=? WHERE company_id=? AND account_id=?"
        " AND project_id IS ? AND year=? AND month=? AND week=?",
        (round(amount, 2), company_id, account_id, project_id, year, month, week),
    )
    if cur.rowcount == 0:
        conn.execute(
            "INSERT INTO budgets (company_id, account_id, project_id, year, month, week, amount)"
            " VALUES (?,?,?,?,?,?,?)",
            (company_id, account_id, project_id, year, month, week, round(amount, 2)),
        )


def _date_cell(ws, row, col, value):
    """Write an ISO date as a REAL Excel date displayed DD/MM/YYYY, so it sorts
    and filters as a date and reads the way the rest of the app does."""
    cell = ws.cell(row=row, column=col)
    text = str(value or "")[:10]
    try:
        cell.value = datetime.strptime(text, "%Y-%m-%d")
        cell.number_format = "DD/MM/YYYY"
    except ValueError:
        cell.value = value
    return cell


def _iso_date(text):
    """DD/MM/YYYY (how people type it) or YYYY-MM-DD (how a real Excel date
    arrives) -> YYYY-MM-DD, or None when it is neither."""
    text = (text or "").strip()[:10]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _cell_str(v):
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    return str(v).strip()


def _cell_num(v):
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def _find_header(ws, first_col_name):
    for row in ws.iter_rows(min_row=1, max_row=10):
        if _cell_str(row[0].value).lower().startswith(first_col_name.lower()):
            return row[0].row
    return None


def import_journals(conn, company_id, stream, created_by):
    """Returns (created_entries, errors)."""
    wb = load_workbook(stream, data_only=True)
    ws = wb.active
    hdr = _find_header(ws, "Entry Ref")
    if not hdr:
        return 0, ["Header row not found — first column must be 'Entry Ref'. Use the template."]
    accounts = {r["code"]: r["id"] for r in conn.execute(
        "SELECT id, code FROM accounts WHERE company_id=? AND is_active=1", (company_id,))}
    projects = {r["code"]: r["id"] for r in conn.execute(
        "SELECT id, code FROM projects WHERE company_id=?", (company_id,))}

    groups, errors = {}, []
    for row in ws.iter_rows(min_row=hdr + 1, values_only=True):
        if not row or not _cell_str(row[0]):
            continue
        ref = _cell_str(row[0])
        entry_date = _iso_date(_cell_str(row[1]))
        if not entry_date:
            errors.append("Entry %s: invalid date '%s' (use DD/MM/YYYY)" % (ref, _cell_str(row[1])))
            continue
        code = _cell_str(row[3])
        if code not in accounts:
            errors.append("Entry %s: account code '%s' not found in this company" % (ref, code))
            continue
        pcode = _cell_str(row[7]) if len(row) > 7 else ""
        if pcode and pcode not in projects:
            errors.append("Entry %s: project code '%s' not found" % (ref, pcode))
            continue
        g = groups.setdefault(ref, {"date": entry_date, "description": _cell_str(row[2]), "lines": []})
        g["lines"].append({
            "account_id": accounts[code],
            "description": _cell_str(row[4]),
            "debit": _cell_num(row[5]),
            "credit": _cell_num(row[6]),
            "project_id": projects.get(pcode),
        })

    if errors:
        return 0, errors

    created = 0
    for ref, g in groups.items():
        total_d = round(sum(l["debit"] for l in g["lines"]), 2)
        total_c = round(sum(l["credit"] for l in g["lines"]), 2)
        if abs(total_d - total_c) > 0.01:
            errors.append("Entry %s is not balanced (debit %.2f vs credit %.2f) — skipped" % (ref, total_d, total_c))
            continue
        if total_d == 0:
            errors.append("Entry %s has zero amount — skipped" % ref)
            continue
        n = conn.execute(
            "SELECT COUNT(*)+1 FROM journal_entries WHERE company_id=?", (company_id,)
        ).fetchone()[0]
        entry_no = "IMP-%s-%05d" % (g["date"][:7].replace("-", ""), n)
        cur = conn.execute(
            "INSERT INTO journal_entries (company_id, entry_no, date, description, reference, status, source, created_by)"
            " VALUES (?,?,?,?,?,'draft','excel',?)",
            (company_id, entry_no, g["date"], g["description"], ref, created_by),
        )
        for l in g["lines"]:
            conn.execute(
                "INSERT INTO journal_lines (entry_id, account_id, project_id, description, debit, credit)"
                " VALUES (?,?,?,?,?,?)",
                (cur.lastrowid, l["account_id"], l["project_id"], l["description"],
                 round(l["debit"], 2), round(l["credit"], 2)),
            )
        created += 1
    conn.commit()
    return created, errors


def import_coa(conn, company_id, stream):
    wb = load_workbook(stream, data_only=True)
    ws = wb.active
    hdr = _find_header(ws, "Code")
    if not hdr:
        return 0, 0, ["Header row not found — first column must be 'Code'. Use the template."]
    valid_types = {"asset", "liability", "equity", "revenue", "expense"}
    created = updated = 0
    errors = []
    for row in ws.iter_rows(min_row=hdr + 1, values_only=True):
        if not row or not _cell_str(row[0]):
            continue
        code, name = _cell_str(row[0]), _cell_str(row[1])
        typ = _cell_str(row[2]).lower()
        parent = _cell_str(row[3]) if len(row) > 3 else ""
        if not parent and "-" in code:
            parent = code.rsplit("-", 1)[0]  # derivative: 5100-01-01 -> 5100-01
        ic = 1 if (len(row) > 4 and _cell_str(row[4]).upper() in ("Y", "YES", "1")) else 0
        if typ not in valid_types:
            errors.append("Account %s: invalid type '%s'" % (code, typ))
            continue
        if code.count("-") > 2:
            errors.append("Account %s: maximum 3 levels (e.g. 5100-01-01)" % code)
            continue
        existing = conn.execute(
            "SELECT id FROM accounts WHERE company_id=? AND code=?", (company_id, code)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE accounts SET name=?, type=?, parent_code=?, is_intercompany=? WHERE id=?",
                (name, typ, parent or None, ic, existing["id"]))
            updated += 1
        else:
            conn.execute(
                "INSERT INTO accounts (company_id, code, name, type, parent_code, is_intercompany)"
                " VALUES (?,?,?,?,?,?)",
                (company_id, code, name, typ, parent or None, ic))
            created += 1
    conn.commit()
    return created, updated, errors


def import_budget(conn, company_id, year, stream):
    wb = load_workbook(stream, data_only=True)
    ws = wb.active
    hdr = _find_header(ws, "Account Code")
    if not hdr:
        return 0, ["Header row not found — first column must be 'Account Code'. Use the template."]
    accounts = {r["code"]: r["id"] for r in conn.execute(
        "SELECT id, code FROM accounts WHERE company_id=?", (company_id,))}
    projects = {r["code"]: r["id"] for r in conn.execute(
        "SELECT id, code FROM projects WHERE company_id=?", (company_id,))}
    saved, errors = 0, []
    for row in ws.iter_rows(min_row=hdr + 1, values_only=True):
        if not row or not _cell_str(row[0]):
            continue
        code = _cell_str(row[0])
        if code not in accounts:
            errors.append("Account code '%s' not found — row skipped" % code)
            continue
        pcode = _cell_str(row[1]) if len(row) > 1 else ""
        if pcode and pcode not in projects:
            errors.append("Project code '%s' not found — row skipped" % pcode)
            continue
        pid = projects.get(pcode)
        for m in range(12):
            amount = _cell_num(row[2 + m]) if len(row) > 2 + m else 0.0
            upsert_budget_month(conn, company_id, accounts[code], pid, year, m + 1, amount)
        saved += 1
    conn.commit()
    return saved, errors


# --------------------------------------------------------------------------
# SBU model workbook - set up (or back up) a whole SBU from one Excel file
# --------------------------------------------------------------------------

# key, label, kind, note. The key sits in a hidden column so a label can be
# reworded (or translated) inside the file without breaking the import.
SBU_FIELDS = [
    ("name", "SBU name", "text", "Required."),
    ("code", "Code", "text", "e.g. SBU-01 - blank keeps the current code"),
    ("company", "Company code", "text", "The owning company, e.g. SBR"),
    ("stage", "Stage", "stage", "idea / build / launch / growth / sunset"),
    ("launch_month", "Launch month", "month", "MM/YYYY"),
    ("target_year", "Must be profitable by (year)", "int", "e.g. 2027"),
    ("actual_through", "Actual through", "month", "MM/YYYY - blank = the last month the ledger has"),
    ("horizon_end", "Model until", "month", "MM/YYYY - blank = December of the target year"),
    ("burn_budget", "Burn budget (Rp)", "money", "What the company is prepared to lose before it pays back"),
    ("notes", "Notes", "text", ""),
    ("arpu", "Price per active user / month (Rp)", "money", "ARPU"),
    ("arpu_growth_annual", "Price rise per year", "pct", "A percentage"),
    ("revenue_start_month", "Subscription revenue starts", "month", "MM/YYYY - blank = the launch month"),
    ("start_users", "Users already on board then", "number", ""),
    ("new_users_first", "New users in the first month", "number", ""),
    ("new_users_growth", "Growth in new users / month", "pct", "A percentage"),
    ("churn_monthly", "Churn / month", "pct", "A percentage of the opening base lost each month"),
    ("server_base", "Server base cost / month (Rp)", "money", "Runs whether anyone logs in or not"),
    ("server_per_user", "Server cost per active user / month (Rp)", "money", ""),
    ("server_step_users", "Add a capacity tier every N users", "int", "0 = no tiers"),
    ("server_step_cost", "Each tier costs / month (Rp)", "money", ""),
]
_SBU_ASSUMPTIONS = {"arpu", "arpu_growth_annual", "revenue_start_month", "start_users", "new_users_first",
                    "new_users_growth", "churn_monthly", "server_base", "server_per_user",
                    "server_step_users", "server_step_cost"}
_PCT_FMT = "0.00%"


def _month_out(v):
    v = str(v or "")
    return "%s/%s" % (v[5:7], v[:4]) if re.match(r"^\d{4}-\d{2}", v) else None


def _sbu_month_in(v):
    """MM/YYYY as typed, a real Excel date, YYYY-MM or DD/MM/YYYY -> YYYY-MM."""
    if v in (None, ""):
        return None
    if isinstance(v, (datetime, date)):
        return "%04d-%02d" % (v.year, v.month)
    s = str(v).strip()
    for pattern, yi, mi in ((r"^(\d{1,2})[/-](\d{4})$", 2, 1),
                            (r"^(\d{4})-(\d{1,2})(?:-\d{1,2})?$", 1, 2),
                            (r"^\d{1,2}/(\d{1,2})/(\d{4})$", 2, 1)):
        m = re.match(pattern, s)
        if m and 1 <= int(m.group(mi)) <= 12:
            return "%s-%02d" % (m.group(yi), int(m.group(mi)))
    raise ValueError("'%s' is not a month - write it as MM/YYYY" % s)


def _sbu_money_in(v):
    if v in (None, ""):
        return 0.0
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).replace("Rp", "").replace("rp", "").replace(" ", "").strip()
    if re.match(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$", s):        # 1.200.000,50
        s = s.replace(".", "").replace(",", ".")
    elif re.match(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$", s):      # 1,200,000.50
        s = s.replace(",", "")
    elif "," in s and "." not in s:                          # 2,5
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        raise ValueError("'%s' is not an amount" % v)


def _sbu_pct_in(cell):
    """The workbook holds real Excel percentages (0.02 shown as 2%). A plain
    cell holding 2, or the text '2%', means 2% as well."""
    v = getattr(cell, "value", cell)
    if v in (None, ""):
        return 0.0
    if isinstance(v, str):
        s = v.strip()
        return _sbu_money_in(s[:-1] if s.endswith("%") else s) / 100.0
    fmt = getattr(cell, "number_format", "") or ""
    return float(v) if "%" in fmt else float(v) / 100.0


def _sbu_int_in(v):
    if v in (None, ""):
        return 0
    try:
        return int(round(_sbu_money_in(v)))
    except ValueError:
        raise ValueError("'%s' is not a whole number" % v)


def _sbu_category_in(v, categories):
    s = _cell_str(v).lower()
    if not s:
        return "other"
    for key, label in categories:
        if s in (key, label.lower()):
            return key
    raise ValueError("unknown category '%s' - use %s" % (_cell_str(v), " / ".join(k for k, _ in categories)))


def _note(ws, ref, text):
    ws[ref] = text
    ws[ref].font = Font(color="666666", italic=True)


def export_sbu_workbook(sbu, company_code, linked_projects, all_projects, categories, stages):
    """One workbook that IS the SBU model: settings and drivers, cost lines,
    one-offs, CAPEX and linked projects. Download it, edit it, import it back.
    An empty `sbu` gives the blank template."""
    wb = Workbook()
    a = sbu.get("assumptions") or {}
    ws = _sheet(wb, "SBU", "SBU model - %s" % (sbu.get("name") or "new SBU"),
                "Fill in the Value column. Months are MM/YYYY, percentages are percentages. "
                "Importing the file replaces the SBU's whole model with what it says.")
    _header_row(ws, 4, ["Field", "Value", "Notes", "key"], [42, 26, 66, 4])
    stage_row = None
    for i, (key, label, kind, note) in enumerate(SBU_FIELDS):
        r = 5 + i
        ws.cell(row=r, column=1, value=label).font = BOLD
        val = company_code if key == "company" else (a.get(key) if key in _SBU_ASSUMPTIONS else sbu.get(key))
        cell = ws.cell(row=r, column=2)
        if kind == "month":
            cell.value = _month_out(val)
        elif kind == "pct":
            cell.value = float(val or 0)
            cell.number_format = _PCT_FMT
        elif kind == "money":
            cell.value = float(val or 0)
            cell.number_format = NUM_FMT
        elif kind in ("int", "number"):
            cell.value = val if val not in (None, "") else 0
        else:
            cell.value = val or None
        if key == "stage":
            stage_row = r
        ws.cell(row=r, column=3, value=note or None).font = Font(color="666666", italic=True)
        ws.cell(row=r, column=4, value=key).font = Font(color="BBBBBB")
    ws.column_dimensions["D"].hidden = True
    dv = DataValidation(type="list", formula1='"%s"' % ",".join(stages), allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("B%d" % stage_row)

    cats = [k for k, _ in categories]
    lines = sbu.get("lines") or []
    wl = wb.create_sheet("Cost lines")
    wl["A1"] = "Forecast cost lines"
    wl["A1"].font = TITLE_FONT
    _note(wl, "A2", "Category: %s. Basis: per month or per working day. A blank From means the line "
                    "runs from the first forecast month." % " / ".join(cats))
    _header_row(wl, 4, ["Line", "Category", "Amount (Rp)", "Basis", "From (MM/YYYY)", "Until (MM/YYYY)",
                        "Rise per year"], [38, 14, 18, 18, 16, 16, 14])
    for i, ln in enumerate(lines):
        r = 5 + i
        wl.cell(row=r, column=1, value=ln.get("label") or None)
        wl.cell(row=r, column=2, value=ln.get("category") or "other")
        _num(wl, r, 3, ln.get("monthly_amount"))
        wl.cell(row=r, column=4, value="per working day" if ln.get("basis") == "per_working_day" else "per month")
        wl.cell(row=r, column=5, value=_month_out(ln.get("start_month")))
        wl.cell(row=r, column=6, value=_month_out(ln.get("end_month")))
        wl.cell(row=r, column=7, value=float(ln.get("escalation_annual") or 0)).number_format = _PCT_FMT
    for r in range(5 + len(lines), 201):
        wl.cell(row=r, column=7).number_format = _PCT_FMT   # a typed 5 becomes 5%, as Excel does
    for col, options in (("B", cats), ("D", ["per month", "per working day"])):
        v = DataValidation(type="list", formula1='"%s"' % ",".join(options), allow_blank=True)
        wl.add_data_validation(v)
        v.add("%s5:%s500" % (col, col))

    wo = wb.create_sheet("One-offs")
    wo["A1"] = "One-off items"
    wo["A1"].font = TITLE_FONT
    _note(wo, "A2", "Direction: in (money coming in, e.g. a termin) or out. Months that are already "
                    "actual are ignored - the ledger decides what happened in those.")
    _header_row(wo, 4, ["Month (MM/YYYY)", "Direction", "What", "Amount (Rp)"], [18, 12, 42, 18])
    for i, o in enumerate(sbu.get("oneoffs") or []):
        r = 5 + i
        wo.cell(row=r, column=1, value=_month_out(o.get("month")))
        wo.cell(row=r, column=2, value="in" if o.get("flow") == "in" else "out")
        wo.cell(row=r, column=3, value=o.get("label") or None)
        _num(wo, r, 4, o.get("amount"))
    v = DataValidation(type="list", formula1='"in,out"', allow_blank=True)
    wo.add_data_validation(v)
    v.add("B5:B500")

    wc = wb.create_sheet("CAPEX")
    wc["A1"] = "CAPEX register"
    wc["A1"].font = TITLE_FONT
    _note(wc, "A2", "Cash when bought, then depreciated straight-line over its life.")
    _header_row(wc, 4, ["Month bought (MM/YYYY)", "Asset", "Amount (Rp)", "Life (months)"], [22, 42, 18, 14])
    for i, cx in enumerate(sbu.get("capex") or []):
        r = 5 + i
        wc.cell(row=r, column=1, value=_month_out(cx.get("month")))
        wc.cell(row=r, column=2, value=cx.get("label") or None)
        _num(wc, r, 3, cx.get("amount"))
        wc.cell(row=r, column=4, value=int(cx.get("life_months") or 48))

    wp = wb.create_sheet("Projects")
    wp["A1"] = "Ledger projects this SBU spends from"
    wp["A1"].font = TITLE_FONT
    _note(wp, "A2", "Actual months come from posted journal lines on these projects, in whichever "
                    "company's books they were booked. Copy codes from the 'Project list' sheet.")
    _header_row(wp, 4, ["Project code", "Company code (needed only if the code exists in two companies)",
                        "Project name (reference only)"], [18, 30, 46])
    for i, p in enumerate(linked_projects or []):
        r = 5 + i
        wp.cell(row=r, column=1, value=p.get("code") or None)
        wp.cell(row=r, column=2, value=p.get("company_code") or None)
        wp.cell(row=r, column=3, value=p.get("name") or None)

    wr = wb.create_sheet("Project list")
    wr["A1"] = "Every project you can link"
    wr["A1"].font = TITLE_FONT
    _header_row(wr, 3, ["Project code", "Company code", "Project name"], [18, 16, 52])
    for i, p in enumerate(all_projects or []):
        r = 4 + i
        wr.cell(row=r, column=1, value=p.get("code") or None)
        wr.cell(row=r, column=2, value=p.get("company_code") or None)
        wr.cell(row=r, column=3, value=p.get("name") or None)
    wb.active = 0
    return _to_bytes(wb)


def parse_sbu_workbook(stream, categories, stages):
    """Read an SBU model workbook -> (payload, errors).

    The payload has the shape PUT /api/products/<id> takes, plus company_code and
    project_refs for the server to resolve. Nothing is written here, and the
    server applies nothing when any error is reported: half an imported model is
    worse than none, because it looks finished.
    """
    try:
        wb = load_workbook(stream, data_only=True)
    except Exception:
        return None, ["That file could not be opened as an Excel workbook (.xlsx)."]
    sheets = {w.title.strip().lower(): w for w in wb.worksheets}
    ws = sheets.get("sbu")
    if ws is None:
        return None, ["This is not an SBU model workbook - it has no sheet named 'SBU'. "
                      "Download the template from the SBU page."]
    errors, payload = [], {"assumptions": {}}
    kinds = {k: kind for k, _, kind, _ in SBU_FIELDS}
    by_label = {label.lower(): k for k, label, _, _ in SBU_FIELDS}
    for row in ws.iter_rows(min_row=5):
        if not row:
            continue
        label = _cell_str(row[0].value)
        key = _cell_str(row[3].value) if len(row) > 3 else ""
        if key not in kinds:
            key = by_label.get(label.lower())
        if not key:
            continue
        cell = row[1] if len(row) > 1 else None
        raw = cell.value if cell is not None else None
        kind = kinds[key]
        try:
            if kind == "month":
                val = _sbu_month_in(raw)
            elif kind == "pct":
                val = _sbu_pct_in(cell)
            elif kind in ("money", "number"):
                val = _sbu_money_in(raw)
            elif kind == "int":
                val = _sbu_int_in(raw)
            elif kind == "stage":
                val = _cell_str(raw).lower() or "build"
                if val not in stages:
                    raise ValueError("stage must be one of %s" % " / ".join(stages))
            else:
                val = _cell_str(raw)
        except ValueError as e:
            errors.append("SBU sheet, %s: %s" % (label or key, e))
            continue
        if key == "company":
            payload["company_code"] = val
        elif key in _SBU_ASSUMPTIONS:
            payload["assumptions"][key] = val
        else:
            payload[key] = val
    if not payload.get("name"):
        errors.append("SBU sheet: 'SBU name' is required.")
    for key in ("code", "target_year"):            # blank keeps what the SBU already has
        if not payload.get(key):
            payload.pop(key, None)

    def rows_of(name):
        s = sheets.get(name)
        return None if s is None else list(enumerate(s.iter_rows(min_row=5), start=5))

    def at(r, i):
        return r[i].value if i < len(r) else None

    rs = rows_of("cost lines")
    if rs is not None:
        lines = []
        for n, r in rs:
            label, amount = _cell_str(at(r, 0)), at(r, 2)
            if not label and amount in (None, ""):
                continue
            try:
                lines.append({
                    "label": label or "Cost line",
                    "category": _sbu_category_in(at(r, 1), categories),
                    "monthly_amount": _sbu_money_in(amount),
                    "basis": "per_working_day" if "working" in _cell_str(at(r, 3)).lower() else "fixed",
                    "start_month": _sbu_month_in(at(r, 4)),
                    "end_month": _sbu_month_in(at(r, 5)),
                    "escalation_annual": _sbu_pct_in(r[6] if len(r) > 6 else None),
                })
            except ValueError as e:
                errors.append("Cost lines row %d: %s" % (n, e))
        payload["lines"] = lines

    rs = rows_of("one-offs")
    if rs is not None:
        out = []
        for n, r in rs:
            m, amount = at(r, 0), at(r, 3)
            if m in (None, "") and amount in (None, ""):
                continue
            try:
                month = _sbu_month_in(m)
                if not month:
                    raise ValueError("a month is required")
                d = _cell_str(at(r, 1)).lower()
                if d in ("in", "money in", "masuk"):
                    flow = "in"
                elif d in ("", "out", "money out", "keluar"):
                    flow = "out"
                else:
                    raise ValueError("direction must be in or out")
                out.append({"month": month, "flow": flow, "label": _cell_str(at(r, 2)),
                            "amount": _sbu_money_in(amount)})
            except ValueError as e:
                errors.append("One-offs row %d: %s" % (n, e))
        payload["oneoffs"] = out

    rs = rows_of("capex")
    if rs is not None:
        out = []
        for n, r in rs:
            m, amount = at(r, 0), at(r, 2)
            if m in (None, "") and amount in (None, ""):
                continue
            try:
                month = _sbu_month_in(m)
                if not month:
                    raise ValueError("a month is required")
                out.append({"month": month, "label": _cell_str(at(r, 1)), "amount": _sbu_money_in(amount),
                            "life_months": _sbu_int_in(at(r, 3)) or 48})
            except ValueError as e:
                errors.append("CAPEX row %d: %s" % (n, e))
        payload["capex"] = out

    rs = rows_of("projects")
    if rs is not None:
        payload["project_refs"] = [(n, _cell_str(at(r, 0)), _cell_str(at(r, 1)))
                                   for n, r in rs if _cell_str(at(r, 0))]
    return payload, errors
