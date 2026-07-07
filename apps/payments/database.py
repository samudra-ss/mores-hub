"""MORES PAY - SQLite schema, migrations and demo seed.

Money model (documented in README.md):
  * All amounts are integer Rupiah (no decimals).
  * Balances are NEVER stored as a column - they are derived from
    ledger_entries, the same double-entry discipline as apps/api.
  * Every transaction writes balanced debit/credit rows; a zero-sum check
    runs inside the same SQLite transaction that writes them.

Accounts used in the ledger:
  corporate:main     company float that funds everything
  wallet:<user_id>   an agent's allocated spending balance
  clearing:gateway   money in flight while the gateway disburses
  expense:<category> final expense recognition
"""
import os
import sqlite3
from datetime import datetime, timedelta

from werkzeug.security import generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "payments.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    pin_hash      TEXT,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('agent','finance','admin','auditor')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id),
    monthly_quota  INTEGER NOT NULL DEFAULT 5000000,
    per_txn_limit  INTEGER NOT NULL DEFAULT 2000000,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ref           TEXT UNIQUE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    type          TEXT NOT NULL CHECK (type IN ('reimbursement','direct_payment','qris','topup','funding')),
    amount        INTEGER NOT NULL CHECK (amount > 0),
    category      TEXT NOT NULL DEFAULT 'general',
    description   TEXT,
    merchant      TEXT,
    bank_code     TEXT,
    bank_account  TEXT,
    bank_holder   TEXT,
    status        TEXT NOT NULL CHECK (status IN
                  ('pending','approved','disbursing','paid','rejected','failed')),
    receipt_file  TEXT,
    gateway_ref   TEXT,
    decided_by    INTEGER REFERENCES users(id),
    decided_at    TEXT,
    decision_note TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id     INTEGER NOT NULL REFERENCES transactions(id),
    account    TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    amount     INTEGER NOT NULL CHECK (amount > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS idx_ledger_txn ON ledger_entries(txn_id);

CREATE TABLE IF NOT EXISTS gateway_payouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_ref  TEXT NOT NULL UNIQUE,
    txn_id       INTEGER NOT NULL REFERENCES transactions(id),
    amount       INTEGER NOT NULL,
    bank_code    TEXT,
    bank_account TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','settled','failed')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at   TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    bank_code    TEXT NOT NULL,
    bank_account TEXT NOT NULL,
    bank_holder  TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'general',
    created_by   INTEGER REFERENCES users(id),
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WebAuthn (biometric) credentials. public_key_spki is the DER SubjectPublicKeyInfo
-- from AuthenticatorAttestationResponse.getPublicKey(); alg is the COSE id
-- (-7 ES256, -257 RS256). Assertions are verified with `cryptography`.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    credential_id   TEXT NOT NULL UNIQUE,
    public_key_spki BLOB NOT NULL,
    alg             INTEGER NOT NULL,
    sign_count      INTEGER NOT NULL DEFAULT 0,
    label           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id),
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  INTEGER,
    detail     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def get_conn():
    """New connection per request/thread. WAL so the mock-gateway settle
    thread can write while a request reads."""
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def post_ledger(conn, txn_id, legs):
    """Write balanced ledger rows. `legs` is a list of
    (account, direction, amount). Raises if debits != credits."""
    debits = sum(a for _, d, a in legs if d == "debit")
    credits = sum(a for _, d, a in legs if d == "credit")
    if debits != credits or debits <= 0:
        raise ValueError("unbalanced ledger posting: %s != %s" % (debits, credits))
    conn.executemany(
        "INSERT INTO ledger_entries (txn_id, account, direction, amount) VALUES (?,?,?,?)",
        [(txn_id, acc, d, a) for acc, d, a in legs])


def account_balance(conn, account):
    """wallet:* and clearing:* accounts grow with credits, shrink with debits."""
    row = conn.execute(
        """SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END),0) b
           FROM ledger_entries WHERE account=?""", (account,)).fetchone()
    return row["b"]


def month_spend(conn, user_id, month=None):
    """Spend that counts against the monthly quota: QRIS + direct payment
    orders that are not rejected/failed, in the given YYYY-MM month."""
    month = month or datetime.now().strftime("%Y-%m")
    row = conn.execute(
        """SELECT COALESCE(SUM(amount),0) s FROM transactions
           WHERE user_id=? AND type IN ('qris','direct_payment')
             AND status NOT IN ('rejected','failed')
             AND strftime('%Y-%m', created_at)=?""", (user_id, month)).fetchone()
    return row["s"]


def assign_ref(conn, txn_id, txn_type):
    prefix = {"reimbursement": "RB", "direct_payment": "PO",
              "qris": "QR", "topup": "TU", "funding": "FD"}[txn_type]
    ref = "%s-%05d" % (prefix, txn_id)
    conn.execute("UPDATE transactions SET ref=? WHERE id=?", (ref, txn_id))
    return ref


def audit(conn, user_id, action, entity=None, entity_id=None, detail=None):
    conn.execute(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)",
        (user_id, action, entity, entity_id, detail))


# ---------------------------------------------------------------------------
# init + demo seed
# ---------------------------------------------------------------------------

_DEMO_RECEIPT = """<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480">
<rect width="360" height="480" fill="#f6f4ef"/>
<text x="180" y="52" text-anchor="middle" font-family="monospace" font-size="17" fill="#222">%(store)s</text>
<text x="180" y="76" text-anchor="middle" font-family="monospace" font-size="11" fill="#555">Jakarta Selatan · %(date)s</text>
<line x1="28" y1="98" x2="332" y2="98" stroke="#999" stroke-dasharray="4 3"/>
%(lines)s
<line x1="28" y1="330" x2="332" y2="330" stroke="#999" stroke-dasharray="4 3"/>
<text x="28" y="362" font-family="monospace" font-size="14" fill="#111">TOTAL</text>
<text x="332" y="362" text-anchor="end" font-family="monospace" font-size="14" font-weight="bold" fill="#111">Rp %(total)s</text>
<text x="180" y="430" text-anchor="middle" font-family="monospace" font-size="10" fill="#777">-- TERIMA KASIH --</text>
</svg>"""


def _write_demo_receipt(name, store, items, total, date):
    lines, y = [], 128
    for label, amt in items:
        lines.append('<text x="28" y="%d" font-family="monospace" font-size="12" fill="#333">%s</text>' % (y, label))
        lines.append('<text x="332" y="%d" text-anchor="end" font-family="monospace" font-size="12" fill="#333">%s</text>' % (y, amt))
        y += 26
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(_DEMO_RECEIPT % {"store": store, "date": date,
                                 "lines": "\n".join(lines), "total": total})
    return name


def _seed(conn):
    pw = generate_password_hash
    users = [
        ("admin",   pw("admin123"),   None,             "Super Admin",    "admin"),
        ("finance", pw("finance123"), None,             "Rina Wulandari", "finance"),
        ("auditor", pw("audit123"),   None,             "Bagus Priyono",  "auditor"),
        ("dimas",   pw("agent123"),   pw("123456"),     "Dimas Ardhani",  "agent"),
        ("sari",    pw("agent123"),   pw("123456"),     "Sari Kusuma",    "agent"),
        ("budi",    pw("agent123"),   pw("123456"),     "Budi Santoso",   "agent"),
        ("ayu",     pw("agent123"),   pw("123456"),     "Ayu Lestari",    "agent"),
        ("raka",    pw("agent123"),   pw("123456"),     "Raka Pratama",   "agent"),
        ("nina",    pw("agent123"),   pw("123456"),     "Nina Kartika",   "agent"),
    ]
    conn.executemany(
        "INSERT INTO users (username,password_hash,pin_hash,full_name,role) VALUES (?,?,?,?,?)",
        users)
    ids = {r["username"]: r["id"] for r in
           conn.execute("SELECT id, username FROM users")}
    conn.executemany(
        "INSERT INTO wallets (user_id, monthly_quota, per_txn_limit) VALUES (?,?,?)",
        [(ids["dimas"], 5000000, 2000000), (ids["sari"], 8000000, 3000000),
         (ids["budi"], 5000000, 2000000), (ids["ayu"], 10000000, 4000000),
         (ids["raka"], 3000000, 1500000), (ids["nina"], 6000000, 2500000)])

    now = datetime.now()

    def days_ago(n, h=10):
        return (now - timedelta(days=n)).replace(hour=h, minute=24).strftime("%Y-%m-%d %H:%M:%S")

    def txn(user, ttype, amount, status, created, **kw):
        cols = dict(user_id=ids[user], type=ttype, amount=amount, status=status,
                    created_at=created, updated_at=created,
                    category=kw.get("category", "general"))
        for k in ("description", "merchant", "bank_code", "bank_account",
                  "bank_holder", "receipt_file", "decided_by", "decided_at",
                  "decision_note", "gateway_ref"):
            if k in kw:
                cols[k] = kw[k]
        keys = ",".join(cols)
        cur = conn.execute(
            "INSERT INTO transactions (%s) VALUES (%s)" % (keys, ",".join("?" * len(cols))),
            list(cols.values()))
        tid = cur.lastrowid
        assign_ref(conn, tid, ttype)
        return tid

    fin = ids["finance"]

    # opening capital: fund the corporate float so it reads as a real balance
    tid = txn("admin", "funding", 50000000, "paid", days_ago(10, 8),
              description="Opening corporate float", decided_by=ids["admin"],
              decided_at=days_ago(10, 8))
    post_ledger(conn, tid, [("equity:capital", "debit", 50000000),
                            ("corporate:main", "credit", 50000000)])

    # budget allocations (top-ups) - corporate float -> agent wallets
    # (raka intentionally has no top-up: a zero-balance agent is a real state)
    for user, amount, d in (("dimas", 4000000, 9), ("sari", 6000000, 8),
                            ("budi", 3500000, 7), ("ayu", 7500000, 6),
                            ("nina", 4000000, 5)):
        tid = txn(user, "topup", amount, "paid", days_ago(d, 9),
                  description="Monthly field budget", decided_by=fin,
                  decided_at=days_ago(d, 9))
        post_ledger(conn, tid, [("corporate:main", "debit", amount),
                                ("wallet:%d" % ids[user], "credit", amount)])

    # QRIS spends (instant, deducted from wallet)
    qris = [("dimas", 78000,  "meals",     "Kopi Tuku Senopati",  6),
            ("dimas", 245000, "transport", "SPBU Pertamina 34",   4),
            ("sari",  132500, "meals",     "Warteg Bahari",       5),
            ("sari",  560000, "supplies",  "TokoTani Makmur",     2),
            ("budi",  95000,  "meals",     "RM Padang Sederhana", 3),
            ("budi",  310000, "transport", "SPBU Shell Kalimalang", 1),
            ("ayu",   425000, "supplies",  "Gramedia Matraman",   2),
            ("nina",  150000, "transport", "Grab Indonesia",      1)]
    for user, amount, cat, merchant, d in qris:
        tid = txn(user, "qris", amount, "paid", days_ago(d, 13), category=cat,
                  merchant=merchant, gateway_ref="mock-qr-%d" % d,
                  description="QRIS payment")
        post_ledger(conn, tid, [("wallet:%d" % ids[user], "debit", amount),
                                ("expense:%s" % cat, "credit", amount)])

    # a reimbursement already fully paid (approved -> disbursed -> settled)
    r1 = _write_demo_receipt("demo-receipt-hotel.svg", "HOTEL KARTIKA CHANDRA",
                             [("Kamar deluxe 1 mlm", "850.000"), ("Pajak 11%", "93.500")],
                             "943.500", days_ago(7)[:10])
    tid = txn("sari", "reimbursement", 943500, "paid", days_ago(7, 8),
              category="lodging", description="Site visit overnight - Bandung",
              bank_code="BCA", bank_account="5410882291", bank_holder="Sari Kusuma",
              receipt_file=r1, decided_by=fin, decided_at=days_ago(6, 9),
              decision_note="OK, within policy", gateway_ref="mock-po-seed1")
    post_ledger(conn, tid, [("corporate:main", "debit", 943500),
                            ("clearing:gateway", "credit", 943500)])
    post_ledger(conn, tid, [("clearing:gateway", "debit", 943500),
                            ("expense:lodging", "credit", 943500)])
    conn.execute("""INSERT INTO gateway_payouts
        (gateway_ref, txn_id, amount, bank_code, bank_account, status, settled_at)
        VALUES ('mock-po-seed1',?,943500,'BCA','5410882291','settled',?)""",
        (tid, days_ago(6, 10)))

    # pending approvals for the demo queue
    r2 = _write_demo_receipt("demo-receipt-taxi.svg", "BLUEBIRD GROUP",
                             [("Argo bandara CGK", "185.000"), ("Tol + parkir", "42.000")],
                             "227.000", days_ago(1)[:10])
    txn("dimas", "reimbursement", 227000, "pending", days_ago(1, 18),
        category="transport", description="Airport taxi - client kickoff",
        bank_code="BCA", bank_account="8830125577", bank_holder="Dimas Ardhani",
        receipt_file=r2)
    r3 = _write_demo_receipt("demo-invoice-catering.svg", "CV BERKAH CATERING",
                             [("Nasi box 40 pax", "1.400.000"), ("Snack sore 40 pax", "480.000")],
                             "1.880.000", days_ago(0)[:10])
    txn("sari", "direct_payment", 1880000, "pending", days_ago(0, 9),
        category="events", description="Catering for dealer gathering",
        merchant="CV Berkah Catering", bank_code="BRI",
        bank_account="002301447789", bank_holder="CV Berkah Catering",
        receipt_file=r3)

    # one rejected, for history realism
    txn("dimas", "reimbursement", 1250000, "rejected", days_ago(12, 11),
        category="entertainment", description="Team dinner",
        bank_code="BCA", bank_account="8830125577", bank_holder="Dimas Ardhani",
        decided_by=fin, decided_at=days_ago(11, 9),
        decision_note="Entertainment needs pre-approval from BOD")

    audit(conn, None, "seed", "system", None, "demo data created")


_DEFAULT_VENDORS = [
    ("CV Berkah Catering",   "BRI",     "002301447789", "CV Berkah Catering",   "events"),
    ("PT Trans Nusantara",   "Mandiri", "1370099882211", "PT Trans Nusantara",  "transport"),
    ("Toko ATK Sejahtera",   "BCA",     "5410778812",   "Toko ATK Sejahtera",   "supplies"),
    ("Hotel Kartika Chandra","BNI",     "0446120033",   "PT Kartika Chandra",   "lodging"),
]


def init_db():
    first_time = not os.path.exists(DB_PATH)
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        if first_time or not conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            _seed(conn)
        # idempotent: give existing databases the starter vendor book too
        if not conn.execute("SELECT 1 FROM vendors LIMIT 1").fetchone():
            conn.executemany(
                """INSERT INTO vendors (name, bank_code, bank_account, bank_holder, category)
                   VALUES (?,?,?,?,?)""", _DEFAULT_VENDORS)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
    print("payments.db ready at", DB_PATH)
