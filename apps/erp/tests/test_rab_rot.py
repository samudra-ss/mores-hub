"""v1.13 RAB ROT: the project cost plan sheet as a form.

Pins the "PROJECT RAB ROT ACTUAL" sheet's formulas with its own numbers (labels
made generic): line = price x JMLH x SAT x VOL, service fee 10% / PSC 5% of the
net value, profit = net - COGS - fee - PSC, PPN = value x 11/111. The old
sheet's PPh 23 (value x 2/102) is reproduced exactly in "excel" mode; the
default withholds 2% of DPP (net = 98/111). Also: the Finance Review signal,
the remuneration preview, the Excel import, the PDF, and access.

    python apps/erp/tests/test_rab_rot.py
"""
import io
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["MORES_HV_DATA_DIR"] = tempfile.mkdtemp(prefix="rab_")

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import rab_rot  # noqa: E402
import server  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    ok, fail = (ok + 1, fail) if cond else (ok, fail + 1)
    print("  %s  %-14s %s" % ("PASS" if cond else "FAIL", name, detail))


near = lambda a, b, tol=0.01: abs(a - b) <= tol
L = lambda sec, grp, label, price, qty=1, review=None: {"section": sec, "group": grp, "label": label, "name": "x",
                                                      "qty": qty, "sat": 1, "vol": 1, "unit_price": price, "review": review}
SHEET = {"project_name": "Sample 2027", "lines": [
    L("A", "Ahli", "Expert 1", 14e6, review=14.5e6), L("A", "Ahli", "Expert 2", 25e6, review=25.65e6),
    L("A", "Ahli", "Support 1", 7e6, review=7.2e6), L("A", "Pendukung", "Design", 20e6, review=20e6),
    L("B", "", "Printing", 500e3, qty=5, review=7.5e6), L("B", "", "Ops", 5e6, review=0)],
    "entities": [{"name": "PT 1", "amount": 91.5e6}, {"name": "PT 2", "amount": 99.65e6}], "remu_type": "t2"}

print("=== the sheet, cell for cell (old PPh 23 formula) ===")
p = rab_rot.clean(dict(SHEET, tax_method="excel"))
c = rab_rot.compute(p)
check("I19 line", c["lines"][4]["total"] == 2.5e6, "500.000 x 5")
check("I23 awal", c["cost_awal"] == 73.5e6)
check("I33 PPN", near(c["ppn"], 18942792.792792793))
check("I34 PPh23", near(c["pph23"], 3748039.2156862747))
check("I35 net", near(c["net"], 168459167.99152094))
check("I27 fee", near(c["service_fee"], 16845916.799152095))
check("I28 PSC", near(c["psc"], 8422958.399576047))
check("I29 profit", near(c["profit"], 69690292.7927928))
check("H27 NCT", near(c["nct"], 94959167.99152094))
check("H30 NCT %", near(c["nct_pct"], 0.5636924907304571, 1e-9))
check("J10 %COGS", near(c["lines"][0]["pct_cogs"], 0.19047619047619047, 1e-9))
check("J26 %", near(c["pct"]["cogs"], 0.43630750926954287, 1e-9))

print("=== PPh 23 on DPP (the default) ===")
p = rab_rot.clean(SHEET)
c = rab_rot.compute(p)
check("DPP", near(c["dpp"], 191.15e6 * 100 / 111))
check("PPh23 2% DPP", near(c["pph23"], c["dpp"] * 0.02))
check("net 98/111", near(c["net"], 191.15e6 * 98 / 111), "%.0f" % c["net"])
check("factor", near(c["net_factor"], 0.8829, 1e-4), "= the Finance Review's 88.29%")
check("PT nets add", near(sum(e["net"] for e in c["entities"]), c["net"]))
check("excel_net", near(c["excel_net"], 168459167.99152094))

print("=== Finance Review ===")
r = c["review"]
check("N22 COGS", r["cogs"] == 74.85e6)
check("NCT on review", near(r["nct"], c["net"] - 74.85e6))
check("margin ~55.6%", near(r["margin"], 0.5565, 1e-3), "%.4f" % r["margin"])
check("GREEN", rab_rot.compute(p)["review"]["status"] == "green")
check("no scheme 40%", r["green_at"] == 0.40)
import remuneration  # noqa: E402
cfg = remuneration.config(database.get_db(database.DEFAULT_DB))
r2 = rab_rot.compute(p, cfg)["review"]
check("scheme min GP", r2["green_at"] == 0.35 and r2["scheme"] == "Type 2 Medium", "Type 2 Medium: green from 35%")
heavy = rab_rot.clean(dict(SHEET, lines=SHEET["lines"] + [L("B", "", "Big", 50e6)]))
check("RED", rab_rot.compute(heavy)["review"]["status"] == "red",
      "%.3f" % rab_rot.compute(heavy)["review"]["margin"])
check("AMBER", rab_rot.status_for(0.33, 0.40) == "amber" and rab_rot.status_for(0.29, 0.40) == "red")
check("contingency", rab_rot.compute(rab_rot.clean(dict(SHEET, contingency=1e6)))["cogs"] == 74.5e6)
try:
    rab_rot.clean(dict(SHEET, rates={"ppn": 1.5}))
    check("rate guard", False)
except ValueError:
    check("rate guard", True)
check("ID numbers", rab_rot._num("1.250.000,50") == 1250000.5 and rab_rot._num("Rp 14.000.000") == 14e6)

print("=== the API ===")
cl = server.app.test_client()
assert cl.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
pm = cl.post("/api/remuneration/people", json={"name": "PM One", "grade": 3}).get_json()["id"]
an = cl.post("/api/remuneration/people", json={"name": "Analyst One", "grade": 1}).get_json()["id"]
data = dict(SHEET, team=[{"person_id": pm, "role": "pm", "involvement": 100}, {"person_id": an, "role": "team", "involvement": 100}])
rv = cl.post("/api/rab/plans", json={"name": "Sample 2027", "data": data})
check("create", rv.status_code == 201, str(rv.get_json()))
pid = rv.get_json()["id"]
d = cl.get("/api/rab/plans/%d" % pid).get_json()
R = d["remu"]
check("remu scheme", R["scheme"]["key"] == "t2_med")
check("remu GP", near(R["gp"], d["calc"]["net"] - 74.85e6, 0.02))
check("pool 20%", near(R["pool"], R["gp"] * 0.20, 0.02))
check("pool split", near(sum(x["amount"] for x in R["payouts"] if x["kind"] == "pool"), R["pool"], 0.05)
      and next(x for x in R["payouts"] if x["person_id"] == pm)["amount"] > next(x for x in R["payouts"] if x["person_id"] == an)["amount"],
      "G3 weighs more than G1")
calc = cl.post("/api/rab/calc", json={"data": dict(SHEET, contingency=2e6)}).get_json()["calc"]
check("live calc", calc["cogs"] == 75.5e6)
check("list", cl.get("/api/rab/plans").get_json()[0]["signal"] == "green")
check("update", cl.put("/api/rab/plans/%d" % pid, json={"name": "Renamed", "status": "approved", "data": data}).status_code == 200
      and cl.get("/api/rab/plans/%d" % pid).get_json()["plan"]["status"] == "approved")
check("bad status", cl.put("/api/rab/plans/%d" % pid, json={"name": "x", "status": "zzz", "data": data}).status_code == 400)
pdf = cl.get("/api/rab/plans/%d/pdf" % pid)
check("PDF", pdf.status_code == 200 and pdf.data[:5] == b"%PDF-" and b"RAB_ROT_Renamed" in pdf.headers["Content-Disposition"].encode())
try:
    import pdfplumber
    with pdfplumber.open(io.BytesIO(pdf.data)) as doc:
        text = "\n".join(pg.extract_text() or "" for pg in doc.pages)
    check("PDF text", "74.850.000" in text and "GREEN" in text and "191.150.000" in text and "PM One" in text)
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
rows = [(8, "A.", "BIAYA LANGSUNG PERSONIL", None, None), (9, 1, "Biaya Tenaga Ahli:", None, None),
        (10, "a", "Expert 1", "Name 1", 14e6), (11, "b", "Expert 2", "Name 2", 25e6), (12, "c", "Support 1", "Name 3", 7e6),
        (13, "d", "Support 2", "(include in PHD)", None), (15, 2, "Biaya Tenaga Pendukung", None, None),
        (16, None, "Design", "Name 4", 20e6), (18, "B.", "BIAYA LANGSUNG NON PERSONIL", None, None),
        (19, None, "Printing", "LS", 500e3), (20, None, "Ops", "LS", 5e6)]
for r, no, lab, nm, price in rows:
    ws.cell(r, 2, no)
    ws.cell(r, 3, lab)
    if nm:
        ws.cell(r, 4, nm)
        for col in (5, 6, 7):
            ws.cell(r, col, 1)
    if price:
        ws.cell(r, 8, price)
ws["E19"] = 5
for r, note, v in ((10, "ok deal", 14.5e6), (11, "PhD all in", 25.65e6), (14, "helper", 7.2e6), (16, "design", 20e6),
                   (19, "spare", 7.5e6), (22, "NILAI COGS", 74.85e6)):
    ws.cell(r, 13, note)
    ws.cell(r, 14, v)
ws.merge_cells("N11:N13")
ws.merge_cells("N19:N20")
ws["C23"] = "TOTAL COST AWAL"
ws["E24"] = "maksimal (belum tax)"
ws["I24"] = 0
ws["C37"] = "Total Nilai Anggaran untuk 2 PT"
ws["C38"], ws["H38"] = "PT 1 : Mores", 91.5e6
ws["C39"], ws["H39"] = "PT 2 : Kultura", 99.65e6
buf = io.BytesIO()
wb.save(buf)
buf.seek(0)
imp = rab_rot.import_xlsx(buf)
check("name/year", imp["project_name"] == "SAMPLE PROJECT 2027" and imp["year"] == 2027)
check("lines", len(imp["lines"]) == 7, str(len(imp["lines"])))
check("groups", [l["group"] for l in imp["lines"]][:5] == ["Biaya Tenaga Ahli"] * 4 + ["Biaya Tenaga Pendukung"])
check("sections", [l["section"] for l in imp["lines"]][-2:] == ["B", "B"])
check("review moved", imp["lines"][2]["review"] == 7.2e6, "a review a row below its line")
check("review merged", imp["lines"][6]["review"] == 0.0, "Ops sits inside Printing's 7.5m")
check("total skipped", rab_rot.compute(imp)["review"]["cogs"] == 74.85e6)
check("PTs", [e["amount"] for e in imp["entities"]] == [91.5e6, 99.65e6])
buf.seek(0)
rv = cl.post("/api/rab/import", data={"file": (buf, "rot.xlsx")}, content_type="multipart/form-data")
check("import API", rv.status_code == 201 and rv.get_json()["lines"] == 7)
check("not xlsx", cl.post("/api/rab/import", data={"file": (io.BytesIO(b"x"), "a.csv")},
                          content_type="multipart/form-data").status_code == 400)

print("=== access ===")
fin = server.app.test_client()
from werkzeug.security import generate_password_hash  # noqa: E402
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access, menu_access) VALUES (?,?,?,?,?,?)",
             ("nopay", generate_password_hash("pw12345678"), "No Pay", "finance", "all", "dashboard,journals"))
conn.commit()
assert fin.post("/api/login", json={"username": "nopay", "password": "pw12345678"}).status_code == 200
check("pay hidden", fin.get("/api/rab/plans").status_code in (400, 403))
check("PDF hidden", fin.get("/api/rab/plans/%d/pdf" % pid).status_code in (400, 403))
check("delete", cl.delete("/api/rab/plans/%d" % pid).status_code == 200
      and cl.get("/api/rab/plans/%d" % pid).status_code in (400, 404))

print("\nRESULT: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
