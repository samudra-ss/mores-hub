"""BCA mutasi-rekening CSV: PEND rows are dated with the system date.

BCA prints PEND in the date column for a transaction it has not settled yet.
It still happened, so it must not be dropped, and re-importing the same file
tomorrow must not turn one transaction into two.

    python apps/erp/tests/test_bank_pending.py
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bank_import as B  # noqa: E402

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  %-10s %s" % (name, detail))
    else:
        fail += 1
        print("  FAIL  %-10s %s" % (name, detail))


HEAD = ("No. rekening : 4550068261\nNama : MORES DATA ANALITIKA\n\n"
        "Tanggal Transaksi,Keterangan,Cabang,Jumlah,Saldo\n")
ROWS = ("01/09/2026,TRSF E-BANKING DB 0109 SALARY,0000,\"25,000,000.00 DB\",\"475,000,000.00\"\n"
        "PEND,BI-FAST CR TRANSFER DR CLIENT A,0000,\"12,500,000.00 CR\",\n"
        "'PEND,KARTU DEBIT QRIS COFFEE,0000,\"85,000.00 DB\",\n")
today = datetime.date.today().isoformat()

recs, warns, _ = B.parse_bca_csv((HEAD + ROWS).encode())
pend = [r for r in recs if r.get("pending")]
check("KEPT", len(recs) == 3, "no row skipped (%d parsed)" % len(recs))
check("TODAY", len(pend) == 2 and all(r["date"] == today for r in pend), "both PEND rows dated %s" % today)
check("MARKED", all(r["status"] == "PEND" and "PEND" in r["note"] for r in pend), "status and note say PEND")
check("DIR", [r["direction"] for r in pend] == ["in", "out"], "CR is money in, DB is money out")
check("WARN", any("pending (PEND)" in w for w in warns), "the import says what it assumed")

again, _, _ = B.parse_bca_csv((HEAD + ROWS).encode())
check("SAME-REF", [r["reference"] for r in recs] == [r["reference"] for r in again],
      "re-importing the same file gives the same fingerprints")
# a pending fingerprint must not depend on the date it was given
check("NO-DATE", all(r["reference"] != B.parse_bca_csv((HEAD + ROWS.replace("PEND", "02/09/2026")).encode())[0][i]["reference"]
                     for i, r in enumerate(recs) if r.get("pending")),
      "a pending fingerprint is not the fingerprint of the same row with a real date")

quoted, _, _ = B.parse_bca_csv((HEAD + "'01/09/2026,TRSF SALARY,0000,\"1,000.00 DB\",\n").encode())
plain, _, _ = B.parse_bca_csv((HEAD + "01/09/2026,TRSF SALARY,0000,\"1,000.00 DB\",\n").encode())
check("APOSTROPHE", len(quoted) == 1 and quoted[0]["date"] == "2026-09-01"
      and quoted[0]["reference"] == plain[0]["reference"],
      "an apostrophe-prefixed date parses and fingerprints like a plain one")

check("DETECT", (B.is_pending_date("PEND"), B.is_pending_date("'PEND"), B.is_pending_date(" pend "),
                 B.is_pending_date("01/09/2026"), B.is_pending_date("")) == (True, True, True, False, False),
      "PEND detection ignores quotes, case and spaces")

profile = {"name": "BCA preset", "header_contains": "Tanggal", "date_format": "auto", "amount_locale": "auto",
           "columns": {"date": "Tanggal Transaksi", "description": "Keterangan", "amount": "Jumlah",
                       "balance": "Saldo"}}
prec, pwarn, _ = B.parse_csv_with_profile((HEAD + ROWS).encode(), profile)
check("PROFILE", sum(1 for r in prec if r.get("pending") and r["date"] == today) == 2,
      "saved custom formats apply the same PEND rule")

print()
print("RESULT: %d passed, %d failed" % (ok, fail))
sys.exit(1 if fail else 0)
