# MORES HV — Data folder

**This folder holds all of your MORES HV data.** Each `.db` file is one complete,
self-contained database (companies, accounts, journals, budgets, users — everything).

| File | What it is |
|------|------------|
| `MORES-GROUP.db` | Your **live group data**. Back this up. |
| `TEST-SERVER.db` | A sandbox for testing. Safe to lose. |
| `<other>.db` | Any extra databases you create from the database picker. |
| `backups/` | Safety copies the app/you place here. **Not** shown as databases. |

Every `.db` file directly in this folder appears as a selectable database on the
sign-in **Choose a Database** screen, so keep stray copies inside `backups/`
(that subfolder is not scanned).

## How to back up
Just **copy the `.db` files somewhere safe** (an external drive, another cloud
folder, the `backups/` subfolder here, etc.). To restore, copy the file back.
Closing the app first is safest.

Tip: because this whole project lives inside **OneDrive**, these files are
already synced/backed up automatically. For an extra copy, drag `MORES-GROUP.db`
to a backup location whenever you like.

## Move this folder
By default the data lives here (`<project>/data/`). To keep it elsewhere — say a
dedicated backup drive or a separate cloud folder — set an environment variable
before starting the app:

```
set MORES_HV_DATA_DIR=D:\MORES-HV-Backups
python apps\erp\server.py
```

The app will create/read the databases there instead. Existing `.db` files are
migrated into the active data folder automatically on first start.

> The `.db` files are intentionally **not** committed to git — code is versioned,
> your financial data is not.
