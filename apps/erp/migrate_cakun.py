"""One-time migration: move the C-AKUN cost group from HOLD to MDA (Consulting)
and renumber it to 7300 / 7300-01..04.

It preserves every journal entry — the existing C-AKUN cost entries are
reclassified to MDA (company + accounts repointed), nothing is deleted.
Idempotent: running it again after it has completed is a no-op.
"""
import database

# old HOLD code -> (new MDA code, display name)
OLD_NEW = {
    "C-AKUN": ("7300", "C-AKUN"),
    "C-1": ("7300-01", "C-1 BDKR"),
    "C-2": ("7300-02", "C-2 FRK"),
    "C-NB": ("7300-03", "C-NB"),
    "C-SKWN": ("7300-04", "C-SKWN"),
}


def migrate():
    conn = database.get_db()
    companies = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM companies")}
    if "HOLD" not in companies or "MDA" not in companies:
        print("HOLD/MDA company missing — nothing to migrate.")
        conn.close()
        return
    hold, mda = companies["HOLD"], companies["MDA"]

    mda_has_7300 = conn.execute(
        "SELECT 1 FROM accounts WHERE company_id=? AND code='7300'", (mda,)).fetchone()
    hold_has_cakun = conn.execute(
        "SELECT 1 FROM accounts WHERE company_id=? AND code='C-AKUN'", (hold,)).fetchone()
    if mda_has_7300 and not hold_has_cakun:
        print("Already migrated — C-AKUN lives in MDA as 7300.")
        conn.close()
        return

    # 1. create the 7300 accounts in MDA
    database.apply_mda_extra_coa(conn, mda)
    new_id = {}
    for _, (newc, _n) in OLD_NEW.items():
        new_id[newc] = conn.execute(
            "SELECT id FROM accounts WHERE company_id=? AND code=?", (mda, newc)).fetchone()["id"]

    # map old HOLD C-AKUN account id -> new MDA account id
    remap = {}
    for old_code, (newc, _n) in OLD_NEW.items():
        row = conn.execute(
            "SELECT id FROM accounts WHERE company_id=? AND code=?", (hold, old_code)).fetchone()
        if row:
            remap[row["id"]] = new_id[newc]
    hold_bank = conn.execute(
        "SELECT id FROM accounts WHERE company_id=? AND code='1120'", (hold,)).fetchone()["id"]
    mda_bank = conn.execute(
        "SELECT id FROM accounts WHERE company_id=? AND code='1120'", (mda,)).fetchone()["id"]

    # 2. reclassify every HOLD entry that touches a C-AKUN account
    moved, skipped = 0, 0
    if remap:
        ph = ",".join("?" * len(remap))
        entry_ids = [r["entry_id"] for r in conn.execute(
            "SELECT DISTINCT jl.entry_id FROM journal_lines jl JOIN journal_entries je"
            " ON je.id=jl.entry_id WHERE je.company_id=? AND jl.account_id IN (%s)" % ph,
            [hold] + list(remap.keys())).fetchall()]
        for eid in entry_ids:
            lines = conn.execute(
                "SELECT id, account_id FROM journal_lines WHERE entry_id=?", (eid,)).fetchall()
            # only move entries whose every line is a C-AKUN account or the HOLD bank
            if any(l["account_id"] not in remap and l["account_id"] != hold_bank for l in lines):
                skipped += 1
                continue
            for l in lines:
                tgt = remap.get(l["account_id"], mda_bank if l["account_id"] == hold_bank else None)
                if tgt:
                    conn.execute("UPDATE journal_lines SET account_id=? WHERE id=?", (tgt, l["id"]))
            e = conn.execute("SELECT entry_no FROM journal_entries WHERE id=?", (eid,)).fetchone()
            conn.execute("UPDATE journal_entries SET company_id=?, entry_no=? WHERE id=?",
                         (mda, "CAKUN-" + e["entry_no"], eid))
            moved += 1

    # 3. repoint any budgets on the old accounts (defensive; none expected)
    for old_id, n_id in remap.items():
        conn.execute("UPDATE budgets SET account_id=?, company_id=? WHERE account_id=?",
                     (n_id, mda, old_id))

    # 4. delete the now-unreferenced HOLD C-AKUN accounts
    for old_id in list(remap.keys()):
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM journal_lines WHERE account_id=?", (old_id,)).fetchone()["n"]
        bud = conn.execute(
            "SELECT COUNT(*) AS n FROM budgets WHERE account_id=?", (old_id,)).fetchone()["n"]
        if used == 0 and bud == 0:
            conn.execute("DELETE FROM accounts WHERE id=?", (old_id,))

    conn.commit()
    d, c = conn.execute("SELECT round(sum(debit),2), round(sum(credit),2) FROM journal_lines").fetchone()
    print("Moved %d C-AKUN entries to MDA (skipped %d), books balanced: %s" % (moved, skipped, d == c))
    conn.close()


if __name__ == "__main__":
    migrate()
