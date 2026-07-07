"""MORES PAY - payment gateway abstraction.

Same pattern as apps/api/src/payments/provider.interface.ts in the main hub:
the app only talks to `PaymentProvider`; `MockProvider` simulates an
Indonesian gateway (Xendit-style) for local dev. Going live means writing
`XenditProvider` with the same three methods - no other code changes.

Mock behaviour, tuned for demos:
  * Disbursements settle asynchronously ~4s after creation, via the same
    code path a signed webhook would take.
  * A bank account starting with "000" always FAILS settlement - use it to
    demo the failure/retry flow.
  * QRIS charges succeed instantly.
"""
import hashlib
import hmac
import secrets
import threading

# In production this comes from the environment / a secret store.
WEBHOOK_SECRET = b"mock-callback-secret-change-me"


def sign_webhook(body: bytes) -> str:
    """HMAC-SHA256 signature, the scheme Xendit/Midtrans callbacks use."""
    return hmac.new(WEBHOOK_SECRET, body, hashlib.sha256).hexdigest()


def verify_webhook(body: bytes, signature: str) -> bool:
    return hmac.compare_digest(sign_webhook(body), signature or "")


class PaymentProvider:
    """Interface. Amounts are integer Rupiah."""

    def create_disbursement(self, ref, amount, bank_code, bank_account, holder):
        """Start a payout to a bank account. Returns a gateway_ref;
        settlement arrives later through the webhook/settle callback."""
        raise NotImplementedError

    def create_qris_charge(self, ref, amount, merchant):
        """Charge a scanned QRIS code. Returns (gateway_ref, status)."""
        raise NotImplementedError


class MockProvider(PaymentProvider):
    """Simulates the gateway. `on_settle(gateway_ref, ok)` is called on a
    background thread ~4 seconds after each disbursement, exactly like a
    webhook would arrive."""

    SETTLE_DELAY_SECONDS = 4.0

    def __init__(self, on_settle):
        self._on_settle = on_settle

    def create_disbursement(self, ref, amount, bank_code, bank_account, holder):
        gateway_ref = "mock-disb-" + secrets.token_hex(5)
        ok = not str(bank_account or "").startswith("000")
        timer = threading.Timer(self.SETTLE_DELAY_SECONDS,
                                self._on_settle, args=(gateway_ref, ok))
        timer.daemon = True
        timer.start()
        return gateway_ref

    def create_qris_charge(self, ref, amount, merchant):
        return "mock-qr-" + secrets.token_hex(5), "succeeded"


# ---------------------------------------------------------------------------
# QRIS payload helpers (EMVCo TLV, the format inside every QRIS code)
# ---------------------------------------------------------------------------

def parse_qris(payload):
    """Best-effort parse of an EMVCo QRIS string.

    Returns {merchant, city, amount, scheme, parsed}:
      scheme "dynamic" - single-use code with the amount embedded (tag 54,
                         point-of-initiation tag 01 = "12"); pay as-is.
      scheme "static"  - reusable merchant code with NO amount (tag 01 = "11"
                         or tag 54 absent); the payer keys the amount in.
    Falls back to treating free text as a merchant name so demos never dead-end."""
    payload = (payload or "").strip()
    tags, i = {}, 0
    try:
        while i + 4 <= len(payload):
            tag, ln = payload[i:i + 2], int(payload[i + 2:i + 4])
            val = payload[i + 4:i + 4 + ln]
            if len(val) < ln:
                raise ValueError
            tags[tag] = val
            i += 4 + ln
        if "59" not in tags:
            raise ValueError
    except (ValueError, KeyError):
        return {"merchant": payload[:40] or "Unknown merchant", "city": None,
                "amount": None, "scheme": "static", "parsed": False}
    amount = None
    if tags.get("54"):
        try:
            amount = int(float(tags["54"]))
        except ValueError:
            amount = None
    # tag 01: "11" static / "12" dynamic. Amount presence is the ground truth;
    # tag 01 breaks the tie for malformed codes that omit it.
    scheme = "dynamic" if amount is not None else "static"
    if tags.get("01") == "11":
        scheme, amount = "static", None
    return {"merchant": tags["59"].strip(), "city": (tags.get("60") or "").strip() or None,
            "amount": amount, "scheme": scheme, "parsed": True}


def build_demo_qris(merchant, city, amount=None):
    """Build a minimal QRIS-shaped TLV payload for the demo scanner.
    With an amount -> dynamic code (tag 01=12, tag 54 present);
    without      -> static merchant code (tag 01=11, no tag 54)."""
    def tlv(tag, value):
        return "%s%02d%s" % (tag, len(value), value)
    parts = [tlv("00", "01"),
             tlv("01", "12" if amount is not None else "11"),
             tlv("52", "5812"), tlv("53", "360")]
    if amount is not None:
        parts.append(tlv("54", str(int(amount))))
    parts += [tlv("58", "ID"), tlv("59", merchant[:25]), tlv("60", city[:15])]
    return "".join(parts)
