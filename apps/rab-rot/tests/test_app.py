"""MORES RAB ROT (standalone) - the sheet's formulas, the API, the PDF, the
Excel import and the "this computer only" guard.

The figures are the "PROJECT RAB ROT ACTUAL" sheet's own (labels generic):
line = price x JMLH x SAT x VOL, service fee 10% / PSC 5% of the net value,
profit = net - COGS - fee - PSC, PPN = value x 11/111; the old sheet's PPh 23
(value x 2/102) in "excel" mode, 2% of DPP (net = 98/111) by default.

    python apps/rab-rot/tests/test_app.py
"""
import io
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["RAB_ROT_DATA_DIR"] = tempfile.mkdtemp(prefix="rabrot_")

import app as rr  # noqa: E402
import rab_rot  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
    print("  %s  %-14s %s" % ("PASS" if cond else "FAIL", name, detail))


near = lambda a, b, tol=0.01: abs(a - b) <= tol


def L(sec, grp, label, price, qty=1, review=None):
    return {"section": sec, "group": grp, "label": label, "name": "x", "qty": qty, "sat": 1, "vol": 1,
            "unit_price": price, "review": review}


SHEET = {"project_name": "Sample 2027", "client": "Client A", "lines": [
    L("A", "Ahli", "Expert 1", 14e6, review=14.5e6), L("A", "Ahli", "Expert 2", 25e6, review=25.65e6),
    L("A", "Ahli", "Support 1", 7e6, review=7.2e6), L("A", "Pendukung", "Design", 20e6, review=20e6),
    L("B", "", "Printing", 500e3, qty=5, review=7.5e6), L("B", "", "Ops", 5e6, review=0)],
    "entities": [{"name": "PT 1", "amount": 91.5e6}, {"name": "PT 2", "amount": 99.65e6}], "remu_type": "t2"}

print("=== the sheet, cell for cell (old PPh 23 formula) ===")
c = rab_rot.compute(rab_rot.clean(dict(SHEET, tax_method="excel")))
check("I23 awal", c["cost_awal"] == 73.5e6)
check("I35 net", near(c["net"], 168459167.99152094))
check("I27 fee", near(c["service_fee"], 16845916.799152095))
check("I28 PSC", near(c["psc"], 8422958.399576047))
check("I29 profit", near(c["profit"], 69690292.7927928))
check("H30 NCT %", near(c["nct_pct"], 0.5636924907304571, 1e-9))

print("=== PPh 23 on DPP (the default) ===")
c = rab_rot.compute(rab_rot.clean(SHEET))
check("net 98/111", near(c["net"], 191.15e6 * 98 / 111), "%.0f" % c["net"])
check("N22 COGS", c["review"]["cogs"] == 74.85e6)
check("GREEN 55.6%", c["review"]["status"] == "green" and near(c["review"]["margin"], 0.5565, 1e-3))

print("=== the API ===")
cl = rr.app.test_client()
check("health", cl.get("/api/health").get_json()["app"] == "MORES RAB ROT")
check("page", cl.get("/").status_code == 200 and b"MORES RAB ROT" in cl.get("/").data)
check("manifest", cl.get("/manifest.webmanifest").headers["Content-Type"].startswith("application/manifest+json"))
check("sw", cl.get("/sw.js").status_code == 200)
cfg = cl.get("/api/config").get_json()
check("scheme table", len(cfg["schemes"]) == 7 and cfg["grades"][0]["code"] == "G1")
pm = cl.post("/api/people", json={"name": "PM One", "grade": 3}).get_json()["id"]
an = cl.post("/api/people", json={"name": "Analyst One", "grade": 1}).get_json()["id"]
check("bad grade", cl.post("/api/people", json={"name": "X", "grade": 9}).status_code == 400)
data = dict(SHEET, team=[{"person_id": pm, "role": "pm", "involvement": 100}, {"person_id": an, "role": "team", "involvement": 100}])
r = cl.post("/api/plans", json={"name": "Sample 2027", "company": "PT Mores", "prepared_by": "Finance", "data": data})
check("create", r.status_code == 201, str(r.get_json()))
pid = r.get_json()["id"]
d = cl.get("/api/plans/%d" % pid).get_json()
R = d["remu"]
check("remu scheme", R["scheme"]["key"] == "t2_med" and d["calc"]["review"]["green_at"] == 0.35)
check("pool 20%", near(R["pool"], R["gp"] * 0.20, 0.02))
check("pool split", next(x for x in R["payouts"] if x["person_id"] == pm)["amount"]
      > next(x for x in R["payouts"] if x["person_id"] == an)["amount"], "G3 weighs more than G1")
check("live calc", cl.post("/api/calc", json={"data": dict(SHEET, contingency=2e6)}).get_json()["calc"]["cogs"] == 75.5e6)
lst = cl.get("/api/plans").get_json()
check("list", lst[0]["signal"] == "green" and lst[0]["company"] == "PT Mores" and lst[0]["prepared_by"] == "Finance")
check("update", cl.put("/api/plans/%d" % pid, json={"name": "Renamed", "status": "approved", "data": data}).status_code == 200
      and cl.get("/api/plans/%d" % pid).get_json()["plan"]["status"] == "approved")
check("bad status", cl.put("/api/plans/%d" % pid, json={"name": "x", "status": "zzz", "data": data}).status_code == 400)
check("no name", cl.post("/api/plans", json={"data": {}}).status_code == 400)
cp = cl.post("/api/plans/%d/copy" % pid)
check("copy", cp.status_code == 201 and cl.get("/api/plans/%d" % cp.get_json()["id"]).get_json()["plan"]["status"] == "draft")
check("not found", cl.get("/api/plans/9999").status_code == 404)

pdf = cl.get("/api/plans/%d/pdf" % pid)
check("PDF", pdf.status_code == 200 and pdf.data[:5] == b"%PDF-")
try:
    import pdfplumber
    with pdfplumber.open(io.BytesIO(pdf.data)) as doc:
        text = "\n".join(pg.extract_text() or "" for pg in doc.pages)
    check("PDF text", all(x in text for x in ("MORES RAB ROT", "74.850.000", "GREEN", "191.150.000", "PM One", "Finance")))
    check("no HV brand", "MORES HV" not in text)
except ImportError:
    pass

print("=== import the Excel sheet ===")
import openpyxl  # noqa: E402
wb = openpyxl.Workbook()
ws = wb.active
ws["A4"] = "PROJECT NAME :  SAMPLE PROJECT 2027"
for col, h in zip("ABCDEFGHIJ", ["NO", None, "JENIS BIAYA", "Nama", "JMLH", "SAT", "VOL", "Harga Satuan (+TAX)", "TOTAL TRANSVER", "% to COGS"]):
    if h:
        ws[col + "5"] = h
ws["M5"] = "FINANCE REVIEW"
ws.merge_cells("M5:N6")
for row, no, lab, nm, price in ((8, "A.", "BIAYA LANGSUNG PERSONIL", None, None), (9, 1, "Biaya Tenaga Ahli:", None, None),
                                (10, "a", "Expert 1", "Name 1", 14e6), (18, "B.", "BIAYA LANGSUNG NON PERSONIL", None, None),
                                (19, None, "Printing", "LS", 500e3)):
    ws.cell(row, 2, no)
    ws.cell(row, 3, lab)
    if nm:
        ws.cell(row, 4, nm)
        for col in (5, 6, 7):
            ws.cell(row, col, 1)
    if price:
        ws.cell(row, 8, price)
ws["M10"], ws["N10"] = "ok deal", 14.5e6
ws["C23"] = "TOTAL COST AWAL"
ws["C37"] = "Total Nilai Anggaran untuk 2 PT"
ws["C38"], ws["H38"] = "PT 1 : Mores", 91.5e6
buf = io.BytesIO()
wb.save(buf)
buf.seek(0)
r = cl.post("/api/import", data={"file": (buf, "rot.xlsx")}, content_type="multipart/form-data")
check("import", r.status_code == 201 and r.get_json()["lines"] == 2, str(r.get_json()))
imp = cl.get("/api/plans/%d" % r.get_json()["id"]).get_json()
check("imported", imp["plan"]["name"] == "SAMPLE PROJECT 2027" and imp["data"]["lines"][0]["review"] == 14.5e6)
check("not xlsx", cl.post("/api/import", data={"file": (io.BytesIO(b"x"), "a.csv")},
                          content_type="multipart/form-data").status_code == 400)

print("=== this computer only ===")
check("LAN refused", cl.get("/api/plans", environ_base={"REMOTE_ADDR": "192.168.1.20"}).status_code == 403)
check("delete", cl.delete("/api/plans/%d" % pid).status_code == 200 and cl.get("/api/plans/%d" % pid).status_code == 404)

print("\nRESULT: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
