"""The Oracle's "How to use" tab documents the engine's rules in a table.

Documentation that drifts from the code is worse than no documentation, because
it is believed. This reads the certainty table straight out of static/app.js and
checks every cell against fpa_cash.RUN_FILTERS, so changing the engine without
changing the guide fails here instead of quietly misleading a reader.

    python apps/erp/tests/test_guide_parity.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ERP = os.path.dirname(HERE)
sys.path.insert(0, ERP)

import fpa_cash as F  # noqa: E402

APP_JS = os.path.join(ERP, "static", "app.js")


def engine_cell(certainty, run):
    """What the engine actually does with this certainty on this run."""
    f = F.RUN_FILTERS[run]
    counts_in, counts_out = certainty in f["in"], certainty in f["out"]
    if counts_in and counts_out:
        # Base weights a speculative INFLOW down; that is a materially different
        # claim from "counted in full" and the guide has to say so.
        if run == "base" and certainty == "speculative":
            return "in at half weight, + out"
        return "in + out"
    if counts_out:
        return "out only"
    if counts_in:
        return "in only"
    return "—"


def documented_table():
    """Parse the runRows literal out of the guide."""
    src = io.open(APP_JS, encoding="utf-8").read()
    start = src.index("const runRows = [")
    block = src[start:src.index("];", start)]
    rows = {}
    # ["committed", t("..."), "in + out", "in + out", "in + out"],
    for line in block.splitlines():
        m = re.match(r'\s*\["(\w+)",\s*t\("[^"]*"\),\s*(.+?)\],\s*$', line)
        if not m:
            continue
        cert, rest = m.group(1), m.group(2)
        cells = [c.strip() for c in _split_top(rest)]
        rows[cert] = [_literal(c) for c in cells]
    return rows


def _split_top(s):
    """Split on commas that are not inside a t("...") call."""
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _literal(cell):
    """Unwrap t("x") or "x" to x."""
    m = re.match(r'^t\("(.*)"\)$', cell) or re.match(r'^"(.*)"$', cell)
    return m.group(1) if m else cell


def main():
    doc = documented_table()
    ok = fail = 0
    print("=== guide certainty table vs fpa_cash.RUN_FILTERS ===")
    missing = [c for c in F.CERTAINTIES if c not in doc]
    if missing:
        print("  FAIL   the guide does not document: %s" % ", ".join(missing))
        fail += len(missing)
    for cert in F.CERTAINTIES:
        if cert not in doc:
            continue
        for col, run in enumerate(F.RUNS):
            truth = engine_cell(cert, run)
            shown = doc[cert][col] if col < len(doc[cert]) else "(missing)"
            if shown == truth:
                ok += 1
                print("  PASS   %-12s %-11s %s" % (cert, run, truth))
            else:
                fail += 1
                print("  FAIL   %-12s %-11s engine says %r, guide says %r"
                      % (cert, run, truth, shown))
    extra = [c for c in doc if c not in F.CERTAINTIES]
    if extra:
        print("  FAIL   the guide documents a certainty the engine does not have: %s"
              % ", ".join(extra))
        fail += len(extra)
    print()
    print("RESULT: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
