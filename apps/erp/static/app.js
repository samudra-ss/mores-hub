/* MORES ERP single-page app */
"use strict";

/* ------------------------------------------------------------------ utils */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmt(n) {
  if (n == null || isNaN(n)) return "-";
  return Math.round(n).toLocaleString("id-ID");
}

function fmtShort(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  if (a >= 1e12) return sign + (a / 1e12).toFixed(1) + " T";
  if (a >= 1e9) return sign + (a / 1e9).toFixed(1) + " B";
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + " M";
  if (a >= 1e3) return sign + (a / 1e3).toFixed(0) + " K";
  return sign + a.toFixed(0);
}

// IDR-prefixed money formatters (dashboard shows all figures as Rp)
function fmtRp(n) { return (n == null || isNaN(n)) ? "-" : "Rp " + fmt(n); }
// dashboard short money: 3 decimals (Indonesian comma) for M/B/T -> "Rp 3,231 B"
function fmtShortRp(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  const tiers = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"], [1, ""]];
  let ti = tiers.findIndex(([d]) => a >= d);
  if (ti < 0) ti = tiers.length - 1;
  const dpFor = u => (u === "M" || u === "B" || u === "T") ? 3 : 0;
  let [div, unit] = tiers[ti], dp = dpFor(unit);
  // if rounding pushes the mantissa up to 1000, step up a tier (avoids "1000 M")
  if (ti > 0 && Number((a / div).toFixed(dp)) >= 1000) {
    [div, unit] = tiers[--ti]; dp = dpFor(unit);
  }
  // up to 3 decimals, but trim trailing zeros so round values stay clean
  // (3.231 B -> "3,231 B"; 160 M -> "160 M", not "160,000 M")
  let s = (a / div).toFixed(dp);
  if (dp) s = s.replace(/\.?0+$/, "");
  s = s.replace(".", ",");
  return "Rp " + sign + s + (unit ? " " + unit : "");
}

// escape a value for use inside a CSS attribute selector
function cssEsc(s) { return String(s).replace(/["\\\]]/g, "\\$&"); }

// non-money formatters for ratios/percentages (Indonesian comma decimal)
function fmtPct(v) { return (v == null || isNaN(v)) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"; }
function fmtRatio(v) { return (v == null || isNaN(v)) ? "—" : v.toFixed(2).replace(".", ",") + "x"; }
function fmtDays(v) { return (v == null || isNaN(v)) ? "—" : Math.round(v) + " d"; }
function fmtMonths(v) { return (v == null || isNaN(v)) ? "—" : v.toFixed(1).replace(".", ",") + " mo"; }

const HEALTH_PILL = { healthy: "posted", watch: "draft", danger: "bad", "n/a": "inactive" };
const HEALTH_LABEL = { healthy: "Healthy", watch: "Watch", danger: "Danger", "n/a": "n/a" };
function healthStatusCls(s) { return s === "danger" ? "red" : s === "watch" ? "amber" : s === "healthy" ? "green" : ""; }
function healthVal(h) {
  if (h.value == null) return "—";
  if (h.is_pct) return fmtPct(h.value);
  if (h.key === "current_ratio") return fmtRatio(h.value);
  if (h.key === "dso_days") return fmtDays(h.value);
  if (h.key === "cash_buffer_months") return fmtMonths(h.value);
  return String(h.value);
}
function healthTarget(h) {
  const pre = h.dir === "low" ? "≤ " : "≥ ";
  if (h.target == null) return "—";
  if (h.is_pct) return pre + fmtPct(h.target);
  if (h.key === "current_ratio") return pre + fmtRatio(h.target);
  if (h.key === "dso_days") return pre + fmtDays(h.target);
  if (h.key === "cash_buffer_months") return pre + fmtMonths(h.target);
  return pre + h.target;
}

// entry-source pill colour (label text comes from the server's source_label)
const SOURCE_CLASS = {
  manual: "inactive", bca_bank: "active", bca_csv: "active",
  bca_pdf: "active", monit_wallet: "completed", excel: "draft",
};

function renderTbDetailed(d, consolidated) {
  const srcPill = e => `<span class="pill ${SOURCE_CLASS[e.source] || "inactive"}">${esc(e.source_label || e.source)}</span>`;
  const body = d.rows.map(acc => {
    const head = `<tr class="tb-acc section" data-code="${esc(acc.code)}" style="cursor:pointer">
      <td><span class="caret">&#9656;</span> ${esc(acc.code)}</td><td>${esc(acc.name)}</td><td>${esc(acc.type)}</td>
      <td class="num">${fmt(acc.debit)}</td><td class="num">${fmt(acc.credit)}</td><td class="num">${fmt(acc.balance)}</td></tr>`;
    const entries = (acc.entries || []).map(e => `<tr class="tb-entry" data-acc="${esc(acc.code)}" hidden>
      <td class="muted" style="padding-left:24px">${esc(e.date)}</td>
      <td><b>${esc(e.entry_no)}</b> — ${esc(e.description || e.line_desc || "")} ${srcPill(e)}${consolidated ? ` <span class="muted">${esc(e.company_code)}</span>` : ""}${e.reference ? ` <span class="muted">ref ${esc(e.reference)}</span>` : ""}</td>
      <td></td><td class="num">${e.debit ? fmt(e.debit) : ""}</td><td class="num">${e.credit ? fmt(e.credit) : ""}</td><td></td></tr>`).join("");
    return head + (entries || `<tr class="tb-entry" data-acc="${esc(acc.code)}" hidden><td></td><td class="muted" colspan="5">No posted entries in this period</td></tr>`);
  }).join("");
  return `<table class="tbl"><thead><tr><th>Code / Date</th><th>Account / Entry</th><th>Type</th>
    <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody>${body}
    <tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(d.total_debit)}</td>
      <td class="num">${fmt(d.total_credit)}</td><td></td></tr></tbody></table>
    <p class="muted mt">Click an account to expand its journal entries. The coloured tag is each entry&rsquo;s
      source (manual, BCA bank, Monit wallet, &hellip;).</p>`;
}

// click-through popup: every posted journal entry that hit one account
async function openAccountLedger(code, fallbackName) {
  const from = ($("#rdFrom") && $("#rdFrom").value) || `${state.year}-01-01`;
  const to = ($("#rdTo") && $("#rdTo").value) || `${state.year}-12-31`;
  openModal(`<div id="alBody"><div class="empty">Loading…</div></div>`, { title: "Account " + code });
  try {
    const d = await api(`/api/reports/account-ledger?${scopeQS()}&date_from=${from}&date_to=${to}&code=${encodeURIComponent(code)}`);
    const consolidated = state.companyId === "all";
    const rows = d.entries.map(e => `<tr>
      <td class="muted" style="white-space:nowrap">${esc(e.date)}</td>
      <td><b>${esc(e.entry_no)}</b>${consolidated ? ` <span class="muted">${esc(e.company_code)}</span>` : ""}</td>
      <td>${esc(e.description || e.line_desc || "")}${e.reference ? ` <span class="muted">ref ${esc(e.reference)}</span>` : ""}</td>
      <td><span class="pill ${SOURCE_CLASS[e.source] || "inactive"}">${esc(e.source_label || e.source)}</span></td>
      <td class="num">${e.debit ? fmt(e.debit) : ""}</td>
      <td class="num">${e.credit ? fmt(e.credit) : ""}</td></tr>`).join("")
      || `<tr><td colspan="6" class="empty">No posted entries in this period</td></tr>`;
    $("#alBody").innerHTML = `
      <div class="ledger-head">
        <div><b>${esc(d.code)} — ${esc(d.name || fallbackName)}</b>
          ${d.type ? ` <span class="pill">${esc(d.type)}</span>` : ""}</div>
        <div class="muted">${esc(d.scope)} · ${esc(d.date_from)} → ${esc(d.date_to)} · ${d.entries.length} entr${d.entries.length === 1 ? "y" : "ies"}</div>
      </div>
      <div class="ledger-scroll"><table class="tbl">
        <thead><tr><th>Date</th><th>Entry</th><th>Description</th><th>Source</th>
          <th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>${rows}
        <tr class="total"><td colspan="4">TOTAL</td><td class="num">${fmt(d.total_debit)}</td>
          <td class="num">${fmt(d.total_credit)}</td></tr></tbody></table></div>`;
  } catch (e) { $("#alBody").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// Opening-balances editor: enter each balance-sheet account's starting balance;
// the imbalance plugs to Retained Earnings and posts as one opening entry.
async function openOpeningBalances(onSaved) {
  const cid0 = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  openModal(`<div id="obBody"><div class="empty">Loading…</div></div>`, { title: "Opening Balances" });
  const fmtIn = n => n ? Math.round(n).toLocaleString("id-ID") : "";
  async function loadFor(cid) {
    const [accounts, existing] = await Promise.all([
      api("/api/accounts?company_id=" + cid),
      api("/api/reports/opening-balances?company_id=" + cid),
    ]);
    const prior = {}; (existing.lines || []).forEach(l => prior[l.code] = l);
    const data = accounts
      .filter(a => a.is_active && ["asset", "liability", "equity"].includes(a.type))
      .map(a => ({ code: a.code, name: a.name, type: a.type,
        debit: (prior[a.code] || {}).debit || 0, credit: (prior[a.code] || {}).credit || 0 }));
    const date = existing.date || `${state.year}-01-01`;
    const totals = () => {
      const td = data.reduce((s, r) => s + r.debit, 0), tc = data.reduce((s, r) => s + r.credit, 0);
      return { td, tc, diff: Math.round((td - tc) * 100) / 100 };
    };
    const renderTot = () => {
      const t = totals();
      $("#obTotD").textContent = fmt(t.td); $("#obTotC").textContent = fmt(t.tc);
      $("#obDiff").innerHTML = Math.abs(t.diff) < 0.01
        ? `<span class="pos">&#10003; Balanced</span>`
        : `Difference <b>${fmt(Math.abs(t.diff))}</b> → posts to <b>Retained Earnings (3200)</b> as ${t.diff > 0 ? "credit" : "debit"}`;
    };
    $("#obBody").innerHTML = `
      <div class="filters" style="margin-bottom:8px">
        <label>Company <select id="obCompany">${state.me.companies.map(c =>
          `<option value="${c.id}" ${String(c.id) === String(cid) ? "selected" : ""}>${esc(c.code)} — ${esc(c.name)}</option>`).join("")}</select></label>
        <label>As of date <input type="date" id="obDate" value="${date}"></label>
      </div>
      <p class="muted" style="margin-top:-2px">Enter each account&rsquo;s opening balance — assets as <b>Debit</b>, liabilities &amp; equity as <b>Credit</b>.
        Any difference is posted to Retained Earnings so the books balance. Saving replaces this company&rsquo;s previous opening entry.</p>
      <div style="max-height:48vh;overflow:auto"><table class="tbl">
        <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>${data.map((r, ri) => `<tr>
          <td><b>${esc(r.code)}</b></td><td>${esc(r.name)}</td><td>${r.type}</td>
          <td><input class="ob-deb" data-ri="${ri}" type="text" inputmode="numeric" style="text-align:right;width:128px" value="${fmtIn(r.debit)}"></td>
          <td><input class="ob-cre" data-ri="${ri}" type="text" inputmode="numeric" style="text-align:right;width:128px" value="${fmtIn(r.credit)}"></td>
        </tr>`).join("") || `<tr><td colspan="5" class="empty">No balance-sheet accounts</td></tr>`}</tbody>
        <tfoot><tr class="total"><td colspan="3">TOTAL</td><td class="num" id="obTotD"></td><td class="num" id="obTotC"></td></tr></tfoot>
      </table></div>
      <div class="ob-foot"><div id="obDiff"></div>
        <div class="form-actions"><button class="btn" id="obCancel">Cancel</button>
          <button class="btn btn-primary" id="obSave">Save opening balances</button></div></div>`;
    const wire = (sel, key) => $$(sel).forEach(inp => {
      const r = data[inp.dataset.ri];
      inp.addEventListener("focus", () => { inp.value = r[key] ? String(Math.round(r[key])) : ""; inp.select(); });
      inp.addEventListener("input", () => { r[key] = Number(inp.value.replace(/[^\d]/g, "")) || 0; renderTot(); });
      inp.addEventListener("blur", () => { inp.value = fmtIn(r[key]); });
    });
    wire("#obBody .ob-deb", "debit");
    wire("#obBody .ob-cre", "credit");
    renderTot();
    $("#obCompany").onchange = () => loadFor(parseInt($("#obCompany").value, 10));
    $("#obCancel").onclick = closeModal;
    $("#obSave").onclick = async () => {
      try {
        const r = await api("/api/reports/opening-balances", { json: {
          company_id: parseInt($("#obCompany").value, 10), date: $("#obDate").value,
          lines: data.map(x => ({ code: x.code, debit: x.debit, credit: x.credit })),
        } });
        toast("Opening balances saved" + (r.plugged_to ? ` — difference posted to ${r.plugged_to}` : ""));
        closeModal();
        if (onSaved) onSaved();
      } catch (e) { toast(e.message, true); }
    };
  }
  await loadFor(cid0);
}

async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.href = "/?login=1"; throw new Error("Session expired"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
  return data;
}

function toast(msg, isError) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  $("#toastRoot").appendChild(t);
  setTimeout(() => t.remove(), isError ? 6500 : 3200);
}

function openModal(html, opts = {}) {
  closeModal();
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${opts.small ? "small" : ""}">
    <div class="modal-head"><h3>${esc(opts.title || "")}</h3>
    <button class="modal-close" title="Close">&times;</button></div>
    <div class="modal-body">${html}</div></div></div>`;
  $(".modal-close", root).onclick = closeModal;
  $(".modal-backdrop", root).addEventListener("mousedown", e => {
    if (e.target.classList.contains("modal-backdrop")) closeModal();
  });
  return root;
}
function closeModal() { $("#modalRoot").innerHTML = ""; }

/* ------------------------------------------------------------------ charts */
function chartBars(labels, series, opts = {}) {
  const W = opts.width || 720, H = opts.height || 250;
  const padL = 58, padR = 8, padT = 12, padB = 26;
  let min = 0, max = 0;
  series.forEach(s => s.values.forEach(v => { min = Math.min(min, v); max = Math.max(max, v); }));
  if (max === 0 && min === 0) max = 1;
  max *= 1.08; if (min < 0) min *= 1.08;
  const y = v => padT + (max - v) / (max - min) * (H - padT - padB);
  const gw = (W - padL - padR) / labels.length;
  const bars = series.filter(s => s.type !== "line");
  const bw = (gw * 0.72) / Math.max(bars.length, 1);
  let out = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    out += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" style="stroke:var(--border)" stroke-width="1"/>`;
    out += `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" style="fill:var(--muted)">${fmtShort(v)}</text>`;
  }
  if (min < 0) out += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" style="stroke:var(--muted)" stroke-width="1.2"/>`;
  labels.forEach((lb, i) => {
    out += `<text x="${padL + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" style="fill:var(--muted)">${esc(lb)}</text>`;
  });
  const vfmt = opts.valueFmt || fmtShort;
  bars.forEach((s, si) => {
    s.values.forEach((v, i) => {
      const x = padL + i * gw + gw * 0.14 + si * bw;
      const y0 = y(Math.max(0, v)), h = Math.abs(y(v) - y(0));
      out += `<rect class="ch-bar" style="animation-delay:${(i * 0.03 + si * 0.012).toFixed(3)}s" x="${x}" y="${y0}" width="${bw - 2}" height="${Math.max(h, .5)}" rx="2" fill="${s.color}"><title>${esc(s.name)} ${esc(labels[i])}: ${fmt(v)}</title></rect>`;
      if (opts.valueLabels && v) {
        const cx = x + (bw - 2) / 2;
        const ty = v >= 0 ? y(v) - 5 : y(v) + 12;
        out += `<text x="${cx}" y="${ty}" text-anchor="middle" font-size="${opts.valueFont || 10}" font-weight="600" style="fill:var(--text)">${esc(vfmt(v))}</text>`;
      }
    });
  });
  series.filter(s => s.type === "line").forEach(s => {
    const pts = s.values.map((v, i) => `${padL + i * gw + gw / 2},${y(v)}`).join(" ");
    out += `<polyline class="ch-line" pathLength="1" points="${pts}" fill="none" style="stroke:${s.color}" stroke-width="2.4" stroke-linejoin="round"/>`;
    s.values.forEach((v, i) => {
      out += `<circle class="ch-dot" style="animation-delay:${(0.25 + i * 0.04).toFixed(3)}s" cx="${padL + i * gw + gw / 2}" cy="${y(v)}" r="3" fill="${s.color}"><title>${esc(s.name)} ${esc(labels[i])}: ${fmt(v)}</title></circle>`;
    });
  });
  out += "</svg>";
  const legend = `<div class="legend">${series.map(s =>
    `<span><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>`;
  return `<div class="chart-wrap">${out}${legend}</div>`;
}

function chartDonut(items, opts = {}) {
  const size = opts.size || 190, cx = size / 2, cy = size / 2, r = size / 2 - 6, ir = r * 0.62;
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0);
  if (!total) return `<div class="empty">No data</div>`;
  let angle = -Math.PI / 2, out = `<svg viewBox="0 0 ${size} ${size}" style="max-width:${size}px;margin:0 auto"><g class="ch-donut">`;
  items.forEach((it, i) => {
    const frac = Math.max(0, it.value) / total;
    if (frac <= 0) return;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (a, rad) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    out += `<path class="ch-slice" style="animation-delay:${(i * 0.05).toFixed(3)}s" d="M ${p(angle, r)} A ${r} ${r} 0 ${large} 1 ${p(a2, r)} L ${p(a2, ir)} A ${ir} ${ir} 0 ${large} 0 ${p(angle, ir)} Z"
      fill="${it.color}"><title>${esc(it.label)}: ${fmt(it.value)} (${(frac * 100).toFixed(1)}%)</title></path>`;
    angle = a2;
  });
  out += `</g><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="13" font-weight="700" style="fill:var(--text)">${fmtShort(total)}</text></svg>`;
  const legend = `<div class="legend" style="flex-direction:column;gap:5px">${items.map(it =>
    `<span><span class="dot" style="background:${it.color}"></span>${esc(it.label)} — <b>${fmtShort(it.value)}</b></span>`).join("")}</div>`;
  return `<div class="chart-wrap" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">${out}${legend}</div>`;
}

// Mores design palette — teal family + calm neutrals (one teal accent, restrained)
const PALETTE = ["#00a2b6", "#0a7d8c", "#7fcdd8", "#13a6b8", "#5b6b80", "#1f9d57", "#c87a08", "#9aa6b1"];
const C_REV = "#00a2b6", C_EXP = "#9aa6b1", C_PROFIT = "#1f9d57";
// AR aging bucket colours + status pill classes (Piutang)
const AR_BUCKET_COLOR = { not_due: "#1f9d57", d1_30: "#00a2b6", d31_60: "#c87a08", d61_90: "#d2691e", d90: "#bd362f" };
const AR_STATUS_PILL = { current: "posted", late_1_30: "draft", late_31_60: "draft", late_61_90: "draft", bad: "bad", paid: "inactive" };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROLE_LABELS = { admin: "Admin", finance: "Accountant", viewer: "Viewer/Auditor" };
const ROLE_DESC = {
  admin: "full access incl. users & settings",
  finance: "bookkeeping, budgets, projects, bank import",
  viewer: "read-only access to reports",
};

/* ------------------------------------------------------------------ i18n */
// English is the source language; Indonesian translations are looked up by the
// English string. Anything unmapped falls back to English.
const TR = {
  // navigation
  "Dashboard": "Dasbor", "Project HV": "Proyek HV", "Journal Entries": "Jurnal",
  "Bank Import": "Impor Bank", "Budgets": "Anggaran", "Investments": "Investasi",
  "Projects": "Proyek", "Reports": "Laporan", "Settings": "Pengaturan",
  // topbar
  "Company": "Perusahaan", "Year": "Tahun", "Logout": "Keluar",
  "all figures in IDR (Rp)": "semua angka dalam IDR (Rp)",
  // dashboard
  "Consolidated": "Konsolidasi", "All": "Semua",
  "Revenue YTD": "Pendapatan YTD", "Expenses YTD": "Beban YTD", "Net Profit": "Laba Bersih",
  "Working Capital · Today": "Modal Kerja · Hari Ini", "Office Expense": "Biaya Kantor",
  "Cash & Bank": "Kas & Bank", "Receivables": "Piutang", "Payables": "Utang",
  "Budget Used": "Anggaran Terpakai",
  "Monthly Revenue vs Expense — IDR": "Pendapatan vs Beban Bulanan — IDR",
  "Expense Breakdown — Realization vs Budget": "Rincian Beban — Realisasi vs Anggaran",
  // report / page titles + tabs
  "Financial Reports": "Laporan Keuangan", "Profit & Loss": "Laba Rugi",
  "Cash Flow": "Arus Kas", "Balance Sheet": "Neraca", "Trial Balance": "Neraca Saldo",
  "Budget vs Realization": "Anggaran vs Realisasi",
  "Investment Analysis": "Analisis Investasi", "Bank Import — BCA": "Impor Bank — BCA",
  "Gain vs Budget": "Laba vs Anggaran", "Performance": "Kinerja",
  // dashboard health / ratios / AR-AP (xlsx components)
  "Gross Margin": "Margin Kotor", "Operating Profit": "Laba Operasional",
  "Cash Buffer": "Buffer Kas", "Current Ratio": "Rasio Lancar",
  "Net Margin": "Margin Bersih", "DSO (days)": "DSO (hari)",
  "Cash Buffer (months)": "Buffer Kas (bulan)", "Salary / Revenue": "Rasio Gaji thd Pendapatan",
  "Financial Health Indicators": "Indikator Kesehatan Keuangan",
  "Metric": "Metrik", "Value": "Nilai", "Target": "Target", "Status": "Status",
  "Receivables, Payables & Net Position": "Piutang, Utang & Posisi Bersih",
  "Total Accounts Receivable": "Total Piutang Usaha", "Total Accounts Payable": "Total Hutang Usaha",
  "Risky AR (> 90 days)": "Piutang Berisiko (> 90 hari)",
  "Net Position (AR − AP)": "Posisi Bersih (Piutang − Hutang)",
  "Free Operating Cash": "Kas Bebas Operasional",
  // receivables / AR aging (Piutang)
  "Receivables": "Piutang", "AR Aging (Piutang)": "Daftar Umur Piutang",
  "As of": "Per Tanggal", "Add Invoice": "Tambah Invoice", "Client": "Klien",
  "Invoice": "No. Invoice", "Invoice Date": "Tgl Invoice", "Due Date": "Jatuh Tempo",
  "Amount": "Nilai Invoice", "Outstanding": "Sisa Tagihan", "Not Due": "Belum Jatuh Tempo",
  "Days Late": "Hari Terlambat", "Aging Summary": "Ringkasan Umur Piutang",
  "Bucket": "Kelompok Umur", "TOTAL": "TOTAL", "TOTAL OUTSTANDING": "TOTAL PIUTANG",
  "Risk": "Risiko", "Total Outstanding": "Total Piutang",
  "Current (Lancar)": "Lancar", "Late 1–30 (Terlambat)": "Terlambat 1–30",
  "Late 31–60 (Terlambat)": "Terlambat 31–60", "Late 61–90 (Terlambat)": "Terlambat 61–90",
  "Bad / >90 (Macet)": "Macet (>90)", "Paid (Lunas)": "Lunas",
  "1–30 d": "1–30 hr", "31–60 d": "31–60 hr", "61–90 d": "61–90 hr", "> 90 d": "> 90 hr",
  // common buttons
  "Apply": "Terapkan", "Export Excel": "Ekspor Excel", "Export PDF": "Ekspor PDF",
};
function t(s) { return state.lang === "id" ? (TR[s] || s) : s; }

// nav routes -> [icon glyph, English label]
const NAV_ITEMS = [
  ["dashboard", "▦", "Dashboard"], ["projecthv", "◉", "Project HV"],
  ["journals", "☰", "Journal Entries"], ["bank", "⇄", "Bank Import"],
  ["receivables", "◰", "Receivables"],
  ["budgets", "◎", "Budgets"], ["investments", "✦", "Investments"],
  ["projects", "△", "Projects"], ["reports", "▤", "Reports"],
  ["settings", "⚙", "Settings"],
];
function relabelChrome() {
  $$("#nav a").forEach(a => {
    const item = NAV_ITEMS.find(n => n[0] === a.dataset.route);
    if (item) a.innerHTML = `${item[1]} <span class="nav-t">${esc(t(item[2]))}</span>`;
  });
  const set = (sel, s) => { const el = $(sel); if (el) el.textContent = s; };
  set("#lblCompany", t("Company"));
  set("#lblYear", t("Year"));
  set("#logoutBtn", t("Logout"));
  const lb = $("#langBtn"); if (lb) lb.textContent = state.lang === "id" ? "EN" : "ID";
  document.documentElement.lang = state.lang;
}

/* ------------------------------------------------------------------ state */
const state = {
  me: null,
  companyId: localStorage.getItem("erp.company") || "all",
  year: parseInt(localStorage.getItem("erp.year") || "2026", 10),
  lang: localStorage.getItem("erp.lang") || "en",
};
const canWrite = () => state.me && state.me.role !== "viewer";
const isAdmin = () => state.me && state.me.role === "admin";
const scopeQS = () => `company_id=${state.companyId}&year=${state.year}`;
function firstCompanyId() {
  const c = state.me.companies.find(c => !c.is_holding) || state.me.companies[0];
  return c ? c.id : null;
}
function companyOptions(selected, { includeAll } = {}) {
  let html = includeAll ? `<option value="all" ${selected === "all" ? "selected" : ""}>All companies (consolidated)</option>` : "";
  html += state.me.companies.map(c =>
    `<option value="${c.id}" ${String(selected) === String(c.id) ? "selected" : ""}>${esc(c.code)} — ${esc(c.name)}</option>`).join("");
  return html;
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  state.me = await api("/api/me");
  $("#userBox").innerHTML = `<b>${esc(state.me.full_name || state.me.username)}</b>
    <span class="muted">${esc(ROLE_LABELS[state.me.role] || state.me.role)}</span>`;
  if (!canWrite()) { const a = $('#nav a[data-route="bank"]'); if (a) a.style.display = "none"; }
  renderCompanyChoice();
  updateDbBadge();
  const ys = $("#yearSelect");
  const years = [];
  for (let y = 2024; y <= new Date().getFullYear() + 1; y++) years.push(y);
  ys.innerHTML = years.map(y => `<option ${y === state.year ? "selected" : ""}>${y}</option>`).join("");
  ys.onchange = () => { state.year = parseInt(ys.value, 10); localStorage.setItem("erp.year", ys.value); render(); };
  $("#logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST" }); window.location.href = "/"; };
  const themeBtn = $("#themeBtn");
  const applyThemeIcon = () => { themeBtn.innerHTML = document.documentElement.dataset.theme === "dark" ? "&#9728;" : "&#127769;"; };
  applyThemeIcon();
  themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("erp.theme", next);
    applyThemeIcon();
  };
  const langBtn = $("#langBtn");
  if (langBtn) langBtn.onclick = () => {
    state.lang = state.lang === "id" ? "en" : "id";
    localStorage.setItem("erp.lang", state.lang);
    relabelChrome();
    renderCompanyChoice();
    render();
  };
  relabelChrome();
  window.addEventListener("hashchange", render);
  render();
}

// Topbar company picker as choice buttons (not a dropdown).
function renderCompanyChoice() {
  const box = $("#companyChoice");
  if (!box) return;
  const seg = (label, val, title) => `<button class="seg ${String(state.companyId) === String(val) ? "active" : ""}" data-company="${val}" title="${esc(title || label)}">${esc(label)}</button>`;
  const holding = state.me.companies.find(c => c.is_holding);
  box.innerHTML = seg(t("All"), "all", "Consolidated (all companies)")
    + (holding ? seg("Holding", holding.id, holding.name) : "")
    + state.me.companies.filter(c => !c.is_holding).map(c => seg(c.code, c.id, c.name)).join("");
  $$("#companyChoice .seg").forEach(b => b.onclick = () => {
    state.companyId = b.dataset.company;
    localStorage.setItem("erp.company", b.dataset.company);
    renderCompanyChoice();
    render();
  });
}

const routes = {
  dashboard: pageDashboard, projecthv: pageProjectHV, journals: pageJournals,
  bank: pageBank, receivables: pageReceivables, budgets: pageBudgets,
  investments: pageInvestments, projects: pageProjects, reports: pageReports,
  settings: pageSettings,
};
const INV_CATEGORIES = {
  scholarship: "Scholarship", partnership: "Partnership", rnd: "R&D",
  csr: "CSR", strategic: "Strategic", other: "Other",
};

async function render() {
  const route = (location.hash || "#/dashboard").replace("#/", "").split("?")[0] || "dashboard";
  $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === route));
  const fn = routes[route] || pageDashboard;
  const el = $("#content");
  el.innerHTML = `<div class="empty">Loading…</div>`;
  try { await fn(el); } catch (e) { el.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; }
}

/* ------------------------------------------------------------------ dashboard */
async function pageDashboard(el) {
  const d = await api(`/api/reports/dashboard?${scopeQS()}`);
  $("#scopeBadge").textContent = d.scope;
  const k = d.kpis;
  const kpi = (label, value, cls, sub) => `<div class="kpi ${cls || ""}">
    <div class="kpi-label">${label}</div><div class="kpi-value" title="${fmtRp(value)}">${fmtShortRp(value)}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  // raw-value KPI (ratios/percent/days — not money)
  const kpiv = (label, valStr, status, sub) => `<div class="kpi ${healthStatusCls(status)}">
    <div class="kpi-label">${label}</div><div class="kpi-value">${valStr}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
  const hb = {}; (d.health || []).forEach(h => hb[h.key] = h);
  const st = key => (hb[key] || {}).status;
  const monthly = d.monthly;
  const bvaPct = k.budget_used_pct;
  const holding = state.me.companies.find(c => c.is_holding);
  const seg = (label, val) => `<button class="seg ${String(state.companyId) === String(val) ? "active" : ""}" data-scope="${val}">${label}</button>`;
  // Office Expense = rent (6200) + utilities (6300) + office & admin group (66xx, incl. bank admin fees)
  const officeRows = d.expense_breakdown.filter(r => ["6200", "6300"].includes(r.code) || String(r.code).startsWith("66"));
  const officeActual = round2(officeRows.reduce((a, r) => a + r.actual, 0));
  const officeBudget = round2(officeRows.reduce((a, r) => a + r.budget, 0));
  const officeUsed = officeBudget ? Math.round(100 * officeActual / officeBudget) : null;
  el.innerHTML = `
    <div class="page-head"><h2>${t("Dashboard")} — ${state.year} <span class="muted" style="font-size:13px;font-weight:500">· ${t("all figures in IDR (Rp)")}</span></h2>
      <div class="seg-group" id="dashScope">
        ${seg(t("Consolidated"), "all")}
        ${holding ? seg("Holding", holding.id) : ""}
        ${state.me.companies.filter(c => !c.is_holding).map(c => seg(c.code, c.id)).join("")}
      </div></div>
    ${(d.warnings && d.warnings.length) ? `<div class="warn-banner">
      ${d.warnings.map(w => `<div class="warn ${w.level === "danger" ? "danger" : "watch"}">
        <span class="warn-ic">${w.level === "danger" ? "⚠" : "›"}</span>
        <span><b>${esc(w.title)}</b> — ${esc(w.detail)}${w.amount ? ` <b>${fmtRp(w.amount)}</b>` : ""}</span></div>`).join("")}
    </div>` : ""}
    <div class="grid kpis">
      ${kpi(t("Revenue YTD"), k.revenue_ytd)}
      ${kpi(t("Net Profit"), k.net_profit_ytd, k.net_profit_ytd >= 0 ? "green" : "red", `Margin ${k.margin_pct}%`)}
      ${kpiv(t("Gross Margin"), fmtPct(k.gross_margin), st("gross_margin"), `target ≥ ${fmtPct((hb.gross_margin || {}).target)}`)}
      ${kpi(t("Operating Profit"), k.operating_profit, k.operating_profit >= 0 ? "green" : "red")}
      ${kpiv(t("Cash Buffer"), fmtMonths(k.cash_buffer_months), st("cash_buffer_months"), `target ≥ ${fmtMonths((hb.cash_buffer_months || {}).target)}`)}
      ${kpiv(t("DSO"), fmtDays(k.dso_days), st("dso_days"), `target ≤ ${fmtDays((hb.dso_days || {}).target)}`)}
      ${kpiv(t("Current Ratio"), fmtRatio(k.current_ratio), st("current_ratio"), `target ≥ ${fmtRatio((hb.current_ratio || {}).target)}`)}
      ${kpi(t("Working Capital · Today"), k.working_capital, k.working_capital >= 0 ? "green" : "red",
        `as of ${d.as_of} · CA ${fmtShortRp(k.current_assets)} − CL ${fmtShortRp(k.current_liabilities)}`)}
      ${kpi(t("Cash & Bank"), k.cash_balance)}
      ${kpi(t("Receivables"), k.accounts_receivable)}
      ${kpi(t("Payables"), k.accounts_payable)}
      <div class="kpi ${bvaPct != null && bvaPct > 100 ? "red" : ""}">
        <div class="kpi-label">${t("Budget Used")}</div>
        <div class="kpi-value">${bvaPct == null ? "n/a" : bvaPct + "%"}</div>
        <div class="kpi-sub">of ${fmtShortRp(k.budget_expense)} expense budget</div>
      </div>
    </div>
    <div class="grid two-col">
      <div class="card"><h3>${t("Monthly Revenue vs Expense — IDR")} (${state.year})</h3>
        ${chartBars(MONTH_NAMES, [
          { name: "Revenue", color: C_REV, values: monthly.map(m => m.revenue) },
          { name: "Expense", color: C_EXP, values: monthly.map(m => m.expense) },
          { name: "Profit", color: C_PROFIT, values: monthly.map(m => m.profit), type: "line" },
        ])}</div>
      <div class="card"><h3>${t("Expense Breakdown — Realization vs Budget")}</h3>
        ${chartDonut(d.expense_breakdown.slice(0, 8).map((r, i) => ({
          label: r.code + " " + r.name, value: r.actual, color: PALETTE[i % PALETTE.length] })))}
        <div class="office-total mt">
          <span><b>Office Expense</b> <span class="muted">(rent · utilities · admin)</span></span>
          <span>Realization <b>${fmtRp(officeActual)}</b> · Budget <b>${fmtRp(officeBudget)}</b>
            ${officeUsed == null ? "" : `· <span class="${officeUsed > 100 ? "neg" : "pos"}">${officeUsed}% used</span>`}</span>
        </div>
        <div style="max-height:240px;overflow:auto" class="mt"><table class="tbl">
          <thead><tr><th>Account</th><th class="num">Realization</th><th class="num">Budget</th><th class="num">Used</th></tr></thead>
          <tbody>${d.expense_breakdown.map(r => {
            const used = r.budget ? Math.round(100 * r.actual / r.budget) : null;
            return `<tr><td>${esc(r.code)} ${esc(r.name)}</td>
              <td class="num">${fmt(r.actual)}</td>
              <td class="num muted">${fmt(r.budget)}</td>
              <td class="num ${used != null && used > 100 ? "neg" : ""}">${used == null ? "—" : used + "%"}</td></tr>`;
          }).join("") || `<tr><td colspan="4" class="empty">No expenses</td></tr>`}</tbody></table></div>
      </div>
    </div>
    <div class="grid two-col mt">
      <div class="card"><h3>${t("Financial Health Indicators")}</h3>
        <table class="tbl"><thead><tr><th>${t("Metric")}</th><th class="num">${t("Value")}</th><th class="num">${t("Target")}</th><th>${t("Status")}</th></tr></thead>
          <tbody>${(d.health || []).map(h => `<tr>
            <td>${esc(t(h.label))}</td>
            <td class="num"><b>${healthVal(h)}</b></td>
            <td class="num muted">${healthTarget(h)}</td>
            <td><span class="pill ${HEALTH_PILL[h.status] || "inactive"}">${HEALTH_LABEL[h.status] || h.status}</span></td></tr>`).join("")}
          </tbody></table>
        <p class="muted mt">Thresholds set in Settings → Thresholds. <b>Healthy</b> = on target · <b>Watch</b> = approaching · <b>Danger</b> = past the limit.</p>
      </div>
      ${(() => { const aa = d.ar_ap || {}; return `<div class="card"><h3>${t("Receivables, Payables & Net Position")}</h3>
        <table class="tbl"><tbody>
          <tr><td>${t("Total Accounts Receivable")}</td><td class="num"><b>${fmtRp(aa.ar)}</b></td></tr>
          <tr><td>${t("Risky AR (> 90 days)")}</td><td class="num muted">${aa.risky_ar == null ? "— (from AR Aging)" : fmtRp(aa.risky_ar)}</td></tr>
          <tr><td>${t("Total Accounts Payable")}</td><td class="num"><b>${fmtRp(aa.ap)}</b></td></tr>
          <tr class="total"><td>${t("Net Position (AR − AP)")}</td><td class="num ${(aa.net_position || 0) >= 0 ? "pos" : "neg"}"><b>${fmtRp(aa.net_position)}</b></td></tr>
          <tr><td>${t("Free Operating Cash")}</td><td class="num">${fmtRp(aa.free_cash)}</td></tr>
        </tbody></table>
        ${(d.cost_overrun && d.cost_overrun.accounts && d.cost_overrun.accounts.length) ? `<h3 style="margin-top:16px">Cost Overrun — over the YTD budget pace</h3>
        <table class="tbl"><thead><tr><th>Account</th><th class="num">Actual</th><th class="num">YTD Budget</th><th class="num">Over</th></tr></thead>
          <tbody>${d.cost_overrun.accounts.map(a => `<tr><td>${esc(a.code)} ${esc(a.name)}</td>
            <td class="num">${fmt(a.actual)}</td><td class="num muted">${fmt(a.prorated_budget)}</td>
            <td class="num neg">${fmt(a.over)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>`; })()}
    </div>
    <div class="card mt"><h3>Monthly Cash Flow (${state.year})</h3>
      ${chartBars(MONTH_NAMES, [
        { name: "Cash In", color: C_REV, values: d.cash_flow.monthly.map(m => m.cash_in) },
        { name: "Cash Out", color: C_EXP, values: d.cash_flow.monthly.map(m => m.cash_out) },
        { name: "Ending Balance", color: "var(--text)", values: d.cash_flow.monthly.map(m => m.ending), type: "line" },
      ])}
      <div class="muted mt">Opening ${fmtShort(d.cash_flow.opening_balance)} · In ${fmtShort(d.cash_flow.total_in)}
        · Out ${fmtShort(d.cash_flow.total_out)} · Net ${fmtShort(d.cash_flow.net_change)}
        · Closing <b>${fmtShort(d.cash_flow.closing_balance)}</b></div>
    </div>
    <div class="grid two-col mt">
      <div class="card"><h3>Project Performance — click a project for budget vs realization</h3>
        <table class="tbl"><thead><tr><th>Project</th><th>Company</th>
          <th class="num">Revenue</th><th class="num">Budget Rev</th>
          <th class="num">Profit</th><th class="num">Budget Gain</th><th class="num">Margin</th></tr></thead>
        <tbody>${d.projects.map(p => {
          const budgetGain = round2((p.budget_revenue || 0) - (p.budget_expense || 0));
          return `<tr class="clickable" data-proj="${p.project_id}" data-company="${esc(p.company)}" data-name="${esc(p.code)} — ${esc(p.name)}">
            <td><b>${esc(p.code)}</b> ${esc(p.name)}</td><td>${esc(p.company)}</td>
            <td class="num">${fmt(p.revenue)}</td><td class="num muted">${fmt(p.budget_revenue)}</td>
            <td class="num ${p.profit >= 0 ? "pos" : "neg"}">${fmt(p.profit)}</td>
            <td class="num muted">${fmt(budgetGain)}</td>
            <td class="num">${p.margin_pct}%</td></tr>`;
        }).join("") || `<tr><td colspan="7" class="empty">No project activity</td></tr>`}</tbody></table>
      </div>
      <div class="card"><h3>Per Company (${state.year})</h3>
        <table class="tbl"><thead><tr><th>Company</th><th class="num">Revenue</th><th class="num">Expense</th><th class="num">Profit</th></tr></thead>
        <tbody>${d.per_company.map(c => `<tr><td>${esc(c.code)} — ${esc(c.name)}${c.is_holding ? ' <span class="pill completed">holding</span>' : ""}</td>
          <td class="num">${fmt(c.revenue)}</td><td class="num">${fmt(c.expense)}</td>
          <td class="num ${c.profit >= 0 ? "pos" : "neg"}">${fmt(c.profit)}</td></tr>`).join("") ||
          `<tr><td colspan="4" class="empty">No activity</td></tr>`}</tbody></table>
      </div>
    </div>`;
  $$("#dashScope .seg").forEach(b => b.onclick = () => {
    state.companyId = b.dataset.scope;
    localStorage.setItem("erp.company", b.dataset.scope);
    renderCompanyChoice();  // keep topbar choice in sync
    render();
  });
  $$("#content tr[data-proj]").forEach(tr => tr.onclick = () =>
    dashProjectDetail(tr.dataset.proj, tr.dataset.company, tr.dataset.name));
}

const round2 = n => Math.round((n || 0) * 100) / 100;

async function dashProjectDetail(projectId, companyCode, name) {
  const company = state.me.companies.find(c => c.code === companyCode);
  if (!company) { toast("Company not accessible", true); return; }
  const d = await api(`/api/reports/project-budget-vs-actual?company_id=${company.id}&project_id=${projectId}&year=${state.year}`);
  // Revenue + COGS accounts only, Budget vs Realization
  const rows = d.rows.filter(r => r.type === "revenue" || r.code.startsWith("5100") || r.code.startsWith("5000"));
  const chart = rows.length ? chartBars(rows.map(r => r.code), [
    { name: "Budget", color: "#9ca3af", values: rows.map(r => r.budget) },
    { name: "Realization", color: C_REV, values: rows.map(r => r.actual) },
  ], { height: 230 }) : `<div class="empty">No revenue/COGS budget or realization for this project.</div>`;
  openModal(`
    <div class="muted" style="margin-top:-4px">${esc(companyCode)} · Budget vs Realization (Revenue &amp; COGS) — ${state.year}</div>
    ${chart}
    <table class="tbl mt"><thead><tr><th>Code</th><th>Account</th><th>Type</th>
      <th class="num">Budget</th><th class="num">Realization</th><th class="num">Variance</th><th class="num">Used</th></tr></thead>
      <tbody>${rows.map(r => {
        const bad = r.type === "expense" ? r.variance > 0 : r.variance < 0;
        return `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${r.type}</td>
          <td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.actual)}</td>
          <td class="num ${bad ? "neg" : "pos"}">${fmt(r.variance)}</td>
          <td class="num">${r.used_pct == null ? "—" : r.used_pct + "%"}</td></tr>`;
      }).join("") || `<tr><td colspan="7" class="empty">No revenue/COGS lines</td></tr>`}</tbody></table>`,
    { title: name });
}

/* ------------------------------------------------------------------ project HV */
function ytdFactor() {
  // completed months of the selected year (full-year budgets are prorated
  // so a mid-year view compares like with like)
  const now = new Date();
  if (state.year < now.getFullYear()) return 1;
  if (state.year > now.getFullYear()) return 1;
  return Math.max(1, now.getMonth()) / 12;
}

function projectHealth(p, factor) {
  const budgetProfit = (p.budget_revenue || 0) - (p.budget_expense || 0);
  const target = budgetProfit * factor;  // YTD share of the annual budget
  if (!p.revenue && !p.expense) return { label: "No activity", cls: "inactive", ach: null, budgetProfit, target };
  if (target > 0) {
    const ach = Math.round(100 * p.profit / target);
    if (ach >= 90) return { label: "Good", cls: "posted", ach, budgetProfit, target };
    if (ach >= 50) return { label: "Watch", cls: "draft", ach, budgetProfit, target };
    return { label: "Underperforming", cls: "bad", ach, budgetProfit, target };
  }
  if (p.profit > 0 && p.margin_pct >= 15) return { label: "Good", cls: "posted", ach: null, budgetProfit, target };
  if (p.profit > 0) return { label: "Watch", cls: "draft", ach: null, budgetProfit, target };
  return { label: "Loss", cls: "bad", ach: null, budgetProfit, target };
}

async function pageProjectHV(el) {
  const [perf, all] = await Promise.all([
    api(`/api/projects/performance?${scopeQS()}`),
    api(`/api/projects?company_id=${state.companyId}`),
  ]);
  $("#scopeBadge").textContent = perf.scope;
  const perfBy = {}; perf.rows.forEach(p => perfBy[p.project_id] = p);
  const factor = ytdFactor();
  const rows = all.map(p => Object.assign(
    { project_id: p.id, code: p.code, name: p.name, company: p.company_code, status: p.status,
      revenue: 0, expense: 0, profit: 0, margin_pct: 0, budget_revenue: 0, budget_expense: 0 },
    perfBy[p.id] || {}));
  rows.forEach(r => r.health = projectHealth(r, factor));
  rows.sort((a, b) => b.profit - a.profit);
  const active = rows.filter(r => r.revenue || r.expense);
  const good = rows.filter(r => r.health.label === "Good").length;
  const totalGain = rows.reduce((a, r) => a + r.profit, 0);
  const totalTarget = rows.reduce((a, r) => a + r.health.target, 0);
  const ytdLabel = factor < 1 ? ` (YTD ${Math.round(factor * 12)} months)` : "";
  // portfolio Revenue / COGS / Profit — actual (YTD) vs budget prorated to the
  // same completed-month window, so a mid-year view compares like with like
  const sum = f => rows.reduce((a, r) => a + (f(r) || 0), 0);
  const aRev = sum(r => r.revenue), bRev = sum(r => r.budget_revenue) * factor;
  const aCogs = sum(r => r.expense), bCogs = sum(r => r.budget_expense) * factor;
  const aProfit = aRev - aCogs, bProfit = bRev - bCogs;

  el.innerHTML = `
    <div class="page-head"><h2>${t("Project HV")} — ${t("Gain vs Budget")} ${state.year}</h2>
      <div class="page-actions">
        <a class="btn" href="/api/export/project-performance?${scopeQS()}">&#x2913; Export Excel</a>
      </div></div>
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">Projects</div><div class="kpi-value">${rows.length}</div>
        <div class="kpi-sub">${active.length} active this year</div></div>
      <div class="kpi green"><div class="kpi-label">On Track (Good)</div><div class="kpi-value">${good}</div>
        <div class="kpi-sub">of ${active.length} active</div></div>
      <div class="kpi ${totalGain >= 0 ? "green" : "red"}"><div class="kpi-label">Total Gain (Profit)</div>
        <div class="kpi-value">${fmtShort(totalGain)}</div></div>
      <div class="kpi"><div class="kpi-label">Budget Target${ytdLabel}</div><div class="kpi-value">${fmtShort(totalTarget)}</div>
        <div class="kpi-sub">${totalTarget ? Math.round(100 * totalGain / totalTarget) + "% achieved" : ""}</div></div>
    </div>
    <div class="card"><h3>Actual vs Budget — Revenue · COGS · Profit <span class="muted" style="font-weight:500">(IDR, ${state.year}${factor < 1 ? ` · YTD ${Math.round(factor * 12)} months` : ""})</span></h3>
      ${chartBars(["Revenue", "COGS", "Profit"], [
        { name: "Actual", color: C_REV, values: [aRev, aCogs, aProfit] },
        { name: "Budget" + ytdLabel, color: "#9ca3af", values: [bRev, bCogs, bProfit] },
      ], { height: 300, width: 760, valueLabels: true, valueFont: 12, valueFmt: fmtShort })}
      <div class="ph-avb-grid">
        ${[["Revenue", aRev, bRev], ["COGS", aCogs, bCogs], ["Profit", aProfit, bProfit]].map(([lbl, a, b]) => {
          const v = a - b, used = b ? Math.round(100 * a / b) : null;
          const good = lbl === "COGS" ? v <= 0 : v >= 0;  // lower COGS is good
          return `<div class="ph-avb">
            <div class="ph-avb-t">${lbl}</div>
            <div class="ph-avb-row"><span>Actual</span><b>${fmtRp(a)}</b></div>
            <div class="ph-avb-row"><span>Budget</span><span class="muted">${fmtRp(b)}</span></div>
            <div class="ph-avb-row"><span>Variance</span><b class="${good ? "pos" : "neg"}">${fmtRp(v)}${used == null ? "" : ` · ${used}%`}</b></div>
          </div>`;
        }).join("")}
      </div></div>
    <div class="card mt"><h3>Actual Gain vs Budget Target${ytdLabel} per Project</h3>
      ${chartBars(active.map(r => r.code), [
        { name: "Actual Profit", color: C_REV, values: active.map(r => r.profit) },
        { name: "Budget Target" + ytdLabel, color: "#9ca3af", values: active.map(r => r.health.target) },
      ])}</div>
    <div class="card mt"><h3>Project Scoreboard</h3>
      <table class="tbl"><thead><tr><th>Project</th><th>Company</th>
        <th class="num">Revenue</th><th class="num">Budget Rev</th>
        <th class="num">Expense</th><th class="num">Budget Exp</th>
        <th class="num">Gain</th><th class="num">Target${ytdLabel}</th>
        <th class="num">Achieved</th><th class="num">Margin</th><th>Verdict</th></tr></thead>
      <tbody>${rows.map(r => {
        const overBudgetExp = r.budget_expense && r.expense > r.budget_expense;
        return `<tr>
          <td><b>${esc(r.code)}</b> ${esc(r.name)}</td><td>${esc(r.company)}</td>
          <td class="num">${fmt(r.revenue)}</td><td class="num muted">${fmt(r.budget_revenue)}</td>
          <td class="num ${overBudgetExp ? "neg" : ""}">${fmt(r.expense)}</td><td class="num muted">${fmt(r.budget_expense)}</td>
          <td class="num ${r.profit >= 0 ? "pos" : "neg"}"><b>${fmt(r.profit)}</b></td>
          <td class="num muted">${fmt(r.health.target)}</td>
          <td class="num">${r.health.ach == null ? "-" : r.health.ach + "%"}</td>
          <td class="num">${r.margin_pct}%</td>
          <td><span class="pill ${r.health.cls}">${r.health.label}</span></td></tr>`;
      }).join("") || `<tr><td colspan="11" class="empty">No projects</td></tr>`}</tbody></table>
      <p class="muted mt">Target = annual budget gain${factor < 1 ? " prorated to completed months (" + Math.round(factor * 12) + "/12)" : ""}.
      Verdict: <b>Good</b> ≥ 90% of target (or margin ≥ 15% without budget) ·
      <b>Watch</b> 50–90% · <b>Underperforming / Loss</b> below 50% or negative. Red expense = over budget.</p>
    </div>
    <div class="card mt"><h3>Project Analysis — Diagrams &amp; Comparison</h3>
      <div class="filters">
        <label>Project <select id="phProj"><option value="">All projects (portfolio)</option>
          ${active.map(r => `<option value="${r.project_id}">${esc(r.code)} — ${esc(r.name)}</option>`).join("")}</select></label>
        <label>Comparison mode <select id="phMode">
          <option value="budget">Level 1 — Actual vs Budget (${state.year})</option>
          <option value="lastyear">Level 2 — vs Last Year (${state.year} / ${state.year - 1})</option>
          <option value="trend3">Level 3 — 3-Year Trend (${state.year - 2}–${state.year})</option>
        </select></label>
      </div>
      <div id="phChart"><div class="empty">Loading…</div></div>
      <div id="phNotes"></div>
    </div>
    <div class="card mt"><h3>Compare Two Projects</h3>
      <div class="filters">
        <label>Project A <select id="cmpA">${active.map((r, i) => `<option value="${r.project_id}" ${i === 0 ? "selected" : ""}>${esc(r.code)} — ${esc(r.name)}</option>`).join("")}</select></label>
        <label>vs</label>
        <label>Project B <select id="cmpB">${active.map((r, i) => `<option value="${r.project_id}" ${i === 1 ? "selected" : ""}>${esc(r.code)} — ${esc(r.name)}</option>`).join("")}</select></label>
      </div>
      <div id="cmpBody"></div>
    </div>`;

  const bullets = items => `<ul style="margin:10px 0 0;padding-left:20px;line-height:1.9">${items.map(t => `<li>${t}</li>`).join("")}</ul>`;
  const pct = (a, b) => b ? Math.round(100 * a / b) : null;

  async function renderAnalysis() {
    const pid = $("#phProj").value;
    const mode = $("#phMode").value;
    const chartEl = $("#phChart"), notesEl = $("#phNotes");
    chartEl.innerHTML = `<div class="empty">Loading…</div>`;

    if (!pid) {  /* portfolio level */
      if (!active.length) {
        chartEl.innerHTML = `<div class="empty">No project has posted revenue or cost in ${state.year} yet — book project-tagged entries to populate this view.</div>`;
        notesEl.innerHTML = "";
        return;
      }
      if (mode === "budget") {
        chartEl.innerHTML = chartBars(active.map(r => r.code), [
          { name: "Actual Gain", color: C_REV, values: active.map(r => r.profit) },
          { name: "Budget Target" + ytdLabel, color: "#9ca3af", values: active.map(r => r.health.target) },
        ]);
        const best = active[0], worst = active[active.length - 1];
        notesEl.innerHTML = bullets([
          `Portfolio gain <b>${fmt(totalGain)}</b> vs target <b>${fmt(totalTarget)}</b> — <b>${pct(totalGain, totalTarget) || 0}% achieved</b>.`,
          `Strongest contributor: <b>${esc(best.code)}</b> (${fmt(best.profit)}, ${best.health.ach || "-"}% of target).`,
          `Weakest: <b>${esc(worst.code)}</b> (${fmt(worst.profit)}, ${worst.health.ach || "-"}% of target).`,
          `${active.filter(r => r.health.label === "Good").length} of ${active.length} projects are on track.`,
        ]);
      } else {
        const years = mode === "lastyear" ? [state.year - 1, state.year]
                                          : [state.year - 2, state.year - 1, state.year];
        const perfs = await Promise.all(years.map(y =>
          api(`/api/projects/performance?company_id=${state.companyId}&year=${y}`)));
        const byYear = perfs.map(p => { const m = {}; p.rows.forEach(r => m[r.code] = r); return m; });
        const colors = ["#9ca3af", "#2f96b4", C_REV].slice(-years.length);
        chartEl.innerHTML = chartBars(active.map(r => r.code),
          years.map((y, i) => ({ name: String(y), color: colors[i],
            values: active.map(r => (byYear[i][r.code] || {}).profit || 0) })));
        const tot = i => active.reduce((a, r) => a + ((byYear[i][r.code] || {}).profit || 0), 0);
        const lastTot = tot(years.length - 2), curTot = tot(years.length - 1);
        const growth = lastTot ? Math.round(100 * (curTot - lastTot) / Math.abs(lastTot)) : null;
        notesEl.innerHTML = bullets([
          `Portfolio gain ${years[years.length - 1]}: <b>${fmt(curTot)}</b> vs ${years[years.length - 2]}: <b>${fmt(lastTot)}</b>` +
            (growth != null ? ` — <b>${growth >= 0 ? "+" : ""}${growth}%</b> growth.` : "."),
          ...(mode === "trend3" ? [`${years[0]} baseline: <b>${fmt(tot(0))}</b> — trend is ${tot(0) <= lastTot && lastTot <= curTot ? "<b>consistently improving</b>" : "mixed"}.`] : []),
          `Note: ${state.year} contains ${Math.round(factor * 12)} completed months — full-year figures will grow.`,
        ]);
      }
      return;
    }

    /* single project */
    const proj = rows.find(r => String(r.project_id) === pid);
    if (mode === "budget") {
      const monthly = await api(`/api/projects/${pid}/monthly?year=${state.year}`);
      const targetMonthly = proj.health.budgetProfit / 12;
      chartEl.innerHTML = chartBars(MONTH_NAMES, [
        { name: "Revenue", color: C_REV, values: monthly.map(m => m.revenue) },
        { name: "Expense", color: C_EXP, values: monthly.map(m => m.expense) },
        { name: "Profit", color: C_PROFIT, values: monthly.map(m => m.profit), type: "line" },
        { name: "Monthly budget gain", color: "var(--muted)", values: monthly.map(() => targetMonthly), type: "line" },
      ]);
      notesEl.innerHTML = bullets([
        `Gain <b>${fmt(proj.profit)}</b> vs YTD target <b>${fmt(proj.health.target)}</b> — <b>${proj.health.ach || "-"}%</b> (${proj.health.label}).`,
        `Revenue <b>${fmt(proj.revenue)}</b> against annual budget <b>${fmt(proj.budget_revenue)}</b> (${pct(proj.revenue, proj.budget_revenue * factor) || "-"}% of YTD share).`,
        `Costs <b>${fmt(proj.expense)}</b> against annual cost budget <b>${fmt(proj.budget_expense)}</b>${proj.budget_expense && proj.expense > proj.budget_expense * factor ? " — <b>running over the YTD cost line</b>." : " — within the YTD cost line."}`,
        `Margin <b>${proj.margin_pct}%</b>.`,
      ]);
    } else {
      const years = mode === "lastyear" ? [state.year - 1, state.year]
                                        : [state.year - 2, state.year - 1, state.year];
      const series = await Promise.all(years.map(y => api(`/api/projects/${pid}/monthly?year=${y}`)));
      if (mode === "lastyear") {
        chartEl.innerHTML = chartBars(MONTH_NAMES, [
          { name: `Profit ${years[0]}`, color: "#9ca3af", values: series[0].map(m => m.profit) },
          { name: `Profit ${years[1]}`, color: C_REV, values: series[1].map(m => m.profit) },
        ]);
      } else {
        const sums = series.map(s => ({
          revenue: s.reduce((a, m) => a + m.revenue, 0),
          expense: s.reduce((a, m) => a + m.expense, 0),
          profit: s.reduce((a, m) => a + m.profit, 0),
        }));
        chartEl.innerHTML = chartBars(years.map(String), [
          { name: "Revenue", color: C_REV, values: sums.map(s => s.revenue) },
          { name: "Expense", color: C_EXP, values: sums.map(s => s.expense) },
          { name: "Profit", color: C_PROFIT, values: sums.map(s => s.profit) },
        ]);
      }
      const totals = series.map(s => s.reduce((a, m) => a + m.profit, 0));
      const prev = totals[totals.length - 2], cur = totals[totals.length - 1];
      const growth = prev ? Math.round(100 * (cur - prev) / Math.abs(prev)) : null;
      notesEl.innerHTML = bullets([
        `<b>${esc(proj.code)}</b> gain ${years[years.length - 1]}: <b>${fmt(cur)}</b> vs ${years[years.length - 2]}: <b>${fmt(prev)}</b>` +
          (growth != null ? ` — <b>${growth >= 0 ? "+" : ""}${growth}%</b>.` : "."),
        ...(mode === "trend3" ? [`${years[0]}: <b>${fmt(totals[0])}</b> — three-year direction is ${totals[0] <= prev && prev <= cur ? "<b>upward</b>" : "mixed"}.`] : []),
        `${state.year} includes only ${Math.round(factor * 12)} completed months.`,
      ]);
    }
  }
  $("#phProj").onchange = renderAnalysis;
  $("#phMode").onchange = renderAnalysis;
  await renderAnalysis();

  async function renderCompare() {
    const aId = $("#cmpA").value, bId = $("#cmpB").value;
    const box = $("#cmpBody");
    const A = rows.find(r => String(r.project_id) === aId), B = rows.find(r => String(r.project_id) === bId);
    if (!A || !B) { box.innerHTML = `<div class="empty">Add at least two active projects to compare.</div>`; return; }
    if (aId === bId) { box.innerHTML = `<div class="empty">Pick two different projects.</div>`; return; }
    box.innerHTML = `<div class="empty">Loading…</div>`;
    const [ma, mb] = await Promise.all([
      api(`/api/projects/${aId}/monthly?year=${state.year}`),
      api(`/api/projects/${bId}/monthly?year=${state.year}`),
    ]);
    const achA = A.health.ach || 0, achB = B.health.ach || 0;
    const metric = (label, a, b, fmtFn, higherBetter = true) => {
      const diff = a - b;
      const leader = a === b ? "—" : ((diff > 0) === higherBetter ? A.code : B.code);
      return `<tr><td>${label}</td><td class="num">${fmtFn(a)}</td><td class="num">${fmtFn(b)}</td>
        <td class="num">${diff === 0 ? "—" : (diff > 0 ? "+" : "−") + fmtFn(Math.abs(diff))}</td>
        <td><b>${leader}</b></td></tr>`;
    };
    const aWins = (A.profit > B.profit) + (A.margin_pct > B.margin_pct) + (achA > achB);
    const leader = aWins >= 2 ? A : B;
    box.innerHTML = `
      ${chartBars(["Revenue", "Expense", "Profit", "Budget Gain"], [
        { name: A.code, color: C_REV, values: [A.revenue, A.expense, A.profit, A.health.budgetProfit] },
        { name: B.code, color: C_EXP, values: [B.revenue, B.expense, B.profit, B.health.budgetProfit] },
      ])}
      <h3 class="mt">Monthly Profit — ${esc(A.code)} vs ${esc(B.code)} (${state.year})</h3>
      ${chartBars(MONTH_NAMES, [
        { name: A.code, color: C_REV, values: ma.map(m => m.profit), type: "line" },
        { name: B.code, color: C_EXP, values: mb.map(m => m.profit), type: "line" },
      ])}
      <table class="tbl mt"><thead><tr><th>Metric</th>
        <th class="num">${esc(A.code)}</th><th class="num">${esc(B.code)}</th>
        <th class="num">A − B</th><th>Leader</th></tr></thead>
      <tbody>
        ${metric("Revenue", A.revenue, B.revenue, fmt)}
        ${metric("Expense (lower wins)", A.expense, B.expense, fmt, false)}
        ${metric("Profit / Gain", A.profit, B.profit, fmt)}
        ${metric("Margin %", A.margin_pct, B.margin_pct, v => v + "%")}
        ${metric("Budget achievement %", achA, achB, v => v + "%")}
      </tbody></table>
      <p class="mt"><b>${esc(leader.code)} — ${esc(leader.name)}</b> is the stronger project overall
        (leads on ${Math.max(aWins, 3 - aWins)} of 3: profit, margin, budget achievement).
        Profit gap <b>${fmt(Math.abs(A.profit - B.profit))}</b>, margin gap
        <b>${Math.abs(A.margin_pct - B.margin_pct).toFixed(1)} pts</b>.</p>`;
  }
  if ($("#cmpA")) {
    $("#cmpA").onchange = renderCompare;
    $("#cmpB").onchange = renderCompare;
    await renderCompare();
  }
}

/* ------------------------------------------------------------------ journals */
async function pageJournals(el) {
  el.innerHTML = `
    <div class="page-head"><h2>${t("Journal Entries")}</h2>
      <div class="page-actions">
        <a class="btn" href="/api/templates/journals">&#x2913; Template</a>
        ${canWrite() ? `<button class="btn" id="importBtn">&#x2912; Import Excel</button>` : ""}
        <a class="btn" href="/api/export/journals?${scopeQS()}">&#x2913; Export Excel</a>
        ${canWrite() ? `<button class="btn btn-primary" id="newBtn">+ New Entry</button>` : ""}
      </div></div>
    <div class="card">
      <div class="filters">
        <label>Month <select id="fMonth"><option value="">All</option>
          ${MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></label>
        <label>Status <select id="fStatus"><option value="">All</option>
          <option value="posted">Posted</option><option value="draft">Draft</option></select></label>
        <label>Search <input id="fQ" placeholder="description, entry no…"></label>
        <button class="btn" id="fGo">Filter</button>
      </div>
      ${canWrite() ? `<div class="bulk-bar" id="bulkBar" hidden>
        <b id="bulkCount"></b>
        <button class="btn btn-sm" id="bulkDraft">&#9998; Make Draft</button>
        <button class="btn btn-sm btn-danger" id="bulkDelete">&#128465; Delete</button>
        <button class="btn btn-sm btn-ghost" id="bulkClear">Clear selection</button>
      </div>` : ""}
      <div id="jList"></div>
    </div>`;
  const writable = canWrite();
  const load = async () => {
    const p = new URLSearchParams({ company_id: state.companyId, year: state.year });
    if ($("#fMonth").value) p.set("month", $("#fMonth").value);
    if ($("#fStatus").value) p.set("status", $("#fStatus").value);
    if ($("#fQ").value) p.set("q", $("#fQ").value);
    const rows = await api("/api/journals?" + p);
    const cols = writable ? 7 : 6;
    $("#jList").innerHTML = `<table class="tbl"><thead><tr>
      ${writable ? `<th style="width:34px"><input type="checkbox" id="selAll" title="Select all"></th>` : ""}
      <th>Date</th><th>Entry No</th><th>Company</th><th>Description</th>
      <th class="num">Amount</th><th>Status</th></tr></thead>
      <tbody>${rows.map(j => `<tr class="clickable" data-id="${j.id}">
        ${writable ? `<td class="sel-cell"><input type="checkbox" class="row-sel" data-id="${j.id}"></td>` : ""}
        <td>${esc(j.date)}</td><td>${esc(j.entry_no)}</td><td>${esc(j.company)}</td>
        <td>${esc(j.description)} ${j.reference ? `<span class="muted">(${esc(j.reference)})</span>` : ""}</td>
        <td class="num">${fmt(j.amount)}</td>
        <td><span class="pill ${j.status}">${j.status}</span></td></tr>`).join("") ||
        `<tr><td colspan="${cols}" class="empty">No journal entries found</td></tr>`}</tbody></table>`;
    $$("#jList tr[data-id]").forEach(tr => tr.onclick = e => {
      if (e.target.closest(".sel-cell")) return;  // clicking the checkbox shouldn't open the entry
      viewJournal(tr.dataset.id, load);
    });
    if (writable) {
      const selAll = $("#selAll");
      $$("#jList .row-sel").forEach(cb => cb.onchange = updateBulk);
      if (selAll) selAll.onchange = () => { $$("#jList .row-sel").forEach(cb => cb.checked = selAll.checked); updateBulk(); };
      updateBulk();
    }
  };
  const selectedIds = () => $$("#jList .row-sel").filter(cb => cb.checked).map(cb => parseInt(cb.dataset.id, 10));
  function updateBulk() {
    const bar = $("#bulkBar");
    if (!bar) return;
    const n = selectedIds().length;
    bar.hidden = n === 0;
    if (n) $("#bulkCount").textContent = `${n} selected`;
    const sa = $("#selAll"), all = $$("#jList .row-sel");
    if (sa) sa.checked = all.length > 0 && all.every(cb => cb.checked);
  }
  async function bulkAction(action, label) {
    const ids = selectedIds();
    if (!ids.length) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} selected entr${ids.length > 1 ? "ies" : "y"}? This cannot be undone.`)) return;
    try {
      const res = await api("/api/journals/bulk", { json: { action, ids } });
      toast(`${res.done} entr${res.done === 1 ? "y" : "ies"} ${label}` + (res.errors.length ? ` — ${res.errors.length} skipped` : ""));
      if (res.errors.length) res.errors.slice(0, 4).forEach(m => toast(m, true));
      await load();
    } catch (e) { toast(e.message, true); }
  }
  if ($("#bulkDraft")) $("#bulkDraft").onclick = () => bulkAction("draft", "set to draft");
  if ($("#bulkDelete")) $("#bulkDelete").onclick = () => bulkAction("delete", "deleted");
  if ($("#bulkClear")) $("#bulkClear").onclick = () => { $$("#jList .row-sel").forEach(cb => cb.checked = false); updateBulk(); };
  $("#fGo").onclick = load;
  $("#fQ").addEventListener("keydown", e => { if (e.key === "Enter") load(); });
  if ($("#newBtn")) $("#newBtn").onclick = () => journalEditor(load);
  if ($("#importBtn")) $("#importBtn").onclick = () => importModal({
    title: "Import Journal Entries", url: "/api/import/journals", templateUrl: "/api/templates/journals",
    onDone: load,
  });
  await load();
}

async function viewJournal(id, reload) {
  const j = await api("/api/journals/" + id);
  const fields = await api("/api/custom-fields?entity=journal");
  const customRows = fields.filter(f => j.custom && j.custom[f.id] != null)
    .map(f => `<div><b>${esc(f.label)}:</b> ${esc(j.custom[f.id])}</div>`).join("");
  openModal(`
    <div class="muted">${esc(j.date)} &middot; ${esc(j.company)} &middot; ${esc(j.reference || "")}</div>
    <p>${esc(j.description)}</p>${customRows}
    <table class="tbl mt"><thead><tr><th>Account</th><th>Project</th><th>Description</th>
      <th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${j.lines.map(l => `<tr><td>${esc(l.account_code)} — ${esc(l.account_name)}</td>
        <td>${esc(l.project_code || "")}</td><td>${esc(l.description)}</td>
        <td class="num">${l.debit ? fmt(l.debit) : ""}</td><td class="num">${l.credit ? fmt(l.credit) : ""}</td></tr>`).join("")}
      <tr class="total"><td colspan="3">Total</td>
        <td class="num">${fmt(j.lines.reduce((a, l) => a + l.debit, 0))}</td>
        <td class="num">${fmt(j.lines.reduce((a, l) => a + l.credit, 0))}</td></tr></tbody></table>
    <div class="form-actions">
      ${canWrite() ? `<button class="btn" id="editBtn">&#9998; Edit Entry</button>` : ""}
      ${canWrite() && j.status === "draft" ? `<button class="btn btn-primary" id="postBtn">Post Entry</button>` : ""}
      ${canWrite() ? `<button class="btn btn-danger" id="delBtn">Delete</button>` : ""}
    </div>`, { title: `${j.entry_no} — ${j.status}` });
  if ($("#editBtn")) $("#editBtn").onclick = () => journalEditor(reload, j);
  if ($("#postBtn")) $("#postBtn").onclick = async () => {
    try { await api(`/api/journals/${id}/post`, { method: "POST" }); toast("Entry posted"); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
  if ($("#delBtn")) $("#delBtn").onclick = async () => {
    if (!confirm("Delete this entry?")) return;
    try { await api(`/api/journals/${id}`, { method: "DELETE" }); toast("Entry deleted"); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
}

async function journalEditor(reload, existing) {
  const cid = existing ? existing.company_id
    : (state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10));
  const fields = await api("/api/custom-fields?entity=journal");
  const root = openModal(`
    <div class="form-grid">
      <label>Company <select id="jeCompany" ${existing ? "disabled" : ""}>${companyOptions(cid)}</select></label>
      <label>Date <input type="date" id="jeDate" value="${existing ? esc(existing.date) : new Date().toISOString().slice(0, 10)}"></label>
      <label class="full">Description <input id="jeDesc" value="${existing ? esc(existing.description) : ""}" placeholder="What is this entry for?"></label>
      <label>Reference <input id="jeRef" value="${existing ? esc(existing.reference) : ""}" placeholder="invoice no, contract…"></label>
      ${fields.map(f => customFieldInput(f, existing && existing.custom ? existing.custom[f.id] || "" : "")).join("")}
    </div>
    <table class="tbl je-lines mt"><thead><tr><th style="width:30%">Account</th><th style="width:18%">Project</th>
      <th>Line description</th><th class="amt">Debit</th><th class="amt">Credit</th><th></th></tr></thead>
      <tbody id="jeLines"></tbody></table>
    <button class="btn btn-sm mt" id="addLine">+ Add line</button>
    <div class="je-balance" id="jeBalance"></div>
    <div class="form-actions">
      ${existing ? `<button class="btn btn-primary" id="saveEdit">Save Changes (stays ${existing.status})</button>`
        : `<button class="btn" id="saveDraft">Save as Draft</button>
           <button class="btn btn-primary" id="savePost">Save &amp; Post</button>`}
    </div>`, { title: existing ? `Edit ${existing.entry_no}` : "New Journal Entry" });

  let accounts = [], projects = [];
  async function loadCompanyData() {
    const c = $("#jeCompany").value;
    [accounts, projects] = await Promise.all([
      api("/api/accounts?company_id=" + c),
      api("/api/projects?company_id=" + c),
    ]);
    accounts = accounts.filter(a => a.is_active);
    $$("#jeLines tr").forEach(refreshLineSelects);
  }
  function accountOpts(sel) {
    return `<option value="">—</option>` + accounts.map(a =>
      `<option value="${a.id}" ${String(sel) === String(a.id) ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("");
  }
  function projectOpts(sel) {
    return `<option value="">—</option>` + projects.map(p =>
      `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.code)}</option>`).join("");
  }
  function refreshLineSelects(tr) {
    $(".je-acc", tr).innerHTML = accountOpts($(".je-acc", tr).value);
    $(".je-prj", tr).innerHTML = projectOpts($(".je-prj", tr).value);
  }
  function addLine(line) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><select class="je-acc">${accountOpts(line ? line.account_id : "")}</select></td>
      <td><select class="je-prj">${projectOpts(line ? line.project_id : "")}</select></td>
      <td><input class="je-ldesc" value="${line ? esc(line.description) : ""}"></td>
      <td><input class="je-debit amt" type="number" min="0" step="any" placeholder="0" value="${line && line.debit ? line.debit : ""}"></td>
      <td><input class="je-credit amt" type="number" min="0" step="any" placeholder="0" value="${line && line.credit ? line.credit : ""}"></td>
      <td><button class="btn btn-sm btn-ghost je-del">&times;</button></td>`;
    $("#jeLines").appendChild(tr);
    $(".je-del", tr).onclick = () => { tr.remove(); updateBalance(); };
    $$("input", tr).forEach(i => i.addEventListener("input", updateBalance));
  }
  function updateBalance() {
    let d = 0, c = 0;
    $$("#jeLines tr").forEach(tr => {
      d += parseFloat($(".je-debit", tr).value) || 0;
      c += parseFloat($(".je-credit", tr).value) || 0;
    });
    const bal = $("#jeBalance");
    const ok = Math.abs(d - c) < 0.01 && d > 0;
    bal.className = "je-balance " + (ok ? "ok" : "bad");
    bal.textContent = `Debit ${fmt(d)}  vs  Credit ${fmt(c)}` + (ok ? " ✓ balanced" : ` (diff ${fmt(d - c)})`);
  }
  async function save(status) {
    const lines = $$("#jeLines tr").map(tr => ({
      account_id: parseInt($(".je-acc", tr).value, 10) || null,
      project_id: parseInt($(".je-prj", tr).value, 10) || null,
      description: $(".je-ldesc", tr).value,
      debit: parseFloat($(".je-debit", tr).value) || 0,
      credit: parseFloat($(".je-credit", tr).value) || 0,
    })).filter(l => l.account_id && (l.debit || l.credit));
    const custom = {};
    fields.forEach(f => { const inp = $("#cf_" + f.id, root); if (inp && inp.value) custom[f.id] = inp.value; });
    const payload = {
      company_id: parseInt($("#jeCompany").value, 10),
      date: $("#jeDate").value, description: $("#jeDesc").value,
      reference: $("#jeRef").value, status, lines, custom,
    };
    try {
      if (existing) {
        await api("/api/journals/" + existing.id, { method: "PUT", json: payload });
        toast(`Entry ${existing.entry_no} updated`);
      } else {
        const res = await api("/api/journals", { json: payload });
        toast(`Entry ${res.entry_no} saved (${status})`);
      }
      closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  }
  $("#addLine").onclick = () => addLine();
  $("#jeCompany").onchange = loadCompanyData;
  if (existing) $("#saveEdit").onclick = () => save(existing.status);
  else { $("#saveDraft").onclick = () => save("draft"); $("#savePost").onclick = () => save("posted"); }
  await loadCompanyData();
  if (existing) existing.lines.forEach(l => addLine(l));
  else { addLine(); addLine(); }
  updateBalance();
}

function customFieldInput(f, value) {
  const id = "cf_" + f.id;
  let input;
  if (f.field_type === "select") {
    input = `<select id="${id}"><option value="">—</option>` + f.options.split(",").filter(Boolean)
      .map(o => `<option ${o.trim() === value ? "selected" : ""}>${esc(o.trim())}</option>`).join("") + "</select>";
  } else {
    const t = f.field_type === "number" ? "number" : f.field_type === "date" ? "date" : "text";
    input = `<input id="${id}" type="${t}" value="${esc(value)}">`;
  }
  return `<label>${esc(f.label)} <span class="muted" style="font-weight:400">(custom)</span>${input}</label>`;
}

/* ------------------------------------------------------------------ bank import */
// which entry source each bank-import mode books under
const BANK_SOURCE_BY_MODE = { paste: "bca_bank", csv: "bca_csv", pdf: "bca_pdf", wallet: "monit_wallet" };

async function pageBank(el) {
  if (!canWrite()) {
    el.innerHTML = `<div class="card"><div class="empty">Bank import requires the Admin or Accountant role.</div></div>`;
    return;
  }
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Bank Import — BCA")}</h2>
      <div class="page-actions"><label class="muted">Company <select id="bkCompany">${companyOptions(cid)}</select></label></div>
    </div>
    <div class="card">
      <h3>1. Choose import method</h3>
      <div class="tabs" id="bkModes" style="margin-bottom:12px">
        <button data-m="paste" class="active">Paste receipt(s)</button>
        <button data-m="csv">CSV file — mutasi rekening</button>
        <button data-m="pdf">PDF e-statement (BCA)</button>
        <button data-m="wallet">Wallet / Card Excel (petty cash)</button>
      </div>
      <div id="bkPasteBox">
        <p class="muted" style="margin-top:-2px">Copy one or more transfer confirmations from KlikBCA / myBCA and paste them below.
        The amount is read from <b>Jumlah Transfer</b> or <b>Nominal</b> (same thing), and each transfer is identified by its
        <b>No Referensi</b> (reference number). Multiple receipts in one paste are fine — each new “Tanggal” starts a new transaction.</p>
        <textarea id="bkText" rows="9" style="width:100%;font-family:Consolas,monospace;font-size:12.5px"
          placeholder="Tanggal&#9;:&#9;11/06/2026&#10;Jam&#9;:&#9;10:14:01&#10;Jenis Transaksi&#9;:&#9;TRANSFER KE BCA VIRTUAL ACCOUNT&#10;…&#10;Jumlah Transfer&#9;:&#9;Rp 1,970,100.00&#10;No Referensi&#9;:&#9;26061104327247&#10;Status&#9;:&#9;Berhasil"></textarea>
        <div class="form-actions" style="justify-content:flex-start">
          <button class="btn btn-primary" id="bkParse">Parse receipts</button>
          <span class="muted" id="bkParseInfo"></span>
        </div>
      </div>
      <div id="bkCsvBox" hidden>
        <p class="muted" style="margin-top:-2px">Upload the <b>CSV file exported from the bank</b> (BCA “Informasi Rekening — Mutasi Rekening”:
        Tanggal Transaksi, Keterangan, Cabang, Jumlah CR/DB, Saldo). Money <b>in (CR)</b> is booked as debit bank / credit the account you choose;
        money <b>out (DB)</b> as debit the account / credit bank. Re-uploading the same file is safe — already-booked rows are flagged as duplicates.</p>
        <div class="filters">
          <label>CSV file <input type="file" id="bkCsvFile" accept=".csv,.txt"></label>
          <button class="btn btn-primary" id="bkCsvParse">Upload &amp; parse</button>
          <span class="muted" id="bkCsvInfo"></span>
        </div>
      </div>
      <div id="bkPdfBox" hidden>
        <p class="muted" style="margin-top:-2px">Upload the <b>BCA e-statement PDF</b> (REKENING GIRO / Laporan Mutasi Rekening — the monthly
        e-statement). Every transaction row is read with its date, amount and CR/DB direction; the year comes from the statement’s PERIODE.
        Then assign each row to an account below, exactly like the other modes. Already-booked rows are flagged as duplicates on re-upload.</p>
        <div class="filters">
          <label>PDF file <input type="file" id="bkPdfFile" accept=".pdf"></label>
          <button class="btn btn-primary" id="bkPdfParse">Upload &amp; parse</button>
          <span class="muted" id="bkPdfInfo"></span>
        </div>
      </div>
      <div id="bkWalletBox" hidden>
        <p class="muted" style="margin-top:-2px">Upload the <b>wallet / card transaction Excel</b> (Transaction Type, Reference ID, Amount,
        Category, Description…). Spending (negative amounts) is <b>deducted from the Petty Cash account</b> you pick below —
        credit Petty Cash, debit the cost account (suggested from the Category). Internal top-ups / transfers between your own
        wallets are detected and left <b>unticked</b>. Re-uploading the same file is safe — booked rows (by Reference ID) are flagged duplicates.</p>
        <div class="filters">
          <label>Excel file <input type="file" id="bkWalletFile" accept=".xlsx,.xlsm"></label>
          <button class="btn btn-primary" id="bkWalletParse">Upload &amp; parse</button>
          <span class="muted" id="bkWalletInfo"></span>
        </div>
      </div>
    </div>
    <div class="card mt" id="bkStage2" hidden>
      <h3>2. Assign accounts &amp; book entries</h3>
      <p class="muted" style="margin-top:-6px">Each transfer is booked as: <b>debit</b> the account you choose below (cost/expense by default) and <b>credit</b> the bank account. Duplicates (same No Referensi already booked) are unticked automatically.</p>
      <div class="filters">
        <label id="bkBankLabel">Cash / Bank account (the cash side) <select id="bkBank" style="min-width:240px"></select></label>
        <label>Book as <select id="bkStatus"><option value="draft">Draft</option><option value="posted" selected>Posted</option></select></label>
      </div>
      <div style="overflow-x:auto"><table class="tbl" id="bkTable"></table></div>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="btn btn-primary" id="bkBook">Book selected transfers</button>
        <span class="muted" id="bkBookInfo"></span>
      </div>
      <div id="bkResults" class="mt"></div>
    </div>`;

  let txs = [], accounts = [], projects = [], mode = "paste";

  async function loadCompanyData() {
    [accounts, projects] = await Promise.all([
      api("/api/accounts?company_id=" + $("#bkCompany").value),
      api("/api/projects?company_id=" + $("#bkCompany").value),
    ]);
    accounts = accounts.filter(a => a.is_active);
    const banks = accounts.filter(a => a.type === "asset" && a.code.startsWith("11"));
    const cashDefault = mode === "wallet" ? "1130" : "1120";  // wallet -> Petty Cash Monit
    $("#bkBank").innerHTML = banks.map(a =>
      `<option value="${a.id}" ${a.code === cashDefault ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("");
  }

  function debitOptions(sel, direction) {
    const grp = (label, list) => list.length
      ? `<optgroup label="${label}">` + list.map(a =>
          `<option value="${a.id}" ${String(sel) === String(a.id) ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("") + "</optgroup>"
      : "";
    const exp = grp("Costs / Expenses", accounts.filter(a => a.type === "expense"));
    const rev = grp("Revenue", accounts.filter(a => a.type === "revenue"));
    return `<option value="">— choose account —</option>`
      + (direction === "in" ? rev + exp : exp + rev)
      + grp("Assets", accounts.filter(a => a.type === "asset" && !a.code.startsWith("11")))
      + grp("Liabilities", accounts.filter(a => a.type === "liability"));
  }
  function projectOpts(sel) {
    return `<option value="">—</option>` + projects.map(p =>
      `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.code)}</option>`).join("");
  }

  const balanceCell = t => {
    if (t.balance == null) return '<span class="muted">—</span>';
    const tag = {
      ok: '<span class="pill posted" title="Running balance matches this amount — direction confirmed">&#10003; saldo</span>',
      mismatch: '<span class="pill bad" title="Running balance does not match the amount — a row may be missing or the amount is off">&#9888; gap</span>',
      start: '<span class="muted" title="First row — no earlier balance to check against">opening row</span>',
    }[t.balance_check] || "";
    return `<b>${fmt(t.balance)}</b>${tag ? "<br>" + tag : ""}`;
  };
  function renderTable() {
    $("#bkTable").innerHTML = `<thead><tr><th></th><th>Date</th><th>In/Out</th><th style="min-width:240px">Description</th>
      <th class="num">Amount<br><span style="font-weight:400;text-transform:none">(Jumlah / Nominal)</span></th>
      <th class="num">Balance<br><span style="font-weight:400;text-transform:none">(Saldo — after txn)</span></th>
      <th>No Referensi<br><span style="font-weight:400;text-transform:none">(Reference Number)</span></th><th>Status</th>
      <th style="min-width:230px">Contra account<br><span style="font-weight:400;text-transform:none">(cost for OUT / revenue for IN)</span></th><th>Project</th></tr></thead>
      <tbody>${txs.map((t, i) => `<tr data-i="${i}" ${t.duplicate || t.internal ? 'style="opacity:.55"' : ""}>
        <td><input type="checkbox" class="bk-sel" ${t.ok && !t.duplicate && !t.internal && t.amount && t.date ? "checked" : ""}></td>
        <td>${esc(t.date || "?")}<br><span class="muted">${esc(t.time)}</span></td>
        <td><span class="pill ${t.direction === "in" ? "posted" : "draft"}">${t.direction === "in" ? "IN" : "OUT"}</span></td>
        <td><textarea class="bk-desc" rows="2" style="width:100%;min-width:240px;resize:vertical;font-family:inherit;font-size:12.5px">${esc(t.description)}</textarea>
          ${t.va_number ? `<span class="muted">VA ${esc(t.va_number)}</span>` : ""}
          ${t.category ? `<span class="muted">${esc(t.category.toLowerCase().replace(/_/g, " "))}</span>` : ""}</td>
        <td class="num"><b>${fmt(t.amount)}</b></td>
        <td class="num">${balanceCell(t)}</td>
        <td><b style="font-size:12px">${esc(t.reference || "—")}</b></td>
        <td><span class="pill ${t.ok ? "posted" : "draft"}">${esc(t.status || "?")}</span>
          ${t.duplicate ? '<br><span class="pill inactive">already booked</span>' : ""}
          ${t.internal ? '<br><span class="pill inactive">internal</span>' : ""}</td>
        <td><select class="bk-acc">${debitOptions(t.suggested_account_id || "", t.direction)}</select></td>
        <td><select class="bk-prj">${projectOpts("")}</select></td>
      </tr>`).join("")}</tbody>`;
  }

  $("#bkCompany").onchange = async () => { await loadCompanyData(); if (txs.length) renderTable(); };
  $$("#bkModes button").forEach(b => b.onclick = () => {
    $$("#bkModes button").forEach(x => x.classList.toggle("active", x === b));
    mode = b.dataset.m;
    $("#bkPasteBox").hidden = mode !== "paste";
    $("#bkCsvBox").hidden = mode !== "csv";
    $("#bkPdfBox").hidden = mode !== "pdf";
    $("#bkWalletBox").hidden = mode !== "wallet";
    // default the cash side: Petty Cash Monit for wallet, Bank for the rest
    const wantCode = mode === "wallet" ? "1130" : "1120";
    const opt = Array.from($("#bkBank").options).find(o => o.textContent.trim().startsWith(wantCode));
    if (opt) $("#bkBank").value = opt.value;
    $("#bkBankLabel").firstChild.textContent = mode === "wallet"
      ? "Petty Cash account (deducted from this) " : "Cash / Bank account (the cash side) ";
  });
  const showParsed = (res, infoEl) => {
    txs = res.transactions;
    const dups = txs.filter(t => t.duplicate).length;
    infoEl.textContent = `${txs.length} transaction(s) found` +
      (dups ? ` (${dups} already booked)` : "") +
      (res.meta && res.meta["no. rekening"] ? ` — account ${res.meta["no. rekening"]} ${res.meta["nama"] || ""} ${res.meta["periode"] || ""}` : "") +
      (res.warnings.length ? ` — ${res.warnings.length} warning(s): ${res.warnings.join("; ")}` : "");
    $("#bkStage2").hidden = txs.length === 0;
    $("#bkResults").innerHTML = "";
    renderTable();
  };
  $("#bkParse").onclick = async () => {
    const text = $("#bkText").value.trim();
    if (!text) { toast("Paste at least one receipt first", true); return; }
    try {
      const res = await api("/api/bank/parse-bca", { json: { company_id: parseInt($("#bkCompany").value, 10), text } });
      showParsed(res, $("#bkParseInfo"));
    } catch (e) { toast(e.message, true); }
  };
  const uploadParse = async (fileEl, url, infoEl) => {
    const f = fileEl.files[0];
    if (!f) { toast("Choose the file first", true); return; }
    const fd = new FormData();
    fd.append("company_id", $("#bkCompany").value);
    fd.append("file", f);
    infoEl.textContent = "Parsing…";
    try {
      const res = await api(url, { method: "POST", body: fd });
      showParsed(res, infoEl);
    } catch (e) { infoEl.textContent = ""; toast(e.message, true); }
  };
  $("#bkCsvParse").onclick = () => uploadParse($("#bkCsvFile"), "/api/bank/parse-csv", $("#bkCsvInfo"));
  $("#bkPdfParse").onclick = () => uploadParse($("#bkPdfFile"), "/api/bank/parse-pdf", $("#bkPdfInfo"));
  $("#bkWalletParse").onclick = () => uploadParse($("#bkWalletFile"), "/api/bank/parse-wallet", $("#bkWalletInfo"));
  $("#bkBook").onclick = async () => {
    const bankAcc = parseInt($("#bkBank").value, 10);
    const status = $("#bkStatus").value;
    const rows = $$("#bkTable tbody tr").filter(tr => $(".bk-sel", tr).checked);
    if (!rows.length) { toast("No transfers selected", true); return; }
    const missing = rows.filter(tr => !$(".bk-acc", tr).value);
    if (missing.length) { toast(`${missing.length} selected transfer(s) have no debit account chosen`, true); return; }
    $("#bkBook").disabled = true;
    let okCount = 0; const results = [];
    for (const tr of rows) {
      const t = txs[tr.dataset.i];
      const contra = {
        account_id: parseInt($(".bk-acc", tr).value, 10),
        project_id: parseInt($(".bk-prj", tr).value, 10) || null,
        description: t.tx_type || "transaction",
      };
      const bankLine = { account_id: bankAcc, description: (mode === "wallet" ? "Petty cash — ref " : "Bank — ref ") + t.reference };
      const lines = t.direction === "in"
        ? [Object.assign({}, bankLine, { debit: t.amount, credit: 0 }),
           Object.assign({}, contra, { debit: 0, credit: t.amount })]
        : [Object.assign({}, contra, { debit: t.amount, credit: 0 }),
           Object.assign({}, bankLine, { debit: 0, credit: t.amount })];
      try {
        const res = await api("/api/journals", { json: {
          company_id: parseInt($("#bkCompany").value, 10),
          date: t.date, description: $(".bk-desc", tr).value,
          reference: t.reference, status, lines,
          source: BANK_SOURCE_BY_MODE[mode] || "bca_bank",
        }});
        okCount++;
        results.push(`<li class="pos">✓ ${esc(t.reference || t.date)} — booked as <b>${esc(res.entry_no)}</b> (${status})</li>`);
        $(".bk-sel", tr).checked = false;
        tr.style.opacity = ".5";
      } catch (e) {
        results.push(`<li class="neg">✗ ${esc(t.reference || t.date)} — ${esc(e.message)}</li>`);
      }
    }
    $("#bkBook").disabled = false;
    $("#bkBookInfo").textContent = `${okCount}/${rows.length} booked`;
    $("#bkResults").innerHTML = `<ul style="margin:0;padding-left:18px">${results.join("")}</ul>`;
    if (okCount) toast(`${okCount} bank transfer(s) booked`);
  };
  await loadCompanyData();
}

/* ------------------------------------------------------------ receivables (AR aging) */
async function pageReceivables(el) {
  const today = new Date().toISOString().slice(0, 10);
  if (!state.arAsOf) state.arAsOf = today;
  const cid = state.companyId === "all" ? "all" : parseInt(state.companyId, 10);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Receivables")} — ${t("AR Aging (Piutang)")}</h2>
      <div class="page-actions">
        <label class="muted">${t("Company")} <select id="arCompany">${companyOptions(cid, { includeAll: true })}</select></label>
        <label class="muted">${t("As of")} <input type="date" id="arAsOf" value="${state.arAsOf}"></label>
        <a class="btn btn-sm" id="arExp">&#x2913; ${t("Export Excel")}</a>
        ${canWrite() ? `<button class="btn btn-sm btn-primary" id="arNew">+ ${t("Add Invoice")}</button>` : ""}
      </div></div>
    <div id="arBody"><div class="empty">Loading…</div></div>`;
  const scopeFor = () => $("#arCompany").value;
  const load = async () => {
    state.arAsOf = $("#arAsOf").value || today;
    const qs = `company_id=${scopeFor()}&as_of=${state.arAsOf}`;
    $("#arExp").href = `/api/export/receivables?${qs}`;
    const d = await api(`/api/receivables?${qs}`);
    $("#scopeBadge").textContent = d.scope;
    const consol = scopeFor() === "all";
    const bcell = (it, b) => it.bucket === b ? `<b>${fmt(it.outstanding)}</b>` : `<span class="muted">-</span>`;
    const rows = d.items.map((it, i) => `<tr>
      <td>${i + 1}</td>
      ${consol ? `<td>${esc(it.company_code)}</td>` : ""}
      <td><b>${esc(it.client)}</b></td>
      <td>${esc(it.invoice_no)}</td>
      <td class="muted">${esc(it.invoice_date || "")}</td>
      <td>${esc(it.due_date || "")}</td>
      <td class="num">${fmt(it.amount)}</td>
      <td class="num">${fmt(it.outstanding)}</td>
      <td class="num">${bcell(it, "not_due")}</td>
      <td class="num">${bcell(it, "d1_30")}</td>
      <td class="num">${bcell(it, "d31_60")}</td>
      <td class="num">${bcell(it, "d61_90")}</td>
      <td class="num ${it.bucket === "d90" ? "neg" : ""}">${bcell(it, "d90")}</td>
      <td class="num">${it.days_overdue == null ? "-" : it.days_overdue}</td>
      <td><span class="pill ${AR_STATUS_PILL[it.status] || "inactive"}">${esc(t(it.status_label))}</span></td>
      ${canWrite() ? `<td><button class="btn btn-sm" data-edit="${it.id}">Edit</button></td>` : ""}
    </tr>`).join("") || `<tr><td colspan="${14 + (consol ? 1 : 0) + (canWrite() ? 1 : 0)}" class="empty">No invoices yet — add one to start tracking AR aging.</td></tr>`;
    const totalRow = `<tr class="total"><td colspan="${consol ? 7 : 6}">${t("TOTAL")}</td>
      <td class="num">${fmt(d.total_outstanding)}</td>
      <td class="num">${fmt(d.buckets.not_due)}</td><td class="num">${fmt(d.buckets.d1_30)}</td>
      <td class="num">${fmt(d.buckets.d31_60)}</td><td class="num">${fmt(d.buckets.d61_90)}</td>
      <td class="num">${fmt(d.buckets.d90)}</td><td colspan="${canWrite() ? 3 : 2}"></td></tr>`;
    $("#arBody").innerHTML = `
      <div class="card"><div style="overflow-x:auto"><table class="tbl ar-tbl">
        <thead><tr><th>No</th>${consol ? "<th>Co.</th>" : ""}<th>${t("Client")}</th><th>${t("Invoice")}</th>
          <th>${t("Invoice Date")}</th><th>${t("Due Date")}</th><th class="num">${t("Amount")}</th><th class="num">${t("Outstanding")}</th>
          <th class="num">${t("Not Due")}</th><th class="num">1–30</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">&gt;90</th>
          <th class="num">${t("Days Late")}</th><th>${t("Status")}</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}${totalRow}</tbody></table></div>
        <p class="muted mt">Outstanding = Amount − Paid. Status &amp; aging are computed from the As-of date vs each Due Date.</p>
      </div>
      <div class="grid two-col mt">
        <div class="card"><h3>${t("Aging Summary")}</h3>
          <table class="tbl"><thead><tr><th>${t("Bucket")}</th><th class="num">${t("Amount")}</th><th class="num">%</th><th style="width:34%"></th></tr></thead>
            <tbody>${d.summary.map(s => `<tr>
              <td>${esc(t(s.label))}</td><td class="num">${fmt(s.amount)}</td><td class="num">${s.pct}%</td>
              <td><div class="bar"><span style="width:${Math.min(100, s.pct)}%;background:${AR_BUCKET_COLOR[s.bucket]}"></span></div></td></tr>`).join("")}
              <tr class="total"><td>${t("TOTAL OUTSTANDING")}</td><td class="num">${fmt(d.total_outstanding)}</td><td colspan="2"></td></tr>
            </tbody></table>
        </div>
        <div class="card"><h3>${t("Risk")}</h3>
          <div class="grid kpis">
            <div class="kpi"><div class="kpi-label">${t("Total Outstanding")}</div><div class="kpi-value">${fmtShortRp(d.total_outstanding)}</div></div>
            <div class="kpi ${d.risky > 0 ? "red" : ""}"><div class="kpi-label">${t("Risky AR (> 90 days)")}</div><div class="kpi-value">${fmtShortRp(d.risky)}</div>
              <div class="kpi-sub">${d.total_outstanding ? Math.round(100 * d.risky / d.total_outstanding) : 0}% of outstanding</div></div>
          </div>
          <p class="muted mt">Enter only the invoice fields (client, invoice, dates, amount, paid) — buckets, days late and status are computed, just like your Excel Piutang sheet.</p>
        </div>
      </div>`;
    $$("#arBody [data-edit]").forEach(b => b.onclick = () => receivableEditor(d.items.find(x => x.id == b.dataset.edit), load));
  };
  $("#arCompany").onchange = load;
  $("#arAsOf").onchange = load;
  if ($("#arNew")) $("#arNew").onclick = () => receivableEditor(null, load);
  await load();
}

function receivableEditor(r, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const newCompany = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  openModal(`<div class="form-grid">
    ${r ? "" : `<label class="full">Company <select id="rvCompany">${companyOptions(newCompany)}</select></label>`}
    <label class="full">Client <input id="rvClient" value="${esc(r ? r.client : "")}" placeholder="e.g. PT Andalan Niaga"></label>
    <label>Invoice No <input id="rvInv" value="${esc(r ? r.invoice_no : "")}" placeholder="INV-2026-051"></label>
    <label>Invoice Date <input type="date" id="rvIdate" value="${esc(r ? (r.invoice_date || "") : today)}"></label>
    <label>Due Date <input type="date" id="rvDue" value="${esc(r ? (r.due_date || "") : "")}"></label>
    <label>Amount (Rp) <input id="rvAmount" inputmode="numeric" value="${r ? fmt(r.amount) : ""}"></label>
    <label>Paid / Received (Rp) <input id="rvPaid" inputmode="numeric" value="${r ? fmt(r.paid) : "0"}"></label>
    <label class="full">Notes <input id="rvNotes" value="${esc(r ? r.notes : "")}"></label>
    </div><div class="form-actions">
      ${r ? `<button class="btn btn-danger" id="rvDel">Delete</button>` : ""}
      <button class="btn btn-primary" id="rvSave">Save invoice</button></div>`,
    { title: r ? "Edit receivable" : "New receivable", small: true });
  const numv = id => parseInt(($("#" + id).value || "0").replace(/[^\d-]/g, ""), 10) || 0;
  $("#rvSave").onclick = async () => {
    const body = {
      client: $("#rvClient").value, invoice_no: $("#rvInv").value,
      invoice_date: $("#rvIdate").value || null, due_date: $("#rvDue").value || null,
      amount: numv("rvAmount"), paid: numv("rvPaid"), notes: $("#rvNotes").value,
    };
    try {
      if (r) await api("/api/receivables/" + r.id, { method: "PUT", json: body });
      else await api("/api/receivables", { json: Object.assign(body, { company_id: parseInt($("#rvCompany").value, 10) }) });
      toast("Receivable saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#rvDel")) $("#rvDel").onclick = async () => {
    if (!confirm("Delete this invoice from AR aging?")) return;
    try { await api("/api/receivables/" + r.id, { method: "DELETE" }); toast("Deleted"); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ investments */
async function pageInvestments(el) {
  const rows = await api(`/api/investments?company_id=${state.companyId}`);
  const committed = rows.reduce((a, r) => a + r.committed_amount, 0);
  const invested = rows.reduce((a, r) => a + r.invested, 0);
  const benefit = rows.reduce((a, r) => a + r.benefit, 0);
  const roi = invested ? Math.round(100 * (benefit - invested) / invested) : null;

  el.innerHTML = `
    <div class="page-head"><h2>${t("Investment Analysis")}</h2>
      <div class="page-actions">
        ${canWrite() ? `<button class="btn btn-primary" id="invNew">+ New Investment</button>` : ""}
      </div></div>
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">Initiatives</div><div class="kpi-value">${rows.length}</div>
        <div class="kpi-sub">${rows.filter(r => r.status === "active").length} active</div></div>
      <div class="kpi"><div class="kpi-label">Committed</div><div class="kpi-value">${fmtShort(committed)}</div></div>
      <div class="kpi"><div class="kpi-label">Invested To Date</div><div class="kpi-value">${fmtShort(invested)}</div>
        <div class="kpi-sub">${committed ? Math.round(100 * invested / committed) + "% of commitment" : ""}</div></div>
      <div class="kpi"><div class="kpi-label">Benefits Realized</div><div class="kpi-value">${fmtShort(benefit)}</div></div>
      <div class="kpi ${benefit - invested >= 0 ? "green" : "red"}"><div class="kpi-label">Net / ROI</div>
        <div class="kpi-value">${fmtShort(benefit - invested)}</div>
        <div class="kpi-sub">${roi == null ? "" : "ROI " + roi + "%"}</div></div>
    </div>
    <div class="card"><h3>Long-horizon initiatives <span class="muted">(scholarships, partnerships, R&D — investments that mature into projects)</span></h3>
      <table class="tbl"><thead><tr><th>Initiative</th><th>Category</th><th>Company</th><th>Linked project</th>
        <th class="num">Committed</th><th class="num">Invested</th><th>Progress</th>
        <th class="num">Benefits</th><th class="num">Payback</th><th>Status</th><th style="min-width:170px"></th></tr></thead>
      <tbody>${rows.map(r => {
        const prog = r.committed_amount ? Math.min(100, Math.round(100 * r.invested / r.committed_amount)) : 0;
        const payback = r.invested ? Math.round(100 * r.benefit / r.invested) : null;
        return `<tr>
          <td><b>${esc(r.name)}</b><br><span class="muted">${esc((r.description || "").slice(0, 70))}${(r.description || "").length > 70 ? "…" : ""}</span></td>
          <td>${INV_CATEGORIES[r.category] || r.category}</td>
          <td>${esc(r.company_code)}</td><td>${esc(r.project_code || "—")}</td>
          <td class="num">${fmt(r.committed_amount)}</td><td class="num">${fmt(r.invested)}</td>
          <td><div class="bar" title="${prog}% of committed amount used"><span style="width:${prog}%"></span></div></td>
          <td class="num">${fmt(r.benefit)}</td>
          <td class="num ${payback != null && payback >= 100 ? "pos" : ""}">${payback == null ? "-" : payback + "%"}</td>
          <td><span class="pill ${r.status}">${r.status.replace("_", " ")}</span></td>
          <td>
            <button class="btn btn-sm" data-view="${r.id}">Detail</button>
            ${canWrite() ? `<button class="btn btn-sm" data-entry="${r.id}">+ Entry</button>
            <button class="btn btn-sm" data-edit="${r.id}">Edit</button>` : ""}
          </td></tr>`;
      }).join("") || `<tr><td colspan="11" class="empty">No investments yet — add the first initiative</td></tr>`}</tbody></table>
      <p class="muted mt"><b>Outflow</b> = money put in (e.g. scholarship paid out) · <b>Benefit</b> = value gained back
      (event talks converting to engagements, projects won via the program). Payback = benefits ÷ invested.</p>
    </div>`;

  const reload = () => pageInvestments(el);
  if ($("#invNew")) $("#invNew").onclick = () => investmentEditor(null, reload);
  $$("#content [data-view]").forEach(b => b.onclick = () => investmentDetail(b.dataset.view, reload));
  $$("#content [data-edit]").forEach(b => b.onclick = async () => {
    const inv = await api("/api/investments/" + b.dataset.edit);
    investmentEditor(inv, reload);
  });
  $$("#content [data-entry]").forEach(b => b.onclick = () => investmentEntryModal(b.dataset.entry, reload));
}

async function investmentEditor(inv, reload) {
  const cid = inv ? inv.company_id : (state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10));
  const projects = await api("/api/projects?company_id=all");
  openModal(`
    <div class="form-grid">
      <label class="full">Name <input id="ivName" value="${esc(inv ? inv.name : "")}" placeholder="e.g. Scholarship Program — Future Leaders"></label>
      <label>Company <select id="ivCompany" ${inv ? "disabled" : ""}>${companyOptions(cid)}</select></label>
      <label>Category <select id="ivCat">${Object.entries(INV_CATEGORIES).map(([k, v]) =>
        `<option value="${k}" ${inv && inv.category === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Status <select id="ivStatus">${["active", "completed", "on_hold"].map(s =>
        `<option ${inv && inv.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Start date <input type="date" id="ivStart" value="${esc(inv ? inv.start_date || "" : "")}"></label>
      <label>Horizon (years) <input type="number" id="ivHorizon" min="1" max="30" value="${inv ? inv.horizon_years : 3}"></label>
      <label>Committed amount (IDR) <input type="number" id="ivCommitted" step="any" value="${inv ? inv.committed_amount : ""}"></label>
      <label class="full">Linked project <select id="ivProject"><option value="">— none —</option>
        ${projects.map(p => `<option value="${p.id}" ${inv && inv.linked_project_id === p.id ? "selected" : ""}>${esc(p.company_code)} / ${esc(p.code)} ${esc(p.name)}</option>`).join("")}</select></label>
      <label class="full">Description <textarea id="ivDesc" rows="3">${esc(inv ? inv.description : "")}</textarea></label>
    </div>
    <div class="form-actions">
      ${inv && isAdmin() ? `<button class="btn btn-danger" id="ivDel">Delete</button>` : ""}
      <button class="btn btn-primary" id="ivSave">Save Investment</button></div>`,
    { title: inv ? "Edit Investment" : "New Investment" });
  $("#ivSave").onclick = async () => {
    const body = {
      company_id: parseInt($("#ivCompany").value, 10), name: $("#ivName").value,
      category: $("#ivCat").value, status: $("#ivStatus").value,
      start_date: $("#ivStart").value, horizon_years: parseInt($("#ivHorizon").value, 10) || 3,
      committed_amount: parseFloat($("#ivCommitted").value) || 0,
      linked_project_id: parseInt($("#ivProject").value, 10) || null,
      description: $("#ivDesc").value,
    };
    try {
      if (inv) await api("/api/investments/" + inv.id, { method: "PUT", json: body });
      else await api("/api/investments", { json: body });
      toast("Investment saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#ivDel")) $("#ivDel").onclick = async () => {
    if (!confirm("Delete this investment and all its entries?")) return;
    try { await api("/api/investments/" + inv.id, { method: "DELETE" }); toast("Investment deleted"); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
}

function investmentEntryModal(iid, reload) {
  openModal(`
    <div class="form-grid">
      <label>Type <select id="ieKind">
        <option value="outflow">Outflow — money invested</option>
        <option value="benefit">Benefit — value gained</option></select></label>
      <label>Date <input type="date" id="ieDate" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="full">Description <input id="ieDesc" placeholder="e.g. Scholarship batch 4 / Event talk converted to project"></label>
      <label>Amount (IDR) <input type="number" id="ieAmount" step="any" min="0"></label>
    </div>
    <div class="form-actions"><button class="btn btn-primary" id="ieSave">Add Entry</button></div>`,
    { title: "New Investment Entry", small: true });
  $("#ieSave").onclick = async () => {
    try {
      await api(`/api/investments/${iid}/events`, { json: {
        kind: $("#ieKind").value, date: $("#ieDate").value,
        description: $("#ieDesc").value, amount: parseFloat($("#ieAmount").value) || 0,
      }});
      toast("Entry added"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
}

async function investmentDetail(iid, reload) {
  const inv = await api("/api/investments/" + iid);
  const payback = inv.invested ? Math.round(100 * inv.benefit / inv.invested) : null;
  const analysis = payback == null
    ? "No outflows recorded yet."
    : payback >= 100
      ? `<b class="pos">Paid back</b> — benefits cover ${payback}% of invested capital.`
      : `Benefits cover <b>${payback}%</b> of invested capital — payback pending over the ${inv.horizon_years}-year horizon.`;
  openModal(`
    <div class="muted">${INV_CATEGORIES[inv.category] || inv.category} · ${esc(inv.company_code)} ·
      started ${esc(inv.start_date || "?")} · horizon ${inv.horizon_years} years
      ${inv.project_code ? "· linked to " + esc(inv.project_code) : ""}</div>
    <p>${esc(inv.description)}</p>
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">Committed</div><div class="kpi-value">${fmtShort(inv.committed_amount)}</div></div>
      <div class="kpi"><div class="kpi-label">Invested</div><div class="kpi-value">${fmtShort(inv.invested)}</div></div>
      <div class="kpi"><div class="kpi-label">Benefits</div><div class="kpi-value">${fmtShort(inv.benefit)}</div></div>
      <div class="kpi ${inv.benefit - inv.invested >= 0 ? "green" : "red"}"><div class="kpi-label">Net</div>
        <div class="kpi-value">${fmtShort(inv.benefit - inv.invested)}</div></div>
    </div>
    ${chartBars(["Invested", "Benefits"], [
      { name: "Amount", color: C_REV, values: [inv.invested, inv.benefit] },
    ], { height: 170 })}
    <p class="mt">${analysis}</p>
    <table class="tbl mt"><thead><tr><th>Date</th><th>Type</th><th>Description</th>
      <th class="num">Amount</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
      <tbody>${inv.events.map(e => `<tr>
        <td>${esc(e.date)}</td>
        <td><span class="pill ${e.kind === "benefit" ? "posted" : "draft"}">${e.kind}</span></td>
        <td>${esc(e.description)}</td><td class="num">${fmt(e.amount)}</td>
        ${canWrite() ? `<td><button class="btn btn-sm btn-ghost" data-del-ev="${e.id}">&times;</button></td>` : ""}</tr>`).join("") ||
        `<tr><td colspan="5" class="empty">No entries yet</td></tr>`}</tbody></table>
    <div class="form-actions">
      ${canWrite() ? `<button class="btn btn-primary" id="ivAddEntry">+ Add Entry</button>` : ""}
    </div>`, { title: inv.name });
  if ($("#ivAddEntry")) $("#ivAddEntry").onclick = () =>
    investmentEntryModal(iid, () => investmentDetail(iid, reload));
  $$("#modalRoot [data-del-ev]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this entry?")) return;
    try {
      await api("/api/investment-events/" + b.dataset.delEv, { method: "DELETE" });
      toast("Entry removed");
      investmentDetail(iid, reload);
    } catch (e) { toast(e.message, true); }
  });
}

/* ------------------------------------------------------------------ budgets */
async function pageBudgets(el) {
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Budgets")} — ${state.year}</h2>
      <div class="page-actions">
        <label class="muted">Company <select id="bCompany">${companyOptions(cid)}</select></label>
        <a class="btn" href="/api/templates/budget?year=${state.year}">&#x2913; Template</a>
        ${canWrite() ? `<button class="btn" id="bImport">&#x2912; Import Excel</button>` : ""}
        <button class="btn" id="bExport">&#x2913; Export Excel</button>
        ${canWrite() ? `<button class="btn btn-primary" id="bSave">Save Budget</button>` : ""}
      </div></div>
    <div class="tabs" id="bModes">
      <button data-m="company" class="active">Company-level budget</button>
      <button data-m="project">Per-project budget</button>
    </div>
    <div class="filters" id="bProjectBar" hidden>
      <label>Project <select id="bProject" style="min-width:260px"></select></label>
      ${canWrite() ? `<button class="btn btn-sm" id="bNewProject">+ New project</button>` : ""}
      <span class="muted">Projects belong to the selected company. Budget below is per account, for this project only.</span>
    </div>
    <div class="card budget-wrap"><div id="bGrid"></div>
      ${canWrite() ? `<div class="mt filters">
        <label>Add account to budget <select id="bAddAcc" style="min-width:280px"></select></label>
        <label>Remove account from budget <select id="bRemAcc" style="min-width:280px"></select></label>
        <span class="muted">Amounts are in IDR, shown with thousand separators.</span></div>` : ""}
    </div>
    <div class="card mt"><h3 id="bvaTitle">Budget vs Realization — ${state.year}</h3><div id="bvaBox"></div>
      <div class="mt"><a class="btn btn-sm" id="bvaExport">&#x2913; Export Budget vs Realization</a></div>
    </div>`;

  let rows = [], mode = "company", projectId = null, projectList = [];
  const company = () => $("#bCompany").value;
  const pid = () => (mode === "project" ? projectId : null);

  async function refreshProjects() {
    projectList = await api("/api/projects?company_id=" + company());
    const sel = $("#bProject");
    sel.innerHTML = projectList.length
      ? projectList.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join("")
      : `<option value="">(no projects in this company yet)</option>`;
    if (!projectList.find(p => String(p.id) === String(projectId)))
      projectId = projectList.length ? projectList[0].id : null;
    sel.value = projectId || "";
  }

  async function load() {
    if (mode === "project") {
      await refreshProjects();
      if (!projectId) {
        rows = [];
        renderGrid();
        if ($("#bAddAcc")) $("#bAddAcc").innerHTML = "";
        if ($("#bRemAcc")) $("#bRemAcc").innerHTML = "";
        $("#bvaBox").innerHTML = `<div class="empty">Create a project in this company to budget for it.</div>`;
        return;
      }
    }
    const targetPid = pid();
    const data = await api(`/api/budgets?company_id=${company()}&year=${state.year}`);
    rows = data.rows.filter(r => (mode === "project"
      ? String(r.project_id) === String(targetPid) : !r.project_id));
    renderGrid();
    const accounts = await api("/api/accounts?company_id=" + company());
    // add + remove dropdowns are rebuilt together so their row indices never drift
    function rebuildDropdowns() {
      const inGrid = new Set(rows.map(r => r.account_id));
      const addSel = $("#bAddAcc");
      if (addSel) {
        addSel.innerHTML = `<option value="">— choose account to add —</option>` +
          accounts.filter(a => a.is_active && !inGrid.has(a.id) && (a.type === "revenue" || a.type === "expense"))
            .map(a => `<option value="${a.id}" data-code="${esc(a.code)}" data-name="${esc(a.name)}" data-type="${a.type}">${esc(a.code)} ${esc(a.name)}</option>`).join("");
        addSel.onchange = () => {
          const o = addSel.selectedOptions[0];
          if (!o || !o.value) return;
          rows.push({ account_id: parseInt(o.value, 10), code: o.dataset.code, name: o.dataset.name,
                      type: o.dataset.type, project_id: targetPid, amounts: Array(12).fill(0) });
          rows.sort((a, b) => a.code.localeCompare(b.code));
          renderGrid();
          rebuildDropdowns();
          addSel.value = "";
        };
      }
      const remSel = $("#bRemAcc");
      if (remSel) {
        remSel.innerHTML = `<option value="">— choose account to remove —</option>` +
          rows.map((r, ri) => `<option value="${ri}">${esc(r.code)} ${esc(r.name)}</option>`).join("");
        remSel.onchange = async () => {
          const r = rows[remSel.value];
          if (!r) return;
          remSel.value = "";
          if (!confirm(`Remove ${r.code} ${r.name} from the ${state.year} budget?`)) return;
          try {
            await api(`/api/budgets?company_id=${company()}&year=${state.year}&account_id=${r.account_id}&project_id=${r.project_id || ""}`,
              { method: "DELETE" });
            toast(`${r.code} removed from budget`);
            load();
          } catch (e) { toast(e.message, true); }
        };
      }
    }
    rebuildDropdowns();
    const bvaUrl = mode === "project"
      ? `/api/reports/project-budget-vs-actual?company_id=${company()}&project_id=${targetPid}&year=${state.year}`
      : `/api/reports/budget-vs-actual?company_id=${company()}&year=${state.year}`;
    renderBva(await api(bvaUrl));
    const exp = $("#bvaExport");
    if (mode === "project") { exp.style.display = "none"; }
    else { exp.style.display = ""; exp.href = `/api/export/budget-vs-actual?company_id=${company()}&year=${state.year}`; }
    $("#bvaTitle").textContent = mode === "project"
      ? `Budget vs Realization — ${($("#bProject").selectedOptions[0] || {}).text || "project"} (${state.year})`
      : `Budget vs Realization — ${state.year}`;
  }

  const fmtIn = n => n ? Math.round(n).toLocaleString("id-ID") : "";
  function renderGrid() {
    const ro = canWrite() ? "" : "readonly";
    $("#bGrid").innerHTML = `<table class="tbl budget-grid"><thead><tr><th>Account</th>
      ${MONTH_NAMES.map(m => `<th class="num">${m}</th>`).join("")}<th class="num">Total</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows.map((r, ri) => `<tr data-ri="${ri}">
        <td><b>${esc(r.code)}</b> ${esc(r.name)}</td>
        ${r.amounts.map((a, mi) => `<td><input ${ro} data-mi="${mi}" type="text" inputmode="numeric" value="${fmtIn(a)}"></td>`).join("")}
        <td class="num row-total">${fmtShort(r.amounts.reduce((x, y) => x + y, 0))}</td>
        ${canWrite() ? `<td><button class="btn btn-sm btn-ghost b-del" title="Remove account from budget">&times;</button></td>` : ""}</tr>`).join("") ||
        `<tr><td colspan="15" class="empty">No budget lines yet — add accounts below or import from Excel</td></tr>`}</tbody></table>`;
    $$("#bGrid input").forEach(inp => {
      const tr = () => inp.closest("tr");
      const row = () => rows[tr().dataset.ri];
      inp.addEventListener("focus", () => {
        const v = row().amounts[inp.dataset.mi];
        inp.value = v ? String(Math.round(v)) : "";
        inp.select();
      });
      inp.addEventListener("input", () => {
        row().amounts[inp.dataset.mi] = Number(inp.value.replace(/[^\d]/g, "")) || 0;
        $(".row-total", tr()).textContent = fmtShort(row().amounts.reduce((x, y) => x + y, 0));
      });
      inp.addEventListener("blur", () => { inp.value = fmtIn(row().amounts[inp.dataset.mi]); });
    });
    $$("#bGrid .b-del").forEach(btn => btn.onclick = async () => {
      const tr = btn.closest("tr"), r = rows[tr.dataset.ri];
      if (!confirm(`Remove ${r.code} ${r.name} from the ${state.year} budget?`)) return;
      try {
        await api(`/api/budgets?company_id=${company()}&year=${state.year}&account_id=${r.account_id}&project_id=${r.project_id || ""}`,
          { method: "DELETE" });
        toast(`${r.code} removed from budget`);
        load();
      } catch (e) { toast(e.message, true); }
    });
  }

  function renderBva(bva) {
    $("#bvaBox").innerHTML = `<table class="tbl"><thead><tr><th>Account</th><th>Type</th>
      <th class="num">Budget</th><th class="num">Realization</th><th class="num">Variance</th><th class="num">Used</th></tr></thead>
      <tbody>${bva.rows.map(r => {
        const bad = r.type === "expense" ? r.variance > 0 : r.variance < 0;
        return `<tr><td>${esc(r.code)} ${esc(r.name)}</td><td>${r.type}</td>
          <td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.actual)}</td>
          <td class="num ${bad ? "neg" : "pos"}">${fmt(r.variance)}</td>
          <td class="num">${r.used_pct == null ? "-" : r.used_pct + "%"}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="empty">No budget defined for ${state.year}</td></tr>`}</tbody></table>`;
  }

  $("#bCompany").onchange = () => { projectId = null; load(); };
  $$("#bModes button").forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    $$("#bModes button").forEach(x => x.classList.toggle("active", x === b));
    $("#bProjectBar").hidden = mode !== "project";
    load();
  });
  $("#bProject").onchange = () => { projectId = parseInt($("#bProject").value, 10) || null; load(); };
  if ($("#bNewProject")) $("#bNewProject").onclick = () =>
    projectEditor(null, async () => { await refreshProjects(); await load(); }, parseInt(company(), 10));
  $("#bExport").onclick = () => {
    if (mode === "project" && !projectId) { toast("Pick a project first", true); return; }
    const pq = mode === "project" ? `&project_id=${projectId}` : "";
    window.location = `/api/export/budget?company_id=${company()}&year=${state.year}${pq}`;
  };
  if ($("#bSave")) $("#bSave").onclick = async () => {
    if (mode === "project" && !projectId) { toast("Pick or create a project first", true); return; }
    try {
      await api("/api/budgets", { method: "PUT", json: {
        company_id: parseInt(company(), 10), year: state.year,
        rows: rows.map(r => ({ account_id: r.account_id, project_id: r.project_id, amounts: r.amounts })),
      }});
      toast(mode === "project" ? "Project budget saved" : "Budget saved");
      load();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#bImport")) $("#bImport").onclick = () => importModal({
    title: "Import Budget", url: "/api/import/budget", templateUrl: `/api/templates/budget?year=${state.year}`,
    extraFields: `<label>Year <input name="year" type="number" value="${state.year}"></label>`,
    company: company(), onDone: load,
  });
  await load();
}

/* ------------------------------------------------------------------ projects */
async function pageProjects(el) {
  el.innerHTML = `
    <div class="page-head"><h2>${t("Projects")} — ${t("Performance")} ${state.year}</h2>
      <div class="page-actions">
        <a class="btn" href="/api/export/project-performance?${scopeQS()}">&#x2913; Export Excel</a>
        ${canWrite() ? `<button class="btn btn-primary" id="pNew">+ New Project</button>` : ""}
      </div></div>
    <div class="card"><div id="pList"></div></div>`;
  const load = async () => {
    const [perf, all] = await Promise.all([
      api(`/api/projects/performance?${scopeQS()}`),
      api(`/api/projects?company_id=${state.companyId}`),
    ]);
    const perfBy = {}; perf.rows.forEach(p => perfBy[p.project_id] = p);
    $("#pList").innerHTML = `<table class="tbl"><thead><tr>
      <th>Project</th><th>Company</th><th>Status</th>
      <th class="num">Revenue</th><th class="num">Expense</th><th class="num">Profit</th>
      <th class="num">Margin</th><th class="num">Budget Rev</th><th class="num">Budget Exp</th><th></th></tr></thead>
      <tbody>${all.map(p => {
        const f = perfBy[p.id] || { revenue: 0, expense: 0, profit: 0, margin_pct: 0, budget_revenue: 0, budget_expense: 0 };
        return `<tr><td class="clickable" data-id="${p.id}" data-name="${esc(p.name)}"><b>${esc(p.code)}</b> ${esc(p.name)}</td>
          <td>${esc(p.company_code)}</td><td><span class="pill ${p.status}">${p.status.replace("_", " ")}</span></td>
          <td class="num">${fmt(f.revenue)}</td><td class="num">${fmt(f.expense)}</td>
          <td class="num ${f.profit >= 0 ? "pos" : "neg"}">${fmt(f.profit)}</td>
          <td class="num">${f.margin_pct}%</td>
          <td class="num muted">${fmt(f.budget_revenue)}</td><td class="num muted">${fmt(f.budget_expense)}</td>
          <td>${canWrite() ? `<button class="btn btn-sm" data-edit="${p.id}">Edit</button>` : ""}</td></tr>`;
      }).join("") || `<tr><td colspan="10" class="empty">No projects</td></tr>`}</tbody></table>`;
    $$("#pList td.clickable").forEach(td => td.onclick = () => projectDetail(td.dataset.id, td.dataset.name));
    $$("#pList [data-edit]").forEach(b => b.onclick = () => projectEditor(all.find(p => p.id == b.dataset.edit), load));
  };
  if ($("#pNew")) $("#pNew").onclick = () => projectEditor(null, load);
  await load();
}

async function projectDetail(pid, name) {
  const monthly = await api(`/api/projects/${pid}/monthly?year=${state.year}`);
  openModal(`
    <h3 class="muted" style="margin-top:0">Monthly performance — ${state.year}</h3>
    ${chartBars(MONTH_NAMES, [
      { name: "Revenue", color: C_REV, values: monthly.map(m => m.revenue) },
      { name: "Expense", color: C_EXP, values: monthly.map(m => m.expense) },
      { name: "Profit", color: C_PROFIT, values: monthly.map(m => m.profit), type: "line" },
    ])}
    <table class="tbl mt"><thead><tr><th>Month</th><th class="num">Revenue</th><th class="num">Expense</th><th class="num">Profit</th></tr></thead>
    <tbody>${monthly.map((m, i) => `<tr><td>${MONTH_NAMES[i]}</td><td class="num">${fmt(m.revenue)}</td>
      <td class="num">${fmt(m.expense)}</td><td class="num ${m.profit >= 0 ? "pos" : "neg"}">${fmt(m.profit)}</td></tr>`).join("")}
    <tr class="total"><td>Total</td><td class="num">${fmt(monthly.reduce((a, m) => a + m.revenue, 0))}</td>
      <td class="num">${fmt(monthly.reduce((a, m) => a + m.expense, 0))}</td>
      <td class="num">${fmt(monthly.reduce((a, m) => a + m.profit, 0))}</td></tr></tbody></table>`,
    { title: name });
}

async function projectEditor(p, reload, defaultCompanyId) {
  const fields = await api("/api/custom-fields?entity=project");
  const cid = p ? p.company_id : (defaultCompanyId
    || (state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10)));
  const root = openModal(`
    <div class="form-grid">
      <label>Company <select id="pCompany" ${p ? "disabled" : ""}>${companyOptions(cid)}</select></label>
      <label>Code <input id="pCode" value="${esc(p ? p.code : "")}" ${p ? "disabled" : ""} placeholder="PRJ-XXX"></label>
      <label class="full">Name <input id="pName" value="${esc(p ? p.name : "")}"></label>
      <label>Status <select id="pStatus">${["active", "completed", "on_hold"].map(s =>
        `<option ${p && p.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Start date <input type="date" id="pStart" value="${esc(p ? p.start_date || "" : "")}"></label>
      <label>End date <input type="date" id="pEnd" value="${esc(p ? p.end_date || "" : "")}"></label>
      ${fields.map(f => customFieldInput(f, p && p.custom ? p.custom[f.id] || "" : "")).join("")}
      <label class="full">Description <textarea id="pDesc" rows="2">${esc(p ? p.description : "")}</textarea></label>
    </div>
    <div class="form-actions">
      ${p && canWrite() ? `<button class="btn btn-danger" id="pDelete">Delete Project</button>` : ""}
      <button class="btn btn-primary" id="pSave">Save Project</button></div>`,
    { title: p ? "Edit Project" : "New Project", small: true });
  $("#pSave").onclick = async () => {
    const custom = {};
    fields.forEach(f => { const inp = $("#cf_" + f.id, root); if (inp && inp.value) custom[f.id] = inp.value; });
    const body = {
      company_id: parseInt($("#pCompany").value, 10), code: $("#pCode").value,
      name: $("#pName").value, status: $("#pStatus").value,
      start_date: $("#pStart").value, end_date: $("#pEnd").value,
      description: $("#pDesc").value, custom,
    };
    try {
      if (p) await api("/api/projects/" + p.id, { method: "PUT", json: body });
      else await api("/api/projects", { json: body });
      toast("Project saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#pDelete")) $("#pDelete").onclick = async () => {
    if (!confirm(`Delete project ${p.code} — ${p.name}? This removes its budget lines too. Projects that already have journal transactions cannot be deleted.`)) return;
    try {
      await api("/api/projects/" + p.id, { method: "DELETE" });
      toast("Project deleted"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ reports */
async function pageReports(el) {
  el.innerHTML = `
    <div class="page-head"><h2>${t("Financial Reports")}</h2><div class="muted" id="rScope"></div></div>
    <div class="tabs" id="rTabs">
      <button data-tab="pnl" class="active">${t("Profit & Loss")}</button>
      <button data-tab="cf">${t("Cash Flow")}</button>
      <button data-tab="bs">${t("Balance Sheet")}</button>
      <button data-tab="tb">${t("Trial Balance")}</button>
      <button data-tab="bva">${t("Budget vs Realization")}</button>
    </div>
    <div class="card" id="rBody"></div>`;
  let tab = "pnl";
  $$("#rTabs button").forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    $$("#rTabs button").forEach(x => x.classList.toggle("active", x === b));
    show();
  });
  const dateRangeFilters = () => `
    <label>From date <input type="date" id="rdFrom" value="${state.year}-01-01"></label>
    <label>To date <input type="date" id="rdTo" value="${state.year}-12-31"></label>
    <button class="btn btn-primary" id="rGo">Apply</button>
    <a class="btn" id="rExp">&#x2913; Export Excel</a>
    <a class="btn" id="rExpPdf">&#x1F4C4; Export PDF</a>`;

  function renderCfDetail(d) {
    const list = (title, rows) => `<h3>${title}</h3><table class="tbl">
      <tbody>${rows.map(r => `<tr><td>${esc(r.code)} ${esc(r.name)}</td>
        <td class="num">${fmt(r.amount)}</td></tr>`).join("") || `<tr><td class="empty">None</td></tr>`}</tbody></table>`;
    $("#cfDetail").innerHTML = `
      <div class="grid kpis">
        <div class="kpi"><div class="kpi-label">Opening Balance</div><div class="kpi-value">${fmtShort(d.opening_balance)}</div></div>
        <div class="kpi"><div class="kpi-label">Cash In</div><div class="kpi-value">${fmtShort(d.total_in)}</div></div>
        <div class="kpi"><div class="kpi-label">Cash Out</div><div class="kpi-value">${fmtShort(d.total_out)}</div></div>
        <div class="kpi ${d.net_change >= 0 ? "green" : "red"}"><div class="kpi-label">Net Change</div><div class="kpi-value">${fmtShort(d.net_change)}</div></div>
        <div class="kpi"><div class="kpi-label">Closing Balance</div><div class="kpi-value">${fmtShort(d.closing_balance)}</div></div>
      </div>
      <h3>Monthly Cash Flow — ${esc(d.scope)} (${d.year})</h3>
      ${chartBars(MONTH_NAMES, [
        { name: "Cash In", color: C_REV, values: d.monthly.map(m => m.cash_in) },
        { name: "Cash Out", color: C_EXP, values: d.monthly.map(m => m.cash_out) },
        { name: "Ending Balance", color: "var(--text)", values: d.monthly.map(m => m.ending), type: "line" },
      ])}
      <table class="tbl mt"><thead><tr><th>Month</th><th class="num">Cash In</th>
        <th class="num">Cash Out</th><th class="num">Net</th><th class="num">Ending Balance</th></tr></thead>
        <tbody>
        <tr><td><b>Opening</b></td><td></td><td></td><td></td><td class="num"><b>${fmt(d.opening_balance)}</b></td></tr>
        ${d.monthly.map(m => `<tr><td>${MONTH_NAMES[m.month - 1]}</td>
          <td class="num">${fmt(m.cash_in)}</td><td class="num">${fmt(m.cash_out)}</td>
          <td class="num ${m.net >= 0 ? "pos" : "neg"}">${fmt(m.net)}</td>
          <td class="num">${fmt(m.ending)}</td></tr>`).join("")}
        <tr class="total"><td>TOTAL</td><td class="num">${fmt(d.total_in)}</td>
          <td class="num">${fmt(d.total_out)}</td>
          <td class="num ${d.net_change >= 0 ? "pos" : "neg"}">${fmt(d.net_change)}</td>
          <td class="num">${fmt(d.closing_balance)}</td></tr></tbody></table>
      <div class="grid two-col mt">
        <div>${list("Sources of Cash (where money came from)", d.sources)}</div>
        <div>${list("Uses of Cash (where money went)", d.uses)}</div>
      </div>`;
  }
  const rangeQS = () => `date_from=${$("#rdFrom").value}&date_to=${$("#rdTo").value}`;
  const periodLabel = d => `Period ${d.date_from} → ${d.date_to}`;

  async function show() {
    const body = $("#rBody");
    body.innerHTML = `<div class="empty">Loading…</div>`;
    if (tab === "pnl") {
      body.innerHTML = `<div class="filters">${dateRangeFilters()}
        <span class="muted" id="rPeriod"></span></div><div id="rTable"></div>`;
      const run = async () => {
        const d = await api(`/api/reports/pnl?${scopeQS()}&${rangeQS()}`);
        $("#rScope").textContent = d.scope;
        $("#rPeriod").textContent = periodLabel(d);
        $("#rExp").href = `/api/export/pnl?${scopeQS()}&${rangeQS()}`;
        $("#rExpPdf").href = `/api/export/pdf/pnl?${scopeQS()}&${rangeQS()}`;
        const row = r => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.balance)}</td></tr>`;
        $("#rTable").innerHTML = `<table class="tbl"><thead><tr><th style="width:80px">Code</th><th>Account</th><th class="num">Amount</th></tr></thead><tbody>
          <tr class="section"><td colspan="3">Revenue</td></tr>${d.revenue.map(row).join("")}
          <tr class="total"><td></td><td>Total Revenue</td><td class="num">${fmt(d.total_revenue)}</td></tr>
          <tr class="section"><td colspan="3">Expenses</td></tr>${d.expense.map(row).join("")}
          <tr class="total"><td></td><td>Total Expenses</td><td class="num">${fmt(d.total_expense)}</td></tr>
          <tr class="total"><td></td><td>NET PROFIT (margin ${d.margin_pct}%)</td>
            <td class="num ${d.net_profit >= 0 ? "pos" : "neg"}">${fmt(d.net_profit)}</td></tr></tbody></table>`;
      };
      $("#rGo").onclick = run;
      await run();
    } else if (tab === "bs") {
      body.innerHTML = `<div class="filters">
        <label>As of date <input type="date" id="rdAsOf" value="${state.year}-12-31"></label>
        <button class="btn btn-primary" id="rGo">Apply</button>
        <a class="btn" id="rExp">&#x2913; Export Excel</a>
        <a class="btn" id="rExpPdf">&#x1F4C4; Export PDF</a>
        <span class="muted" id="rPeriod"></span></div><div id="rTable"></div>`;
      const run = async () => {
        const d = await api(`/api/reports/balance-sheet?${scopeQS()}&as_of=${$("#rdAsOf").value}`);
        $("#rScope").textContent = d.scope;
        $("#rPeriod").textContent = `As of ${d.as_of}`;
        $("#rExp").href = `/api/export/balance-sheet?${scopeQS()}&as_of=${$("#rdAsOf").value}`;
        $("#rExpPdf").href = `/api/export/pdf/balance-sheet?${scopeQS()}&as_of=${$("#rdAsOf").value}`;
        const sect = (title, rows, total) => `<tr class="section"><td colspan="3">${title}</td></tr>` +
          rows.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${fmt(r.balance)}</td></tr>`).join("") +
          `<tr class="total"><td></td><td>Total ${title}</td><td class="num">${fmt(total)}</td></tr>`;
        $("#rTable").innerHTML = `<table class="tbl"><thead><tr><th style="width:80px">Code</th><th>Account</th><th class="num">Amount</th></tr></thead><tbody>
          ${sect("Assets", d.assets, d.total_assets)}
          ${sect("Liabilities", d.liabilities, d.total_liabilities)}
          ${sect("Equity", d.equity, d.total_equity)}</tbody></table>
          <p class="${d.balanced ? "pos" : "neg"} mt"><b>${d.balanced ? "✓ Balanced" : "⚠ Not balanced"}</b>
          — Assets ${fmt(d.total_assets)} vs Liabilities + Equity ${fmt(d.total_liabilities + d.total_equity)}</p>`;
      };
      $("#rGo").onclick = run;
      await run();
    } else if (tab === "tb") {
      body.innerHTML = `<div class="filters">${dateRangeFilters()}
        <label class="seg-check"><input type="checkbox" id="tbDetail"> Detailed — journal entries &amp; source</label>
        ${canWrite() ? `<button class="btn btn-sm" id="tbOpening">&#9998; Opening Balances</button>` : ""}
        <span class="muted" id="rPeriod"></span></div><div id="rTable"></div>`;
      const run = async () => {
        const detailed = $("#tbDetail").checked;
        const d = await api(`/api/reports/trial-balance?${scopeQS()}&${rangeQS()}${detailed ? "&detailed=1" : ""}`);
        $("#rScope").textContent = d.scope;
        $("#rPeriod").textContent = periodLabel(d);
        $("#rExp").href = `/api/export/trial-balance?${scopeQS()}&${rangeQS()}`;
        $("#rExpPdf").href = `/api/export/pdf/trial-balance?${scopeQS()}&${rangeQS()}`;
        if (!detailed) {
          $("#rTable").innerHTML = `<table class="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th>
            <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
            <tbody>${d.rows.map(r => `<tr><td>${esc(r.code)}</td>
              <td><a href="#" class="tb-name" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${esc(r.name)}</a></td><td>${r.type}</td>
              <td class="num">${fmt(r.debit)}</td><td class="num">${fmt(r.credit)}</td><td class="num">${fmt(r.balance)}</td></tr>`).join("")}
            <tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(d.total_debit)}</td>
              <td class="num">${fmt(d.total_credit)}</td><td></td></tr></tbody></table>
            <p class="muted mt">Click an account name to see its detailed journal entries and each entry&rsquo;s source.</p>`;
          $$("#rTable .tb-name").forEach(a => a.onclick = e => {
            e.preventDefault(); openAccountLedger(a.dataset.code, a.dataset.name);
          });
        } else {
          $("#rTable").innerHTML = renderTbDetailed(d, state.companyId === "all");
          $$("#rTable .tb-acc").forEach(rowEl => rowEl.onclick = () => {
            const code = rowEl.dataset.code;
            $$(`#rTable tr[data-acc="${cssEsc(code)}"]`).forEach(er => er.hidden = !er.hidden);
            rowEl.classList.toggle("open");
            const car = $(".caret", rowEl); if (car) car.textContent = rowEl.classList.contains("open") ? "▾" : "▸";
          });
        }
      };
      $("#rGo").onclick = run;
      $("#tbDetail").onchange = run;
      if ($("#tbOpening")) $("#tbOpening").onclick = () => openOpeningBalances(run);
      await run();
    } else if (tab === "cf") {
      const cfDefault = state.companyId !== "all" ? state.companyId : firstCompanyId();
      body.innerHTML = `<div class="filters">
          <label>Company <select id="cfCompany">${companyOptions(cfDefault, { includeAll: true })}</select></label>
          <a class="btn" id="cfExp">&#x2913; Export Excel</a>
          <a class="btn" id="cfExpPdf">&#x1F4C4; Export PDF</a>
          <span class="muted">Cash &amp; bank accounts (11xx) — year ${state.year}</span></div>
        <div id="cfDetail"></div><div id="cfCompare"></div>`;
      const runCf = async () => {
        const cid = $("#cfCompany").value;
        const d = await api(`/api/reports/cash-flow?company_id=${cid}&year=${state.year}`);
        $("#rScope").textContent = d.scope;
        $("#cfExp").href = `/api/export/cash-flow?company_id=${cid}&year=${state.year}`;
        $("#cfExpPdf").href = `/api/export/pdf/cash-flow?company_id=${cid}&year=${state.year}`;
        renderCfDetail(d);
      };
      $("#cfCompany").onchange = runCf;
      await runCf();
      if (state.me.companies.length > 1) {
        const per = await Promise.all(state.me.companies.map(c =>
          api(`/api/reports/cash-flow?company_id=${c.id}&year=${state.year}`).then(d => ({ c, d }))));
        $("#cfCompare").innerHTML = `<h3 class="mt">Per Company Comparison (${state.year})</h3>
          <table class="tbl"><thead><tr><th>Company</th><th class="num">Opening</th><th class="num">Cash In</th>
          <th class="num">Cash Out</th><th class="num">Net Change</th><th class="num">Closing</th></tr></thead>
          <tbody>${per.map(({ c, d }) => `<tr><td><b>${esc(c.code)}</b> ${esc(c.name)}</td>
            <td class="num">${fmt(d.opening_balance)}</td><td class="num">${fmt(d.total_in)}</td>
            <td class="num">${fmt(d.total_out)}</td>
            <td class="num ${d.net_change >= 0 ? "pos" : "neg"}">${fmt(d.net_change)}</td>
            <td class="num"><b>${fmt(d.closing_balance)}</b></td></tr>`).join("")}</tbody></table>`;
      }
      return;
    } else if (tab === "bva") {
      const d = await api(`/api/reports/budget-vs-actual?${scopeQS()}`);
      $("#rScope").textContent = d.scope;
      body.innerHTML = `<div class="filters"><a class="btn" href="/api/export/budget-vs-actual?${scopeQS()}">&#x2913; Export Excel</a>
        <a class="btn" href="/api/export/pdf/budget-vs-actual?${scopeQS()}">&#x1F4C4; Export PDF</a>
        <span class="muted">Realization = posted actuals (Realisasi)</span></div>
        <table class="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th>
        <th class="num">Budget</th><th class="num">Realization</th><th class="num">Variance</th><th class="num">Used</th></tr></thead>
        <tbody>${d.rows.map(r => {
          const bad = r.type === "expense" ? r.variance > 0 : r.variance < 0;
          return `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${r.type}</td>
            <td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.actual)}</td>
            <td class="num ${bad ? "neg" : "pos"}">${fmt(r.variance)}</td>
            <td class="num">${r.used_pct == null ? "-" : r.used_pct + "%"}</td></tr>`;
        }).join("") || `<tr><td colspan="7" class="empty">No budget for ${state.year}</td></tr>`}</tbody></table>`;
    }
  }
  await show();
}

/* ------------------------------------------------------------------ settings */
async function pageSettings(el) {
  const tabs = [["coa", "Chart of Accounts"], ["fields", "Custom Fields"], ["companies", "Companies"]];
  if (isAdmin()) tabs.push(["users", "Users"], ["thresholds", "Thresholds"]);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Settings")}</h2></div>
    <div class="tabs" id="sTabs">${tabs.map(([k, l], i) =>
      `<button data-tab="${k}" class="${i === 0 ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="sBody"></div>`;
  let tab = "coa";
  $$("#sTabs button").forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    $$("#sTabs button").forEach(x => x.classList.toggle("active", x === b));
    show();
  });
  async function show() {
    const body = $("#sBody");
    body.innerHTML = `<div class="card"><div class="empty">Loading…</div></div>`;
    if (tab === "coa") await settingsCoa(body);
    else if (tab === "fields") await settingsFields(body);
    else if (tab === "companies") await settingsCompanies(body);
    else if (tab === "users") await settingsUsers(body);
    else if (tab === "thresholds") await settingsThresholds(body);
  }
  await show();
}

function updateDbBadge() {
  // Database management lives on the dedicated /databases picker page; the badge
  // shows the active store and links back to the picker to switch.
  const badge = $("#dbBadge");
  if (!badge) return;
  const active = state.me.active_db;
  const isSandbox = active && active !== "MORES-GROUP";
  badge.textContent = active ? "LIVE · " + active : "";
  badge.hidden = !active;
  badge.className = "db-badge" + (isSandbox ? " sandbox" : "");
  badge.style.cursor = "pointer";
  badge.title = "Switch database";
  badge.onclick = () => { window.location.href = "/databases"; };
}

async function settingsCoa(body) {
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  body.innerHTML = `<div class="card">
    <div class="page-head"><h3 style="margin:0">Chart of Accounts <span class="muted">(standardized per company)</span></h3>
      <div class="page-actions">
        <label class="muted">Company <select id="cCompany">${companyOptions(cid)}</select></label>
        <a class="btn btn-sm" href="#" id="cExport">&#x2913; Export</a>
        <a class="btn btn-sm" href="/api/templates/coa">&#x2913; Template</a>
        ${canWrite() ? `<button class="btn btn-sm" id="cImport">&#x2912; Import</button>
        <button class="btn btn-sm" id="cStd">Apply Standard COA</button>
        ${isAdmin() ? `<button class="btn btn-sm" id="cStdAll" title="Apply the standard accounts (incl. intercompany 1900/2900) to every company">Uniform across all companies</button>` : ""}
        <button class="btn btn-sm btn-primary" id="cNew">+ Account</button>` : ""}
      </div></div>
    <div id="cList"></div></div>`;
  const company = () => $("#cCompany").value;
  const load = async () => {
    const rows = await api("/api/accounts?company_id=" + company());
    $("#cExport").href = "/api/export/coa?company_id=" + company();
    // level + ordering from the real parent chain (handles 5100-01-01 and C-AKUN alike)
    const byCode = {}; rows.forEach(a => byCode[a.code] = a);
    const levelOf = a => { let lvl = 0, p = a.parent_code; while (p && byCode[p] && lvl < 6) { lvl++; p = byCode[p].parent_code; } return lvl; };
    const sortKey = a => { const chain = []; let x = a; while (x) { chain.unshift(x.code); x = x.parent_code ? byCode[x.parent_code] : null; } return chain.join("/"); };
    const ordered = rows.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    $("#cList").innerHTML = `<table class="tbl"><thead><tr><th>Code</th><th>Name <span class="muted" style="font-weight:400;text-transform:none">(3-level: 5100 → 5100-01 → 5100-01-01)</span></th><th>Type</th>
      <th>Parent</th><th>Flags</th><th style="min-width:130px"></th></tr></thead>
      <tbody>${ordered.map(a => {
        const level = levelOf(a);
        return `<tr ${a.is_active ? "" : 'style="opacity:.5"'}>
        <td style="padding-left:${10 + level * 22}px">${level ? '<span class="muted">└</span> ' : ""}<b>${esc(a.code)}</b></td>
        <td style="padding-left:${10 + level * 22}px">${esc(a.name)}</td><td>${a.type}</td><td>${esc(a.parent_code || "")}</td>
        <td>${a.is_intercompany ? '<span class="pill completed">intercompany</span>' : ""}
            ${a.is_active ? "" : '<span class="pill inactive">inactive</span>'}</td>
        <td>${canWrite() ? `<button class="btn btn-sm" data-id="${a.id}">Edit</button>
            ${level < 2 ? `<button class="btn btn-sm" data-child="${a.id}" title="Add derivative account under ${esc(a.code)}">+ Child</button>` : ""}` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
    $$("#cList [data-id]").forEach(b => b.onclick = () => accountEditor(rows.find(a => a.id == b.dataset.id), load));
    $$("#cList [data-child]").forEach(b => b.onclick = () => {
      const p = rows.find(a => a.id == b.dataset.child);
      accountEditor(null, load, parseInt(company(), 10),
        { code: p.code + "-", type: p.type, parent_code: p.code });
    });
  };
  $("#cCompany").onchange = load;
  if ($("#cNew")) $("#cNew").onclick = () => accountEditor(null, load, parseInt(company(), 10));
  if ($("#cStd")) $("#cStd").onclick = async () => {
    const r = await api("/api/accounts/apply-standard", { json: { company_id: parseInt(company(), 10) } });
    toast(r.added ? `${r.added} standard accounts added` : "Already up to date with the standard COA");
    load();
  };
  if ($("#cStdAll")) $("#cStdAll").onclick = async () => {
    if (!confirm("Apply the standard chart of accounts (incl. intercompany 1900/2900) to EVERY company? Existing accounts are kept; only missing standard accounts are added.")) return;
    try {
      const r = await api("/api/accounts/apply-standard-all", { json: {} });
      toast(r.total_added ? `${r.total_added} accounts added across ${r.companies.length} companies — COA uniform` : "All companies already uniform");
      load();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#cImport")) $("#cImport").onclick = () => importModal({
    title: "Import Chart of Accounts", url: "/api/import/coa", templateUrl: "/api/templates/coa",
    company: company(), onDone: load,
  });
  await load();
}

function accountEditor(a, reload, companyId, prefill) {
  prefill = prefill || {};
  openModal(`
    <div class="form-grid">
      <label>Code <span class="muted" style="font-weight:400">(use dashes for levels: 5100-01-01)</span>
        <input id="aCode" value="${esc(a ? a.code : prefill.code || "")}" ${a ? "disabled" : ""}></label>
      <label>Type <select id="aType">${["asset", "liability", "equity", "revenue", "expense"].map(t =>
        `<option ${(a ? a.type : prefill.type) === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="full">Name <input id="aName" value="${esc(a ? a.name : "")}"></label>
      <label>Parent code <span class="muted" style="font-weight:400">(auto from dashes if blank)</span>
        <input id="aParent" value="${esc(a ? a.parent_code || "" : prefill.parent_code || "")}"></label>
      <label style="flex-direction:row;align-items:center;gap:8px;margin-top:18px">
        <input type="checkbox" id="aIc" ${a && a.is_intercompany ? "checked" : ""} style="width:auto"> Intercompany (eliminated in consolidation)</label>
      ${a ? `<label style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="aActive" ${a.is_active ? "checked" : ""} style="width:auto"> Active</label>` : ""}
    </div>
    <div class="form-actions">
      ${a ? `<button class="btn btn-danger" id="aDel">Delete</button>` : ""}
      <button class="btn btn-primary" id="aSave">Save</button></div>`,
    { title: a ? "Edit Account " + a.code : "New Account", small: true });
  $("#aSave").onclick = async () => {
    const payload = {
      name: $("#aName").value, type: $("#aType").value,
      parent_code: $("#aParent").value, is_intercompany: $("#aIc").checked,
      is_active: a ? $("#aActive").checked : true,
    };
    try {
      if (a) await api("/api/accounts/" + a.id, { method: "PUT", json: payload });
      else await api("/api/accounts", { json: Object.assign(payload, { company_id: companyId, code: $("#aCode").value }) });
      toast("Account saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#aDel")) $("#aDel").onclick = async () => {
    if (!confirm("Delete account " + a.code + "?")) return;
    try { await api("/api/accounts/" + a.id, { method: "DELETE" }); toast("Account deleted"); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
}

async function settingsFields(body) {
  const load = async () => {
    const rows = await api("/api/custom-fields");
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Custom Fields <span class="muted">(extra inputs on journals &amp; projects)</span></h3>
        ${isAdmin() ? `<button class="btn btn-sm btn-primary" id="fNew">+ Field</button>` : ""}</div>
      <table class="tbl"><thead><tr><th>Applies to</th><th>Label</th><th>Key</th><th>Type</th><th>Options</th><th></th></tr></thead>
      <tbody>${rows.map(f => `<tr><td>${f.entity}</td><td>${esc(f.label)}</td><td class="muted">${esc(f.field_key)}</td>
        <td>${f.field_type}</td><td class="muted">${esc(f.options)}</td>
        <td>${isAdmin() ? `<button class="btn btn-sm btn-danger" data-id="${f.id}">Remove</button>` : ""}</td></tr>`).join("") ||
        `<tr><td colspan="6" class="empty">No custom fields</td></tr>`}</tbody></table></div>`;
    $$("#sBody [data-id]").forEach(b => b.onclick = async () => {
      if (!confirm("Remove this field?")) return;
      await api("/api/custom-fields/" + b.dataset.id, { method: "DELETE" });
      toast("Field removed"); load();
    });
    if ($("#fNew")) $("#fNew").onclick = () => {
      openModal(`<div class="form-grid">
        <label>Applies to <select id="cfEntity"><option value="journal">Journal entry</option><option value="project">Project</option></select></label>
        <label>Type <select id="cfType"><option>text</option><option>number</option><option>date</option><option>select</option></select></label>
        <label class="full">Label <input id="cfLabel" placeholder="e.g. Cost Center"></label>
        <label class="full">Options <span class="muted">(for select type, comma separated)</span><input id="cfOptions"></label>
        </div><div class="form-actions"><button class="btn btn-primary" id="cfSave">Add Field</button></div>`,
        { title: "New Custom Field", small: true });
      $("#cfSave").onclick = async () => {
        try {
          await api("/api/custom-fields", { json: {
            entity: $("#cfEntity").value, field_type: $("#cfType").value,
            label: $("#cfLabel").value, options: $("#cfOptions").value,
          }});
          toast("Field added"); closeModal(); load();
        } catch (e) { toast(e.message, true); }
      };
    };
  };
  await load();
}

async function settingsCompanies(body) {
  const load = async () => {
    const rows = await api("/api/companies" + (isAdmin() ? "?include_inactive=1" : ""));
    const byId = {}; rows.forEach(c => byId[c.id] = c);
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Companies</h3>
        ${isAdmin() ? `<button class="btn btn-sm btn-primary" id="coNew">+ Company</button>` : ""}</div>
      <table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Currency</th><th></th></tr></thead>
      <tbody>${rows.map(c => `<tr ${c.is_active ? "" : 'style="opacity:.6"'}>
        <td><b>${esc(c.code)}</b></td>
        <td>${esc(c.name)}${c.is_active ? "" : ' <span class="pill inactive">inactive</span>'}</td>
        <td>${esc(c.currency)}</td>
        <td>${isAdmin() ? `<button class="btn btn-sm" data-id="${c.id}">Edit</button>
          ${rows.length > 1 ? `<button class="btn btn-sm btn-danger" data-del="${c.id}">Delete</button>` : ""}` : ""}</td></tr>`).join("")}</tbody></table>
      <p class="muted mt">Deleting a company permanently removes it together with all of its accounts,
        projects, journal entries, budgets and investments.</p></div>`;
    $$("#sBody [data-id]").forEach(b => b.onclick = () => companyEditor(byId[b.dataset.id], rows, load));
    $$("#sBody [data-del]").forEach(b => b.onclick = () => confirmDeleteCompany(byId[b.dataset.del], load));
    if ($("#coNew")) $("#coNew").onclick = () => companyEditor(null, rows, load);
  };
  await load();
}

function confirmDeleteCompany(c, reload) {
  openModal(`<div class="confirm-del">
    <p>Delete company <b>${esc(c.code)} — ${esc(c.name)}</b>?</p>
    <p class="muted">This permanently removes the company and <b>all of its data</b> —
      chart of accounts, projects, journal entries, budgets and investments.
      <b>This cannot be undone.</b></p>
    <label class="seg-check"><input type="checkbox" id="coDelConfirm"> Yes, I understand this deletes everything for ${esc(c.code)}</label>
    <div class="form-actions">
      <button class="btn" id="coDelCancel">Cancel</button>
      <button class="btn btn-danger" id="coDelYes" disabled>Delete company &amp; all its data</button>
    </div></div>`, { title: "Delete company", small: true });
  $("#coDelConfirm").onchange = e => { $("#coDelYes").disabled = !e.target.checked; };
  $("#coDelCancel").onclick = closeModal;
  $("#coDelYes").onclick = async () => {
    try {
      await api("/api/companies/" + c.id, { method: "DELETE" });
      toast(`Company ${c.code} deleted`);
      closeModal();
      state.me = await api("/api/me");
      if (String(state.companyId) === String(c.id)) {
        state.companyId = "all"; localStorage.setItem("erp.company", "all");
      }
      renderCompanyChoice();
      reload();
    } catch (e) { toast(e.message, true); }
  };
}

function companyEditor(c, all, reload) {
  openModal(`<div class="form-grid">
    <label>Code <input id="coCode" value="${esc(c ? c.code : "")}" ${c ? "disabled" : ""} placeholder="e.g. SUB1"></label>
    <label>Currency <input id="coCur" value="${esc(c ? c.currency : "IDR")}"></label>
    <label class="full">Name <input id="coName" value="${esc(c ? c.name : "")}"></label>
    ${c ? `<label style="flex-direction:row;align-items:center;gap:8px;margin-top:18px">
      <input type="checkbox" id="coActive" ${c.is_active ? "checked" : ""} style="width:auto"> Active</label>`
      : `<label style="flex-direction:row;align-items:center;gap:8px;margin-top:18px">
      <input type="checkbox" id="coStd" checked style="width:auto"> Apply standard chart of accounts</label>`}
    </div><div class="form-actions"><button class="btn btn-primary" id="coSave">Save Company</button></div>`,
    { title: c ? "Edit Company" : "New Company", small: true });
  $("#coSave").onclick = async () => {
    const body = {
      name: $("#coName").value, currency: $("#coCur").value,
    };
    try {
      if (c) await api("/api/companies/" + c.id, { method: "PUT", json: Object.assign(body, { is_active: $("#coActive").checked }) });
      else await api("/api/companies", { json: Object.assign(body, { code: $("#coCode").value, apply_standard_coa: $("#coStd").checked }) });
      toast("Company saved — re-login may be needed to refresh access");
      closeModal(); state.me = await api("/api/me"); renderCompanyChoice();
      reload();
    } catch (e) { toast(e.message, true); }
  };
}

async function settingsThresholds(body) {
  const METRICS = [
    { key: "cash_buffer_months", label: "Cash Buffer (months)", unit: "mo", dir: "high" },
    { key: "gross_margin", label: "Gross Margin", unit: "%", dir: "high", pct: true },
    { key: "net_margin", label: "Net Margin", unit: "%", dir: "high", pct: true },
    { key: "current_ratio", label: "Current Ratio", unit: "x", dir: "high" },
    { key: "dso_days", label: "DSO (days)", unit: "d", dir: "low" },
    { key: "salary_ratio", label: "Salary / Revenue", unit: "%", dir: "low", pct: true },
  ];
  const load = async () => {
    const d = await api("/api/settings/thresholds");
    const th = d.thresholds;
    const disp = (m, v) => (v == null ? "" : (m.pct ? Math.round(v * 1000) / 10 : v));
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Warning Thresholds <span class="muted">(owner-watch · Pengawasan)</span></h3>
        <button class="btn btn-sm btn-primary" id="thSave">Save thresholds</button></div>
      <p class="muted" style="margin-top:-6px">Drives the dashboard health indicators &amp; warning banner. <b>Healthy</b> = on target ·
        <b>Watch</b> = approaching · past Watch = <b>Danger</b>. For “lower is better” metrics (DSO, Salary/Revenue) the Healthy number is the lower one.</p>
      <table class="tbl"><thead><tr><th>Metric</th><th>Direction</th><th class="num">Healthy (target)</th><th class="num">Watch</th></tr></thead>
        <tbody>${METRICS.map(m => `<tr>
          <td><b>${m.label}</b></td>
          <td class="muted">${m.dir === "high" ? "higher is better" : "lower is better"}</td>
          <td class="num"><input class="th-in" data-key="${m.key}" data-f="healthy" type="number" step="any" value="${disp(m, th[m.key].healthy)}" style="width:96px;text-align:right"> ${m.unit}</td>
          <td class="num"><input class="th-in" data-key="${m.key}" data-f="watch" type="number" step="any" value="${disp(m, th[m.key].watch)}" style="width:96px;text-align:right"> ${m.unit}</td></tr>`).join("")}
        </tbody></table>
      <p class="muted mt">Percent fields are entered as whole numbers (45 = 45%). Defaults follow your Pengawasan sheet.</p>
    </div>`;
    $("#thSave").onclick = async () => {
      const payload = {};
      METRICS.forEach(m => payload[m.key] = {});
      $$("#sBody .th-in").forEach(inp => {
        const m = METRICS.find(x => x.key === inp.dataset.key);
        let v = parseFloat(inp.value);
        if (!isNaN(v)) payload[inp.dataset.key][inp.dataset.f] = m.pct ? v / 100 : v;
      });
      try {
        await api("/api/settings/thresholds", { json: { thresholds: payload } });
        toast("Thresholds saved — dashboard updated");
        load();
      } catch (e) { toast(e.message, true); }
    };
  };
  await load();
}

async function settingsUsers(body) {
  const load = async () => {
    const rows = await api("/api/users");
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Users &amp; Access</h3>
        <button class="btn btn-sm btn-primary" id="uNew">+ Add User</button></div>
      <table class="tbl"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Company access</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(u => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.full_name)}</td>
        <td><span class="pill ${u.role === "admin" ? "completed" : u.role === "finance" ? "active" : "inactive"}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
        <td class="muted">${esc(u.company_access)}</td>
        <td><span class="pill ${u.is_active ? "active" : "inactive"}">${u.is_active ? "active" : "disabled"}</span></td>
        <td><button class="btn btn-sm" data-id="${u.id}">Edit</button></td></tr>`).join("")}</tbody></table>
      <p class="muted mt"><b>Roles:</b> Admin — ${ROLE_DESC.admin} &middot; Accountant — ${ROLE_DESC.finance} &middot; Viewer/Auditor — ${ROLE_DESC.viewer}.<br>
      Company access: <code>all</code> or comma-separated company ids (e.g. <code>2,3</code>).</p></div>`;
    $$("#sBody [data-id]").forEach(b => b.onclick = () => userEditor(rows.find(u => u.id == b.dataset.id), load));
    $("#uNew").onclick = () => userEditor(null, load);
  };
  await load();
}

function userEditor(u, reload) {
  openModal(`<div class="form-grid">
    <label>Username <input id="uName" value="${esc(u ? u.username : "")}" ${u ? "disabled" : ""}></label>
    <label>Full name <input id="uFull" value="${esc(u ? u.full_name : "")}"></label>
    <label>Role <select id="uRole">${["admin", "finance", "viewer"].map(r =>
      `<option value="${r}" ${u && u.role === r ? "selected" : ""}>${ROLE_LABELS[r]} — ${ROLE_DESC[r]}</option>`).join("")}</select></label>
    <label>Company access <input id="uAccess" value="${esc(u ? u.company_access : "all")}"></label>
    <label class="full">${u ? "New password (leave blank to keep)" : "Password"} <input id="uPass" type="password"></label>
    ${u ? `<label style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="uActive" ${u.is_active ? "checked" : ""} style="width:auto"> Active</label>` : ""}
    </div><div class="form-actions"><button class="btn btn-primary" id="uSave">Save User</button></div>`,
    { title: u ? "Edit User" : "New User", small: true });
  $("#uSave").onclick = async () => {
    const body = {
      full_name: $("#uFull").value, role: $("#uRole").value,
      company_access: $("#uAccess").value || "all",
    };
    if ($("#uPass").value) body.password = $("#uPass").value;
    try {
      if (u) await api("/api/users/" + u.id, { method: "PUT", json: Object.assign(body, { is_active: $("#uActive").checked }) });
      else await api("/api/users", { json: Object.assign(body, { username: $("#uName").value }) });
      toast("User saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ import modal */
function importModal({ title, url, templateUrl, extraFields = "", company, onDone }) {
  const cid = company || (state.companyId === "all" ? firstCompanyId() : state.companyId);
  openModal(`
    <p class="muted">Upload an .xlsx file. <a href="${templateUrl}">Download the template</a> to see the expected columns.</p>
    <form id="impForm" class="form-col" style="display:flex;flex-direction:column;gap:12px">
      <label>Company <select name="company_id">${companyOptions(cid)}</select></label>
      ${extraFields}
      <label>Excel file <input type="file" name="file" accept=".xlsx,.xlsm" required></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Import</button></div>
    </form>
    <div id="impResult"></div>`, { title, small: true });
  $("#impForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api(url, { method: "POST", body: fd });
      const errs = res.errors || [];
      let msg = [];
      if (res.created != null) msg.push(`${res.created} entries created`);
      if (res.updated != null) msg.push(`${res.updated} updated`);
      if (res.saved_rows != null) msg.push(`${res.saved_rows} rows saved`);
      $("#impResult").innerHTML = `<p class="${errs.length ? "neg" : "pos"}"><b>${msg.join(", ") || "Done"}</b></p>` +
        (errs.length ? `<ul>${errs.map(x => `<li class="neg">${esc(x)}</li>`).join("")}</ul>` : "");
      if (!errs.length) { toast(msg.join(", ") || "Imported"); setTimeout(() => { closeModal(); onDone && onDone(); }, 900); }
      else onDone && onDone();
    } catch (err) { $("#impResult").innerHTML = `<p class="neg">${esc(err.message)}</p>`; }
  });
}

boot().catch(e => {
  if (!String(e.message).includes("Session")) {
    document.body.innerHTML = `<div class="empty" style="padding:60px">${esc(e.message)}</div>`;
  }
});
