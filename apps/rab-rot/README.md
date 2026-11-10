# MORES RAB ROT

A standalone desktop app for the project cost plan (**RAB ROT**) and the
remuneration it pays. It is separate from MORES HV: its own window, its own
desktop icon, its own data. The look is MORES HV's.

It is the "PROJECT RAB ROT ACTUAL" Excel sheet as a form:

- **Cost lines**: A. Biaya Langsung Personil / B. Non Personil, in groups.
  Total = Harga Satuan (+tax) × JMLH × SAT × VOL, with % to COGS.
- **Margin stack**: Total Cost Awal → maksimal (belum tax) → COGS →
  Service Fee 10% → PSC 5% → Profit Element → Total Project Cost.
- **Project value** per PT, net of PPN 11% and PPh 23 2%, which gives the
  Nilai Cuan Terprediksi (NCT).
- **Finance Review**: Finance's own figure per line, with a
  GREEN / AMBER / RED signal. Green starts at the scheme's minimum GP
  (40% if no scheme is set); amber covers the 10 points below that.
- **Remuneration**: put a team on the plan and see each person's share
  (People & grades, Scheme).
- **Import** the existing Excel sheet, **Copy** a plan for the next project,
  and **PDF** with sign-off boxes.

Figures recalculate as you type.

**PPh 23:** the old sheet used `value × 2/102`. PPh 23 is withheld on DPP
(the value before PPN), so net = value × 98/111 = 88.29%. The "Old sheet
formula" option reproduces the sheet exactly, for reconciling.

## Install on Windows (once)

1. Install Python 3 from python.org and tick **"Add python.exe to PATH"**.
2. Double-click **`install.bat`** in this folder. It installs the two
   packages the app needs and puts **MORES RAB ROT** on your desktop and in
   the Start menu.

Then double-click **MORES RAB ROT** on the desktop. The app starts in the
background (no console window) and opens in its own window, with no tabs and
no address bar.

- **Stop it:** Start menu → MORES RAB ROT → **Stop MORES RAB ROT**.
- **If you move the folder:** run `install.bat` again, so the icons point to
  the new place.
- **Log:** `%LOCALAPPDATA%\MORES RAB ROT\`.

## Run it by hand (any OS)

```bash
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:8100.

## Data and privacy

- Everything is stored in one file: `data/rabrot.db` in this folder (or in
  `RAB_ROT_DATA_DIR`). Back that file up, and keep it out of git; `*.db` is
  ignored.
- The app answers this computer only. It listens on 127.0.0.1, and refuses
  any request from another address.
- There is no login. Anyone who can use this computer can open it.

## Files

| file | what |
|---|---|
| `app.py` | the local server: pages and API |
| `rab_rot.py` | every RAB ROT formula and the Excel import |
| `remuneration.py` | the scheme table, the grades, and the payout split |
| `pdf_report.py` | the PDF, with no extra libraries |
| `static/` | the screens (MORES HV styles), and the installable-app files in `static/pwa/` |
| `rab_rot_app.ps1`, `install.bat` | the Windows launcher and setup |
| `tests/test_app.py` | `python tests/test_app.py` |

`rab_rot.py` and `remuneration.py` started as copies of MORES HV's. They are
now this app's own, so change them here.
