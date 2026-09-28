"""v1.10: pictures for SBUs and investment initiatives.

A picture is judged by its own bytes, never by the name or type the browser
sends - an SVG or an HTML page served back as a "picture" could run script.
It follows the access rules of what it belongs to and goes when that goes.

    python apps/erp/tests/test_entity_images.py
"""
import io
import os
import shutil
import struct
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
TMP = tempfile.mkdtemp(prefix="img_")
os.environ["MORES_HV_DATA_DIR"] = TMP

import database  # noqa: E402
database.create_database(database.DEFAULT_DB, seed_demo=True)
import server  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-12s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-12s %s" % (name, detail))


def png(w=2, h=2, rgb=(107, 70, 229)):
    """A real, tiny PNG."""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


c = server.app.test_client()
assert c.post("/api/login", json={"username": "admin", "password": "MoresMores2018"}).status_code == 200
up = lambda url, data, name="p.png": c.post(url, data={"file": (io.BytesIO(data), name)},
                                             content_type="multipart/form-data")
pid = c.get("/api/products").get_json()[0]["id"]
inv = c.get("/api/investments").get_json()[0]

print("=== an SBU picture ===")
check("NONE", c.get("/api/products").get_json()[0]["image_v"] is None, "no picture yet")
r = up("/api/images/product/%d" % pid, png())
v1 = r.get_json().get("v")
check("UPLOAD", r.status_code == 200 and v1, "stored, version %s" % v1)
lst = next(p for p in c.get("/api/products").get_json() if p["id"] == pid)
check("LISTED", lst["image_v"] == v1, "the SBU list carries the version for the thumbnail")
check("DETAIL", c.get("/api/products/%d" % pid).get_json()["image_v"] == v1, "and so does the settings tab")
g = c.get("/api/images/product/%d?v=%s" % (pid, v1))
check("SERVED", g.status_code == 200 and g.mimetype == "image/png" and g.data == png()
      and g.headers.get("X-Content-Type-Options") == "nosniff", "served back as image/png, byte for byte")
r2 = up("/api/images/product/%d" % pid, png(3, 3, (1, 2, 3)))
check("REPLACE", r2.get_json()["v"] != v1 and c.get("/api/images/product/%d" % pid).data == png(3, 3, (1, 2, 3)),
      "a new upload replaces it under a new version, so the list URL changes")

print("=== only real pictures ===")
svg = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'
bad = up("/api/images/product/%d" % pid, svg, "evil.png")
check("SVG", bad.status_code == 400, "an SVG named .png is refused: %s" % bad.get_json().get("error"))
bad = up("/api/images/product/%d" % pid, b"<html><script>x</script></html>", "x.jpg")
check("HTML", bad.status_code == 400, "an HTML page is refused")
bad = up("/api/images/product/%d" % pid, b"\x89PNG\r\n\x1a\n" + b"0" * 1600000)
check("SIZE", bad.status_code == 400 and "1.5 MB" in bad.get_json().get("error", ""), "over 1.5 MB is refused")
check("KIND", up("/api/images/project/1", png()).status_code == 400, "only SBUs and investments keep pictures")
check("KEPT", c.get("/api/images/product/%d" % pid).data == png(3, 3, (1, 2, 3)), "a refused upload changes nothing")

print("=== an initiative picture ===")
r = up("/api/images/investment/%d" % inv["id"], png())
row = next(x for x in c.get("/api/investments").get_json() if x["id"] == inv["id"])
check("INV", r.status_code == 200 and row["image_v"] == r.get_json()["v"], "the Investment Center list carries it")
check("INV-DET", c.get("/api/investments/%d" % inv["id"]).get_json()["image_v"] == row["image_v"],
      "the editor sees it too")
d = c.delete("/api/images/investment/%d" % inv["id"])
check("REMOVE", d.status_code == 200 and c.get("/api/images/investment/%d" % inv["id"]).status_code == 404
      and next(x for x in c.get("/api/investments").get_json() if x["id"] == inv["id"])["image_v"] is None,
      "removed: 404, and the list falls back to initials")

print("=== who may do what ===")
conn = database.get_db(database.DEFAULT_DB)
conn.execute("INSERT INTO users (username, password_hash, full_name, role, company_access) VALUES (?,?,?,?,?)",
             ("imgview", generate_password_hash("viewer-pass-1"), "Viewer", "viewer", "all"))
conn.commit()
conn.close()
v = server.app.test_client()
assert v.post("/api/login", json={"username": "imgview", "password": "viewer-pass-1"}).status_code == 200
check("VIEWER", v.get("/api/images/product/%d" % pid).status_code == 200
      and v.post("/api/images/product/%d" % pid, data={"file": (io.BytesIO(png()), "p.png")},
                 content_type="multipart/form-data").status_code == 403
      and v.delete("/api/images/product/%d" % pid).status_code == 403, "a viewer sees pictures but cannot change them")
anon = server.app.test_client()
check("ANON", anon.get("/api/images/product/%d" % pid).status_code == 401, "nothing is served to someone not signed in")

print("=== a picture goes with its owner ===")
new = c.post("/api/investments", json={"company_id": inv["company_id"], "name": "Temp initiative"}).get_json()
up("/api/images/investment/%d" % new["id"], png())
c.delete("/api/investments/%d" % new["id"])
up("/api/images/product/%d" % pid, png())
c.delete("/api/products/%d" % pid)
conn = database.get_db(database.DEFAULT_DB)
left = conn.execute("SELECT COUNT(*) FROM entity_images WHERE (kind='investment' AND entity_id=?)"
                    " OR (kind='product' AND entity_id=?)", (new["id"], pid)).fetchone()[0]
conn.close()
check("CLEANUP", left == 0, "deleting an SBU or an initiative deletes its picture")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fail else 0)
