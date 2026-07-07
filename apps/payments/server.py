"""MORES PAY - internal payment system for field agents.

Flask app: session auth with RBAC, agent API (reimbursement / direct payment
order / QRIS / wallet), admin API (approvals, transactions, users & limits,
reports, audit), mock payment gateway with async settlement, CSV exports.

Run:  python server.py            -> http://127.0.0.1:8020
Docs: README.md, docs/FRAMEWORK-REVIEW.md
"""
import base64
import csv
import functools
import hashlib
import io
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.serialization import load_der_public_key

from flask import (Flask, g, jsonify, request, send_file,
                   send_from_directory, session)
from werkzeug.security import check_password_hash, generate_password_hash

import database
import gateway

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
SECRET_FILE = os.path.join(BASE_DIR, ".secret_key")

app = Flask(__name__, static_folder=None)

if os.path.exists(SECRET_FILE):
    app.secret_key = open(SECRET_FILE).read().strip()
else:
    app.secret_key = secrets.token_hex(32)
    with open(SECRET_FILE, "w") as f:
        f.write(app.secret_key)

app.permanent_session_lifetime = timedelta(hours=12)
app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024  # 6 MB uploads

ALLOWED_UPLOADS = {".jpg", ".jpeg", ".png", ".webp", ".pdf", ".svg"}
CATEGORIES = ["meals", "transport", "lodging", "supplies", "events",
              "entertainment", "communication", "general"]
BANKS = ["BCA", "BRI", "BNI", "Mandiri", "CIMB", "Permata", "BSI", "Jago"]


# ---------------------------------------------------------------------------
# DB / auth plumbing (same idioms as apps/erp)
# ---------------------------------------------------------------------------

def db():
    if "db" not in g:
        g.db = database.get_conn()
    return g.db


@app.teardown_appcontext
def close_db(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return db().execute(
        "SELECT * FROM users WHERE id=? AND is_active=1", (uid,)).fetchone()


def role_required(*roles):
    """Auth guard. Auditors may pass any GET guard that allows 'finance'
    (read-only oversight); every mutation checks roles strictly."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if user is None:
                return jsonify({"error": "Authentication required"}), 401
            allowed = set(roles)
            if request.method == "GET" and "finance" in allowed:
                allowed.add("auditor")
            if user["role"] not in allowed:
                return jsonify({"error": "Forbidden for role '%s'" % user["role"]}), 403
            g.user = user
            return fn(*args, **kwargs)
        return wrapper
    return deco


def bad(msg, code=400):
    return jsonify({"error": msg}), code


def touch(txn_id):
    db().execute("UPDATE transactions SET updated_at=datetime('now') WHERE id=?",
                 (txn_id,))


def txn_dict(row):
    d = dict(row)
    d["has_receipt"] = bool(d.pop("receipt_file", None))
    return d


# ---------------------------------------------------------------------------
# Mock gateway settlement (arrives on a background thread ~4s after approval)
# ---------------------------------------------------------------------------

def settle_disbursement(gateway_ref, ok):
    """Terminal leg of a payout. Runs on the timer thread AND from the
    webhook endpoint, so it opens its own connection and is idempotent."""
    conn = database.get_conn()
    try:
        payout = conn.execute(
            "SELECT * FROM gateway_payouts WHERE gateway_ref=?", (gateway_ref,)).fetchone()
        if payout is None or payout["status"] != "pending":
            return False  # unknown or already settled -> ignore (idempotent)
        txn = conn.execute("SELECT * FROM transactions WHERE id=?",
                           (payout["txn_id"],)).fetchone()
        status = "settled" if ok else "failed"
        conn.execute(
            "UPDATE gateway_payouts SET status=?, settled_at=datetime('now') WHERE id=?",
            (status, payout["id"]))
        if ok:
            database.post_ledger(conn, txn["id"],
                [("clearing:gateway", "debit", txn["amount"]),
                 ("expense:%s" % txn["category"], "credit", txn["amount"])])
            new_status = "paid"
        else:
            database.post_ledger(conn, txn["id"],
                [("clearing:gateway", "debit", txn["amount"]),
                 ("corporate:main", "credit", txn["amount"])])
            new_status = "failed"
        conn.execute(
            "UPDATE transactions SET status=?, updated_at=datetime('now') WHERE id=?",
            (new_status, txn["id"]))
        database.audit(conn, None, "gateway.%s" % status, "transaction",
                       txn["id"], gateway_ref)
        conn.commit()
        return True
    finally:
        conn.close()


provider = gateway.MockProvider(on_settle=settle_disbursement)


def start_disbursement(conn, txn):
    """approved -> disbursing: hand the payout to the gateway and move the
    money into the clearing account."""
    gref = provider.create_disbursement(
        txn["ref"], txn["amount"], txn["bank_code"], txn["bank_account"],
        txn["bank_holder"])
    conn.execute(
        """INSERT INTO gateway_payouts (gateway_ref, txn_id, amount, bank_code, bank_account)
           VALUES (?,?,?,?,?)""",
        (gref, txn["id"], txn["amount"], txn["bank_code"], txn["bank_account"]))
    database.post_ledger(conn, txn["id"],
        [("corporate:main", "debit", txn["amount"]),
         ("clearing:gateway", "credit", txn["amount"])])
    conn.execute(
        "UPDATE transactions SET status='disbursing', gateway_ref=?, updated_at=datetime('now') WHERE id=?",
        (gref, txn["id"]))
    return gref


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    user = db().execute("SELECT * FROM users WHERE username=?",
                        ((data.get("username") or "").strip().lower(),)).fetchone()
    if user is None or not check_password_hash(user["password_hash"],
                                               data.get("password") or ""):
        return bad("Invalid username or password", 401)
    if not user["is_active"]:
        return bad("Account is disabled", 403)
    session.permanent = True
    session["user_id"] = user["id"]
    database.audit(db(), user["id"], "auth.login")
    db().commit()
    return jsonify({"id": user["id"], "username": user["username"],
                    "full_name": user["full_name"], "role": user["role"],
                    "has_pin": bool(user["pin_hash"])})


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def me():
    user = current_user()
    if user is None:
        return bad("Authentication required", 401)
    return jsonify({"id": user["id"], "username": user["username"],
                    "full_name": user["full_name"], "role": user["role"],
                    "has_pin": bool(user["pin_hash"])})


@app.post("/api/auth/pin")
@role_required("agent")
def set_pin():
    data = request.get_json(silent=True) or {}
    pin = str(data.get("pin") or "")
    if not (pin.isdigit() and len(pin) == 6):
        return bad("PIN must be exactly 6 digits")
    if g.user["pin_hash"]:
        old = str(data.get("old_pin") or "")
        if not check_password_hash(g.user["pin_hash"], old):
            return bad("Current PIN is incorrect", 403)
    db().execute("UPDATE users SET pin_hash=? WHERE id=?",
                 (generate_password_hash(pin), g.user["id"]))
    database.audit(db(), g.user["id"], "auth.pin_set")
    db().commit()
    return jsonify({"ok": True})


def require_pin(user, pin):
    if not user["pin_hash"]:
        return "Set your transaction PIN first (Profile tab)"
    if not check_password_hash(user["pin_hash"], str(pin or "")):
        return "Incorrect PIN"
    return None


# ---------------------------------------------------------------------------
# WebAuthn (biometric sign-in for agents)
#
# Registration uses AuthenticatorAttestationResponse.getPublicKey() (SPKI DER),
# so no CBOR parsing is needed. Assertions are verified for real: challenge,
# origin, rpIdHash, user-present/user-verified flags, and the ES256/RS256
# signature over authenticatorData || sha256(clientDataJSON).
# Browsers require a secure context - http://localhost counts, raw IPs do not.
# ---------------------------------------------------------------------------

def _b64u_decode(data):
    data = str(data or "")
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _b64u_encode(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _rp_id():
    return request.host.split(":")[0]


def _check_client_data(b64, expected_type):
    """Shared clientDataJSON checks. Returns error string or None."""
    try:
        cd = json.loads(_b64u_decode(b64))
    except (ValueError, TypeError):
        return "Malformed clientDataJSON"
    if cd.get("type") != expected_type:
        return "Unexpected WebAuthn operation type"
    expected = session.get("webauthn_challenge")
    if not expected or cd.get("challenge") != _b64u_encode(expected.encode()):
        return "Challenge mismatch (expired? retry)"
    origin_host = (cd.get("origin") or "").split("//")[-1].split(":")[0]
    if origin_host != _rp_id():
        return "Origin mismatch"
    return None


@app.post("/api/webauthn/register/options")
@role_required("agent")
def webauthn_register_options():
    challenge = secrets.token_urlsafe(32)
    session["webauthn_challenge"] = challenge
    return jsonify({
        "challenge": _b64u_encode(challenge.encode()),
        "rp": {"name": "MORES PAY", "id": _rp_id()},
        "user": {"id": _b64u_encode(str(g.user["id"]).encode()),
                 "name": g.user["username"], "displayName": g.user["full_name"]},
        "pubKeyCredParams": [{"type": "public-key", "alg": -7},
                             {"type": "public-key", "alg": -257}],
        "authenticatorSelection": {"authenticatorAttachment": "platform",
                                   "userVerification": "required"},
        "timeout": 60000, "attestation": "none"})


@app.post("/api/webauthn/register/verify")
@role_required("agent")
def webauthn_register_verify():
    data = request.get_json(silent=True) or {}
    err = _check_client_data(data.get("clientDataJSON"), "webauthn.create")
    if err:
        return bad(err)
    alg = data.get("alg")
    if alg not in (-7, -257):
        return bad("Unsupported key algorithm %s" % alg)
    try:
        spki = _b64u_decode(data.get("publicKey"))
        load_der_public_key(spki)  # sanity: must parse as a public key
    except (ValueError, TypeError):
        return bad("Malformed public key")
    cred_id = data.get("credentialId") or ""
    if not cred_id:
        return bad("Missing credential id")
    session.pop("webauthn_challenge", None)
    db().execute(
        """INSERT OR REPLACE INTO webauthn_credentials
           (user_id, credential_id, public_key_spki, alg, label)
           VALUES (?,?,?,?,?)""",
        (g.user["id"], cred_id, spki, alg,
         (data.get("label") or "This device")[:60]))
    database.audit(db(), g.user["id"], "auth.biometric_enrolled")
    db().commit()
    n = db().execute("SELECT COUNT(*) c FROM webauthn_credentials WHERE user_id=?",
                     (g.user["id"],)).fetchone()["c"]
    return jsonify({"ok": True, "devices": n})


@app.get("/api/webauthn/devices")
@role_required("agent")
def webauthn_devices():
    rows = db().execute(
        "SELECT id, label, created_at FROM webauthn_credentials WHERE user_id=?",
        (g.user["id"],)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/webauthn/login/options")
def webauthn_login_options():
    data = request.get_json(silent=True) or {}
    user = db().execute(
        "SELECT * FROM users WHERE username=? AND is_active=1",
        ((data.get("username") or "").strip().lower(),)).fetchone()
    creds = db().execute(
        "SELECT credential_id FROM webauthn_credentials WHERE user_id=?",
        (user["id"],)).fetchall() if user else []
    if not creds:
        return bad("No biometric device enrolled for this account", 404)
    challenge = secrets.token_urlsafe(32)
    session["webauthn_challenge"] = challenge
    return jsonify({
        "challenge": _b64u_encode(challenge.encode()),
        "rpId": _rp_id(),
        "allowCredentials": [{"type": "public-key", "id": r["credential_id"]}
                             for r in creds],
        "userVerification": "required", "timeout": 60000})


@app.post("/api/webauthn/login/verify")
def webauthn_login_verify():
    data = request.get_json(silent=True) or {}
    cred = db().execute(
        """SELECT c.*, u.username, u.is_active FROM webauthn_credentials c
           JOIN users u ON u.id=c.user_id WHERE c.credential_id=?""",
        (data.get("credentialId") or "",)).fetchone()
    if cred is None or not cred["is_active"]:
        return bad("Unknown credential", 404)
    err = _check_client_data(data.get("clientDataJSON"), "webauthn.get")
    if err:
        return bad(err, 401)
    try:
        auth_data = _b64u_decode(data.get("authenticatorData"))
        signature = _b64u_decode(data.get("signature"))
        client_data_raw = _b64u_decode(data.get("clientDataJSON"))
    except (ValueError, TypeError):
        return bad("Malformed assertion", 400)
    if len(auth_data) < 37:
        return bad("Malformed authenticator data", 400)
    if auth_data[:32] != hashlib.sha256(_rp_id().encode()).digest():
        return bad("rpId hash mismatch", 401)
    flags = auth_data[32]
    if not (flags & 0x01) or not (flags & 0x04):  # UP and UV bits
        return bad("User presence/verification not asserted", 401)
    signed = auth_data + hashlib.sha256(client_data_raw).digest()
    key = load_der_public_key(bytes(cred["public_key_spki"]))
    try:
        if cred["alg"] == -7:
            key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        database.audit(db(), cred["user_id"], "auth.biometric_rejected")
        db().commit()
        return bad("Signature verification failed", 401)
    sign_count = int.from_bytes(auth_data[33:37], "big")
    db().execute("UPDATE webauthn_credentials SET sign_count=? WHERE id=?",
                 (sign_count, cred["id"]))
    session.pop("webauthn_challenge", None)
    session.permanent = True
    session["user_id"] = cred["user_id"]
    database.audit(db(), cred["user_id"], "auth.biometric_login")
    db().commit()
    user = db().execute("SELECT * FROM users WHERE id=?", (cred["user_id"],)).fetchone()
    return jsonify({"id": user["id"], "username": user["username"],
                    "full_name": user["full_name"], "role": user["role"],
                    "has_pin": bool(user["pin_hash"])})


# ---------------------------------------------------------------------------
# Vendor book (shared "memory" of payees for direct payment orders)
# ---------------------------------------------------------------------------

@app.get("/api/vendors")
def list_vendors():
    if current_user() is None:
        return bad("Authentication required", 401)
    rows = db().execute(
        "SELECT * FROM vendors WHERE is_active=1 ORDER BY name").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/vendors")
def create_vendor():
    user = current_user()
    if user is None:
        return bad("Authentication required", 401)
    if user["role"] == "auditor":
        return bad("Forbidden for role 'auditor'", 403)
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    account = (data.get("bank_account") or "").strip()
    if not name or not account or not data.get("bank_code"):
        return bad("Vendor name, bank and account number are required")
    if data.get("bank_code") not in BANKS:
        return bad("Unknown bank")
    category = data.get("category") if data.get("category") in CATEGORIES else "general"
    existing = db().execute("SELECT id FROM vendors WHERE name=?", (name,)).fetchone()
    if existing:
        db().execute(
            """UPDATE vendors SET bank_code=?, bank_account=?, bank_holder=?,
               category=?, is_active=1 WHERE id=?""",
            (data["bank_code"], account,
             (data.get("bank_holder") or name).strip(), category, existing["id"]))
        vid = existing["id"]
    else:
        cur = db().execute(
            """INSERT INTO vendors (name, bank_code, bank_account, bank_holder,
               category, created_by) VALUES (?,?,?,?,?,?)""",
            (name, data["bank_code"], account,
             (data.get("bank_holder") or name).strip(), category, user["id"]))
        vid = cur.lastrowid
    database.audit(db(), user["id"], "vendor.save", "vendor", vid, name)
    db().commit()
    row = db().execute("SELECT * FROM vendors WHERE id=?", (vid,)).fetchone()
    return jsonify(dict(row)), 201


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

def save_upload(file):
    """Validate + store a receipt/invoice. Returns stored filename or (None, err)."""
    if file is None or not file.filename:
        return None, "Receipt/invoice file is required"
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_UPLOADS:
        return None, "File type %s not allowed" % (ext or "(none)")
    name = uuid.uuid4().hex + ext
    os.makedirs(database.UPLOAD_DIR, exist_ok=True)
    file.save(os.path.join(database.UPLOAD_DIR, name))
    return name, None


@app.get("/api/files/<name>")
def get_file(name):
    user = current_user()
    if user is None:
        return bad("Authentication required", 401)
    if os.path.basename(name) != name:
        return bad("Not found", 404)
    txn = db().execute("SELECT user_id FROM transactions WHERE receipt_file=?",
                       (name,)).fetchone()
    if txn is None:
        return bad("Not found", 404)
    if user["role"] == "agent" and txn["user_id"] != user["id"]:
        return bad("Forbidden", 403)
    return send_from_directory(database.UPLOAD_DIR, name, max_age=3600)


# ---------------------------------------------------------------------------
# Agent API
# ---------------------------------------------------------------------------

def agent_wallet(uid):
    return db().execute("SELECT * FROM wallets WHERE user_id=?", (uid,)).fetchone()


@app.get("/api/agent/summary")
@role_required("agent")
def agent_summary():
    uid = g.user["id"]
    wallet = agent_wallet(uid)
    if wallet is None:
        return bad("No wallet configured for this account", 409)
    spend = database.month_spend(db(), uid)
    recent = db().execute(
        "SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 6",
        (uid,)).fetchall()
    return jsonify({
        "balance": database.account_balance(db(), "wallet:%d" % uid),
        "monthly_quota": wallet["monthly_quota"],
        "per_txn_limit": wallet["per_txn_limit"],
        "month_spend": spend,
        "month": datetime.now().strftime("%Y-%m"),  # client formats per language
        "recent": [txn_dict(r) for r in recent]})


@app.get("/api/agent/transactions")
@role_required("agent")
def agent_transactions():
    rows = db().execute(
        "SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100",
        (g.user["id"],)).fetchall()
    return jsonify([txn_dict(r) for r in rows])


def check_limits(user, amount, count_quota=True):
    wallet = agent_wallet(user["id"])
    if wallet is None:
        return "No wallet configured for this account"
    if amount <= 0:
        return "Amount must be positive"
    if amount > wallet["per_txn_limit"]:
        return "Amount exceeds your per-transaction limit (Rp {:,})".format(
            wallet["per_txn_limit"]).replace(",", ".")
    if count_quota:
        spend = database.month_spend(db(), user["id"])
        if spend + amount > wallet["monthly_quota"]:
            return "This would exceed your monthly quota (Rp {:,} used of Rp {:,})".format(
                spend, wallet["monthly_quota"]).replace(",", ".")
    return None


@app.post("/api/agent/reimbursements")
@role_required("agent")
def create_reimbursement():
    f = request.form
    try:
        amount = int(f.get("amount") or 0)
    except ValueError:
        return bad("Amount must be a whole number of Rupiah")
    # reimbursements repay the agent's own money: no quota consumed,
    # but the per-transaction cap still applies
    err = check_limits(g.user, amount, count_quota=False)
    if err:
        return bad(err)
    if f.get("category") not in CATEGORIES:
        return bad("Unknown category")
    if not (f.get("bank_code") and f.get("bank_account")):
        return bad("Bank code and account number are required")
    name, err = save_upload(request.files.get("receipt"))
    if err:
        return bad(err)
    cur = db().execute(
        """INSERT INTO transactions (user_id,type,amount,category,description,
           bank_code,bank_account,bank_holder,status,receipt_file)
           VALUES (?,?,?,?,?,?,?,?,'pending',?)""",
        (g.user["id"], "reimbursement", amount, f["category"],
         (f.get("description") or "").strip(), f["bank_code"],
         f["bank_account"].strip(), (f.get("bank_holder") or g.user["full_name"]).strip(),
         name))
    ref = database.assign_ref(db(), cur.lastrowid, "reimbursement")
    database.audit(db(), g.user["id"], "txn.submit", "transaction", cur.lastrowid, ref)
    db().commit()
    return jsonify({"ok": True, "ref": ref, "status": "pending"}), 201


@app.post("/api/agent/payment-orders")
@role_required("agent")
def create_payment_order():
    f = request.form
    try:
        amount = int(f.get("amount") or 0)
    except ValueError:
        return bad("Amount must be a whole number of Rupiah")
    err = check_limits(g.user, amount)  # counts against monthly quota
    if err:
        return bad(err)
    if f.get("category") not in CATEGORIES:
        return bad("Unknown category")
    if not (f.get("merchant") and f.get("bank_code") and f.get("bank_account")):
        return bad("Vendor name, bank and account number are required")
    name, err = save_upload(request.files.get("invoice"))
    if err:
        return bad(err)
    cur = db().execute(
        """INSERT INTO transactions (user_id,type,amount,category,description,
           merchant,bank_code,bank_account,bank_holder,status,receipt_file)
           VALUES (?,?,?,?,?,?,?,?,?,'pending',?)""",
        (g.user["id"], "direct_payment", amount, f["category"],
         (f.get("description") or "").strip(), f["merchant"].strip(),
         f["bank_code"], f["bank_account"].strip(),
         (f.get("bank_holder") or f["merchant"]).strip(), name))
    ref = database.assign_ref(db(), cur.lastrowid, "direct_payment")
    database.audit(db(), g.user["id"], "txn.submit", "transaction", cur.lastrowid, ref)
    if f.get("save_vendor") == "1":  # remember this payee in the vendor book
        vendor = (f["merchant"].strip(), f["bank_code"], f["bank_account"].strip(),
                  (f.get("bank_holder") or f["merchant"]).strip(), f["category"])
        existing = db().execute("SELECT id FROM vendors WHERE name=?",
                                (vendor[0],)).fetchone()
        if existing:
            db().execute(
                """UPDATE vendors SET bank_code=?, bank_account=?, bank_holder=?,
                   category=?, is_active=1 WHERE id=?""", vendor[1:] + (existing["id"],))
        else:
            db().execute(
                """INSERT INTO vendors (name, bank_code, bank_account, bank_holder,
                   category, created_by) VALUES (?,?,?,?,?,?)""",
                vendor + (g.user["id"],))
        database.audit(db(), g.user["id"], "vendor.save", "vendor", None, vendor[0])
        db().commit()
    return jsonify({"ok": True, "ref": ref, "status": "pending"}), 201


@app.post("/api/agent/qris/parse")
@role_required("agent")
def qris_parse():
    data = request.get_json(silent=True) or {}
    return jsonify(gateway.parse_qris(data.get("payload")))


@app.get("/api/agent/qris/demo")
@role_required("agent")
def qris_demo():
    """A sample QRIS payload, standing in for the camera scanner.
    ?scheme=dynamic (default) embeds the amount; ?scheme=static omits it,
    so the agent keys the amount in - both real QRIS variants."""
    import random
    merchant, city, amount = random.choice(
        [("Kopi Kenangan", "Jakarta", 42000),
         ("Sate Khas Senayan", "Jakarta", 187000),
         ("Alfamart Sudirman", "Jakarta", 63500),
         ("SPBU Pertamina 31", "Bekasi", 300000)])
    if request.args.get("scheme") == "static":
        return jsonify({"payload": gateway.build_demo_qris(merchant, city)})
    return jsonify({"payload": gateway.build_demo_qris(merchant, city, amount)})


@app.post("/api/agent/qris/pay")
@role_required("agent")
def qris_pay():
    data = request.get_json(silent=True) or {}
    err = require_pin(g.user, data.get("pin"))
    if err:
        return bad(err, 403)
    parsed = gateway.parse_qris(data.get("payload"))
    amount = parsed["amount"]
    if amount is None:  # static QRIS: agent keys in the amount
        try:
            amount = int(data.get("amount") or 0)
        except ValueError:
            return bad("Amount must be a whole number of Rupiah")
        if amount <= 0:
            return bad("Enter the amount for this static QRIS code")
    err = check_limits(g.user, amount)
    if err:
        return bad(err)
    balance = database.account_balance(db(), "wallet:%d" % g.user["id"])
    if amount > balance:
        return bad("Insufficient wallet balance (Rp {:,} available)".format(
            balance).replace(",", "."))
    category = data.get("category") if data.get("category") in CATEGORIES else "general"
    gref, _status = provider.create_qris_charge(None, amount, parsed["merchant"])
    cur = db().execute(
        """INSERT INTO transactions (user_id,type,amount,category,description,
           merchant,status,gateway_ref) VALUES (?,?,?,?,?,?,'paid',?)""",
        (g.user["id"], "qris", amount, category, "QRIS payment",
         parsed["merchant"], gref))
    tid = cur.lastrowid
    ref = database.assign_ref(db(), tid, "qris")
    database.post_ledger(db(), tid,
        [("wallet:%d" % g.user["id"], "debit", amount),
         ("expense:%s" % category, "credit", amount)])
    database.audit(db(), g.user["id"], "txn.qris_paid", "transaction", tid,
                   "%s Rp%d %s" % (ref, amount, parsed["merchant"]))
    db().commit()
    return jsonify({"ok": True, "ref": ref, "merchant": parsed["merchant"],
                    "amount": amount, "scheme": parsed["scheme"],
                    "balance": database.account_balance(db(), "wallet:%d" % g.user["id"])})


@app.get("/api/meta")
def meta():
    return jsonify({"categories": CATEGORIES, "banks": BANKS})


# ---------------------------------------------------------------------------
# Admin / finance API
# ---------------------------------------------------------------------------

@app.get("/api/admin/overview")
@role_required("finance", "admin")
def overview():
    conn = db()
    month = datetime.now().strftime("%Y-%m")
    pending = conn.execute(
        """SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM transactions
           WHERE status='pending'""").fetchone()
    paid = conn.execute(
        """SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM transactions
           WHERE status='paid' AND type NOT IN ('topup','funding')
             AND strftime('%Y-%m', created_at)=?""", (month,)).fetchone()
    cats = conn.execute(
        """SELECT category, SUM(amount) s FROM transactions
           WHERE status NOT IN ('rejected','failed') AND type NOT IN ('topup','funding')
             AND strftime('%Y-%m', created_at)=?
           GROUP BY category ORDER BY s DESC""", (month,)).fetchall()
    days = conn.execute(
        """SELECT date(created_at) d, SUM(amount) s FROM transactions
           WHERE status NOT IN ('rejected','failed') AND type NOT IN ('topup','funding')
             AND created_at >= date('now','-13 days')
           GROUP BY d ORDER BY d""").fetchall()
    return jsonify({
        "pending_count": pending["n"], "pending_amount": pending["s"],
        "month_paid_count": paid["n"], "month_paid_amount": paid["s"],
        "corporate_balance": database.account_balance(db(), "corporate:main"),
        "clearing_balance": database.account_balance(db(), "clearing:gateway"),
        "categories": [dict(r) for r in cats],
        "daily": [dict(r) for r in days]})


@app.get("/api/admin/approvals")
@role_required("finance", "admin")
def approvals():
    rows = db().execute(
        """SELECT t.*, u.full_name, u.username FROM transactions t
           JOIN users u ON u.id=t.user_id
           WHERE t.status='pending' ORDER BY t.id""").fetchall()
    out = []
    for r in rows:
        d = txn_dict(r)
        d["receipt_url"] = "/api/files/%s" % r["receipt_file"] if r["receipt_file"] else None
        out.append(d)
    return jsonify(out)


@app.post("/api/admin/approvals/<int:txn_id>")
@role_required("finance", "admin")
def decide(txn_id):
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    if action not in ("approve", "reject"):
        return bad("action must be approve or reject")
    conn = db()
    txn = conn.execute("SELECT * FROM transactions WHERE id=?", (txn_id,)).fetchone()
    if txn is None:
        return bad("Not found", 404)
    if txn["status"] != "pending":
        return bad("Already decided (%s)" % txn["status"], 409)
    note = (data.get("note") or "").strip()
    if action == "reject":
        if not note:
            return bad("A note is required when rejecting")
        conn.execute(
            """UPDATE transactions SET status='rejected', decided_by=?,
               decided_at=datetime('now'), decision_note=?, updated_at=datetime('now')
               WHERE id=?""", (g.user["id"], note, txn_id))
        database.audit(conn, g.user["id"], "txn.reject", "transaction", txn_id, note)
        conn.commit()
        return jsonify({"ok": True, "status": "rejected"})
    conn.execute(
        """UPDATE transactions SET status='approved', decided_by=?,
           decided_at=datetime('now'), decision_note=?, updated_at=datetime('now')
           WHERE id=?""", (g.user["id"], note, txn_id))
    txn = conn.execute("SELECT * FROM transactions WHERE id=?", (txn_id,)).fetchone()
    gref = start_disbursement(conn, txn)
    database.audit(conn, g.user["id"], "txn.approve", "transaction", txn_id,
                   "disbursement %s" % gref)
    conn.commit()
    return jsonify({"ok": True, "status": "disbursing", "gateway_ref": gref})


@app.get("/api/admin/transactions")
@role_required("finance", "admin")
def admin_transactions():
    q = """SELECT t.*, u.full_name, u.username FROM transactions t
           JOIN users u ON u.id=t.user_id WHERE 1=1"""
    params = []
    if request.args.get("status"):
        q += " AND t.status=?"
        params.append(request.args["status"])
    if request.args.get("type"):
        q += " AND t.type=?"
        params.append(request.args["type"])
    if request.args.get("user_id"):
        q += " AND t.user_id=?"
        params.append(request.args["user_id"])
    q += " ORDER BY t.id DESC LIMIT 300"
    rows = db().execute(q, params).fetchall()
    out = []
    for r in rows:
        d = txn_dict(r)
        d["receipt_url"] = "/api/files/%s" % r["receipt_file"] if r["receipt_file"] else None
        out.append(d)
    return jsonify(out)


@app.post("/api/admin/transactions/<int:txn_id>/retry")
@role_required("finance", "admin")
def retry_disbursement(txn_id):
    conn = db()
    txn = conn.execute("SELECT * FROM transactions WHERE id=?", (txn_id,)).fetchone()
    if txn is None:
        return bad("Not found", 404)
    if txn["status"] != "failed":
        return bad("Only failed disbursements can be retried", 409)
    if str(txn["bank_account"] or "").startswith("000"):
        return bad("Fix the bank account first (mock: accounts starting 000 always fail)")
    gref = start_disbursement(conn, txn)
    database.audit(conn, g.user["id"], "txn.retry", "transaction", txn_id, gref)
    conn.commit()
    return jsonify({"ok": True, "status": "disbursing", "gateway_ref": gref})


# --- users & limits ---------------------------------------------------------

@app.get("/api/admin/users")
@role_required("finance", "admin")
def list_users():
    rows = db().execute(
        """SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.created_at,
                  w.monthly_quota, w.per_txn_limit
           FROM users u LEFT JOIN wallets w ON w.user_id=u.id
           ORDER BY u.role='agent' DESC, u.id""").fetchall()
    month = datetime.now().strftime("%Y-%m")
    out = []
    for r in rows:
        d = dict(r)
        if r["role"] == "agent":
            d["balance"] = database.account_balance(db(), "wallet:%d" % r["id"])
            d["month_spend"] = database.month_spend(db(), r["id"], month)
        out.append(d)
    return jsonify(out)


@app.post("/api/admin/users")
@role_required("admin")
def create_user():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    full_name = (data.get("full_name") or "").strip()
    role = data.get("role") or "agent"
    if not username or not full_name:
        return bad("Username and full name are required")
    if role not in ("agent", "finance", "auditor"):
        return bad("Role must be agent, finance or auditor")
    if db().execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return bad("Username already exists", 409)
    password = data.get("password") or secrets.token_urlsafe(8)
    cur = db().execute(
        "INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,?)",
        (username, generate_password_hash(password), full_name, role))
    uid = cur.lastrowid
    if role == "agent":
        db().execute(
            "INSERT INTO wallets (user_id, monthly_quota, per_txn_limit) VALUES (?,?,?)",
            (uid, int(data.get("monthly_quota") or 5000000),
             int(data.get("per_txn_limit") or 2000000)))
    database.audit(db(), g.user["id"], "user.create", "user", uid, username)
    db().commit()
    return jsonify({"ok": True, "id": uid, "initial_password": password}), 201


@app.patch("/api/admin/users/<int:uid>")
@role_required("admin")
def update_user(uid):
    data = request.get_json(silent=True) or {}
    user = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if user is None:
        return bad("Not found", 404)
    if "is_active" in data:
        if uid == g.user["id"]:
            return bad("You cannot disable your own account")
        db().execute("UPDATE users SET is_active=? WHERE id=?",
                     (1 if data["is_active"] else 0, uid))
    if user["role"] == "agent" and ("monthly_quota" in data or "per_txn_limit" in data):
        wallet = db().execute("SELECT * FROM wallets WHERE user_id=?", (uid,)).fetchone()
        if wallet:
            db().execute(
                "UPDATE wallets SET monthly_quota=?, per_txn_limit=? WHERE user_id=?",
                (int(data.get("monthly_quota") or wallet["monthly_quota"]),
                 int(data.get("per_txn_limit") or wallet["per_txn_limit"]), uid))
    if data.get("reset_password"):
        new_pw = secrets.token_urlsafe(8)
        db().execute("UPDATE users SET password_hash=? WHERE id=?",
                     (generate_password_hash(new_pw), uid))
        database.audit(db(), g.user["id"], "user.reset_password", "user", uid)
        db().commit()
        return jsonify({"ok": True, "new_password": new_pw})
    database.audit(db(), g.user["id"], "user.update", "user", uid,
                   json.dumps({k: data[k] for k in data if k != "reset_password"}))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/admin/topup")
@role_required("finance", "admin")
def topup():
    data = request.get_json(silent=True) or {}
    uid = data.get("user_id")
    try:
        amount = int(data.get("amount") or 0)
    except ValueError:
        return bad("Amount must be a whole number of Rupiah")
    if amount <= 0:
        return bad("Amount must be positive")
    agent = db().execute(
        "SELECT * FROM users WHERE id=? AND role='agent' AND is_active=1",
        (uid,)).fetchone()
    if agent is None:
        return bad("Agent not found or inactive", 404)
    cur = db().execute(
        """INSERT INTO transactions (user_id,type,amount,category,description,
           status,decided_by,decided_at)
           VALUES (?,?,?,'general',?, 'paid', ?, datetime('now'))""",
        (uid, "topup", amount, (data.get("note") or "Budget allocation").strip(),
         g.user["id"]))
    tid = cur.lastrowid
    database.assign_ref(db(), tid, "topup")
    database.post_ledger(db(), tid,
        [("corporate:main", "debit", amount),
         ("wallet:%d" % uid, "credit", amount)])
    database.audit(db(), g.user["id"], "wallet.topup", "user", uid, "Rp%d" % amount)
    db().commit()
    return jsonify({"ok": True, "balance": database.account_balance(db(), "wallet:%d" % uid)})


# --- reports & audit --------------------------------------------------------

@app.get("/api/reports/usage")
@role_required("finance", "admin")
def usage_report():
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")
    agents = db().execute(
        """SELECT u.id, u.username, u.full_name, u.is_active,
                  w.monthly_quota, w.per_txn_limit
           FROM users u JOIN wallets w ON w.user_id=u.id
           WHERE u.role='agent' ORDER BY u.full_name""").fetchall()
    out = []
    for a in agents:
        by_type = {r["type"]: r["s"] for r in db().execute(
            """SELECT type, COALESCE(SUM(amount),0) s FROM transactions
               WHERE user_id=? AND strftime('%Y-%m', created_at)=?
                 AND status NOT IN ('rejected','failed')
               GROUP BY type""", (a["id"], month)).fetchall()}
        spend = database.month_spend(db(), a["id"], month)
        out.append({
            "id": a["id"], "username": a["username"], "full_name": a["full_name"],
            "is_active": a["is_active"], "monthly_quota": a["monthly_quota"],
            "balance": database.account_balance(db(), "wallet:%d" % a["id"]),
            "topup": by_type.get("topup", 0), "qris": by_type.get("qris", 0),
            "direct_payment": by_type.get("direct_payment", 0),
            "reimbursement": by_type.get("reimbursement", 0),
            "quota_spend": spend,
            "quota_pct": round(100.0 * spend / a["monthly_quota"], 1)
                         if a["monthly_quota"] else 0})
    return jsonify({"month": month, "agents": out})


def _csv_response(header, rows, filename):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    data = io.BytesIO(buf.getvalue().encode("utf-8-sig"))  # BOM so Excel opens UTF-8
    return send_file(data, mimetype="text/csv", as_attachment=True,
                     download_name=filename)


@app.get("/api/reports/transactions.csv")
@role_required("finance", "admin")
def export_transactions():
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")
    rows = db().execute(
        """SELECT t.ref, t.created_at, u.username, u.full_name, t.type, t.category,
                  t.merchant, t.amount, t.status, t.bank_code, t.bank_account,
                  t.gateway_ref, t.decision_note
           FROM transactions t JOIN users u ON u.id=t.user_id
           WHERE strftime('%Y-%m', t.created_at)=? ORDER BY t.id""", (month,)).fetchall()
    return _csv_response(
        ["ref", "created_at", "username", "full_name", "type", "category",
         "merchant", "amount_idr", "status", "bank_code", "bank_account",
         "gateway_ref", "decision_note"],
        [tuple(r) for r in rows], "mores-pay-transactions-%s.csv" % month)


@app.get("/api/reports/ledger.csv")
@role_required("finance", "admin")
def export_ledger():
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")
    rows = db().execute(
        """SELECT l.id, l.created_at, t.ref, l.account, l.direction, l.amount
           FROM ledger_entries l JOIN transactions t ON t.id=l.txn_id
           WHERE strftime('%Y-%m', l.created_at)=? ORDER BY l.id""", (month,)).fetchall()
    return _csv_response(
        ["entry_id", "created_at", "txn_ref", "account", "direction", "amount_idr"],
        [tuple(r) for r in rows], "mores-pay-ledger-%s.csv" % month)


@app.get("/api/reports/agent/<int:uid>/statement.csv")
@role_required("finance", "admin")
def export_agent_statement(uid):
    """One agent's full monthly statement - transactions plus a summary block,
    directly downloadable from the Reports table (one click per personnel)."""
    month = request.args.get("month") or datetime.now().strftime("%Y-%m")
    agent = db().execute(
        "SELECT * FROM users WHERE id=? AND role='agent'", (uid,)).fetchone()
    if agent is None:
        return bad("Agent not found", 404)
    rows = db().execute(
        """SELECT ref, created_at, type, category, merchant, description, amount,
                  status, bank_code, bank_account, gateway_ref, decision_note
           FROM transactions WHERE user_id=? AND strftime('%Y-%m', created_at)=?
           ORDER BY id""", (uid, month)).fetchall()
    by_type = {r["type"]: r["s"] for r in db().execute(
        """SELECT type, COALESCE(SUM(amount),0) s FROM transactions
           WHERE user_id=? AND strftime('%Y-%m', created_at)=?
             AND status NOT IN ('rejected','failed') GROUP BY type""",
        (uid, month)).fetchall()}
    body = [tuple(r) for r in rows]
    body += [
        (), ("SUMMARY", agent["full_name"], "@" + agent["username"], month),
        ("total_topup", by_type.get("topup", 0)),
        ("total_qris", by_type.get("qris", 0)),
        ("total_direct_payment", by_type.get("direct_payment", 0)),
        ("total_reimbursement", by_type.get("reimbursement", 0)),
        ("quota_spend", database.month_spend(db(), uid, month)),
        ("wallet_balance_now", database.account_balance(db(), "wallet:%d" % uid)),
    ]
    return _csv_response(
        ["ref", "created_at", "type", "category", "merchant", "description",
         "amount_idr", "status", "bank_code", "bank_account", "gateway_ref",
         "decision_note"],
        body, "mores-pay-%s-%s.csv" % (agent["username"], month))


@app.get("/api/admin/audit")
@role_required("admin", "finance")
def audit_trail():
    rows = db().execute(
        """SELECT a.*, u.username FROM audit_log a
           LEFT JOIN users u ON u.id=a.user_id
           ORDER BY a.id DESC LIMIT 200""").fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------------------
# Gateway webhook (what Xendit/Midtrans would call in production)
# ---------------------------------------------------------------------------

@app.post("/api/webhooks/gateway")
def gateway_webhook():
    body = request.get_data()
    if not gateway.verify_webhook(body, request.headers.get("X-Callback-Signature")):
        return bad("Invalid signature", 401)
    data = request.get_json(silent=True) or {}
    handled = settle_disbursement(data.get("gateway_ref"),
                                  data.get("status") == "settled")
    return jsonify({"ok": True, "handled": handled})


# ---------------------------------------------------------------------------
# Static pages
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/agent")
def agent_page():
    return send_from_directory(STATIC_DIR, "agent.html")


@app.get("/admin")
def admin_page():
    return send_from_directory(STATIC_DIR, "admin.html")


@app.get("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


database.init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8020))
    host = os.environ.get("HOST", "127.0.0.1")
    print("MORES PAY running at http://%s:%d" % (host, port))
    print("  agent:  dimas / agent123  (PIN 123456)")
    print("  admin:  admin / admin123 · finance / finance123 · auditor / audit123")
    # threaded=True so the mock gateway's settle timer can run alongside requests
    app.run(host=host, port=port, debug=False, threaded=True)
