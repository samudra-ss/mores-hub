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

// DD/MM/YYYY wherever a person reads a date. Values stay ISO underneath - inputs,
// the API and sorting all keep YYYY-MM-DD - and only what is shown changes.
function fmtDate(v) {
  if (v == null || v === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}
function fmtYM(v) {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})$/.exec(String(v).slice(0, 7));
  return m ? `${m[2]}/${m[1]}` : String(v);
}
// Sentences written by the server (Oracle actions, warnings, import notes) carry
// ISO dates. Rewrite them for display. The year is pinned to 19xx/20xx so an
// account code such as 5100-02 is never mistaken for a month.
function fmtDatesIn(text) {
  return String(text == null ? "" : text)
    .replace(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g, "$3/$2/$1")
    .replace(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b(?![\d/-])/g, "$2/$1");
}

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
  bca_pdf: "active", monit_wallet: "completed", excel: "draft", custom: "posted",
  cc_card: "bad",
};

function renderTbDetailed(d, consolidated) {
  const srcPill = e => `<span class="pill ${SOURCE_CLASS[e.source] || "inactive"}">${esc(e.source_label || e.source)}</span>`;
  const body = d.rows.map(acc => {
    const head = `<tr class="tb-acc section" data-code="${esc(acc.code)}" style="cursor:pointer">
      <td><span class="caret">&#9656;</span> ${esc(acc.code)}</td><td>${esc(acc.name)}</td><td>${esc(acc.type)}</td>
      <td class="num">${fmt(acc.debit)}</td><td class="num">${fmt(acc.credit)}</td><td class="num">${fmt(acc.balance)}</td></tr>`;
    const entries = (acc.entries || []).map(e => `<tr class="tb-entry" data-acc="${esc(acc.code)}" hidden>
      <td class="muted" style="padding-left:24px">${esc(fmtDate(e.date))}</td>
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
      <td class="muted" style="white-space:nowrap">${esc(fmtDate(e.date))}</td>
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
        <div class="muted">${esc(d.scope)} · ${esc(fmtDate(d.date_from))} → ${esc(fmtDate(d.date_to))} · ${d.entries.length} entr${d.entries.length === 1 ? "y" : "ies"}</div>
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
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${opts.small ? "small" : ""} ${opts.wide ? "wide" : ""}">
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
  const padL = opts.padL || 58, padR = 8, padT = 12, padB = opts.groupLabels ? 44 : 26;
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
    out += `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" style="fill:var(--muted)">${(opts.axisFmt || fmtShort)(v)}</text>`;
  }
  if (min < 0) out += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" style="stroke:var(--muted)" stroke-width="1.2"/>`;
  const groups = opts.groupLabels || [];
  const lblY = groups.length ? H - 26 : H - 8;
  // 48 week ticks in a row is a grey smear; when they do not fit, only the first
  // week of each month is named and the month band below carries the rest
  const tickFits = gw >= 15;
  const firstOfGroup = new Set(groups.map(g => g.from));
  labels.forEach((lb, i) => {
    if (groups.length && !tickFits && !firstOfGroup.has(i)) return;
    out += `<text x="${padL + i * gw + gw / 2}" y="${lblY}" text-anchor="middle" font-size="${groups.length ? (gw < 20 ? 8.5 : 9.5) : 10}" style="fill:var(--muted)">${esc(lb)}</text>`;
  });
  // one vertical rule per month, so a month can be read at a glance
  groups.forEach((g, gi) => {
    const x0 = padL + g.from * gw, x1 = padL + (g.to + 1) * gw;
    if (gi) out += `<line x1="${x0}" y1="${padT}" x2="${x0}" y2="${H - padB + 20}" style="stroke:var(--border)" stroke-width="1" opacity=".85"/>`;
    out += `<text x="${(x0 + x1) / 2}" y="${H - 5}" text-anchor="middle" font-size="10.5" font-weight="600" style="fill:var(--muted)">${esc(g.text)}</text>`;
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
  "Operating Expenses (6000)": "Beban Operasional (6000)",
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
  // payables (AP aging / Hutang)
  "AP Aging (Hutang)": "Daftar Umur Utang", "Add Bill": "Tambah Tagihan",
  "Vendor": "Pemasok", "Bill": "No. Tagihan", "Bill Date": "Tgl Tagihan",
  "Overdue AP (> 90 days)": "Utang Menunggak (> 90 hari)",
  // C-AKUN (7300) dashboard chart
  "C-AKUN (7300) — Budget vs Realization": "C-AKUN (7300) — Anggaran vs Realisasi",
  "account 7300 & its sub-accounts": "akun 7300 & sub-akunnya",
  "No C-AKUN (7300) accounts with activity yet.": "Belum ada akun C-AKUN (7300) dengan aktivitas.",
  "Account": "Akun",
  // account parsing (renamed from Bank Import) + dashboard last-input stamp
  "Account Parsing": "Parsing Akun",
  "Last input": "Input terakhir",
  // Investment Center + contribution margin + discussion
  "Investment Center": "Pusat Investasi",
  "Contribution Margin": "Margin Kontribusi",
  "Entries": "Entri", "Discussion": "Diskusi",
  "Add a comment for the team…": "Tambahkan komentar untuk tim…", "Post": "Kirim",
  // v1.05 — nav sections, project schemes, money tracker labels
  "HV Sections": "Bagian HV", "Devil in Detail": "Rincian Detail", "Admin Panel": "Panel Admin",
  "Project Details": "Detail Proyek",
  "Monthly basis": "Basis Bulanan", "Monthly performance": "Kinerja Bulanan",
  "Total Revenue": "Total Pendapatan", "Total Cost": "Total Biaya",
  "Revenue by account": "Pendapatan per Akun", "Cost by account": "Biaya per Akun",
  "Cost budget": "Anggaran Biaya", "cost budget": "anggaran biaya", "budget": "anggaran",
  "margin": "margin", "Month": "Bulan", "Total": "Total",
  "No revenue posted to this project": "Belum ada pendapatan pada proyek ini",
  "No cost posted to this project": "Belum ada biaya pada proyek ini",
  "Back to project": "Kembali ke proyek", "Date": "Tanggal", "Entry": "Entri",
  "Description": "Keterangan", "Source": "Sumber", "Inputter": "Penginput",
  "Debit": "Debit", "Credit": "Kredit",
  "Outstanding": "Belum Diterima", "Prospectus": "Prospektus",
  "Client / project": "Klien / proyek", "search…": "cari…", "default order": "urutan bawaan",
  "Big to small": "Besar ke kecil", "Small to big": "Kecil ke besar",
  "All phases": "Semua fase", "Clear": "Bersihkan", "of": "dari",
  "Mark as HOT": "Tandai HOT", "HOT — click to cool": "HOT — klik untuk dinginkan",
  // Oracle — weekly cash plan
  "Cash Plan (weekly)": "Rencana Kas (mingguan)",
  "dasar kas / cash basis — money actually moving, not invoiced": "dasar kas — uang yang benar-benar bergerak, bukan yang ditagihkan",
  "Penerimaan (cash in)": "Penerimaan (kas masuk)", "Pengeluaran (cash out)": "Pengeluaran (kas keluar)",
  "Net this month": "Bersih Bulan Ini", "Year to date": "Sejak Awal Tahun",
  "cumulative planned cash": "kas rencana kumulatif", "this month": "bulan ini",
  "Version": "Versi", "Certainty": "Kepastian", "Flow": "Arah", "Add line": "Tambah Baris",
  "Add a plan line": "Tambah Baris Rencana", "Seed from monthly budget": "Isi dari anggaran bulanan",
  "Copy to new draft": "Salin ke draf baru", "Save cash plan": "Simpan Rencana Kas",
  "company level": "tingkat perusahaan", "New plan version": "Versi Rencana Baru",
  "Nothing planned in this block yet.": "Belum ada rencana di blok ini.",
  // Oracle — consult + investment commitments
  "The Oracle": "Sang Oracle", "Ask the Oracle": "Tanya Oracle",
  "Consulting the Oracle…": "Menanyakan Oracle…", "dated items": "item bertanggal",
  "Group rule": "Aturan Grup", "Driven by": "Ditentukan oleh",
  "First below floor": "Pertama di bawah batas", "Cash goes negative": "Kas menjadi negatif",
  "Entity": "Entitas", "Verdict": "Putusan", "Opening cash": "Kas Awal",
  "Buffer floor": "Batas Penyangga", "Worst headroom": "Ruang Terkecil", "Worst day": "Hari Terburuk",
  "Assumptions & warnings": "Asumsi & Peringatan", "Commitment schedule": "Jadwal Komitmen",
  "when the committed money actually leaves": "kapan uang komitmen benar-benar keluar",
  "Committed": "Dikomitmenkan", "Scheduled": "Terjadwal", "Already paid out": "Sudah Dibayarkan",
  "Unscheduled": "Belum Terjadwal", "has no date.": "belum punya tanggal.",
  "Nothing scheduled yet.": "Belum ada jadwal.", "Schedule": "Jadwalkan",
  "Settles": "Jatuh", "Note": "Catatan", "Week": "Minggu", "Year": "Tahun",
  // Oracle page (Ahli Nujum)
  "Ahli Nujum": "Ahli Nujum", "does the budget survive the year?": "apakah anggaran ini bertahan setahun?",
  "Verdict & actions": "Putusan & Tindakan", "Sensitivity & crisis": "Sensitivitas & Krisis",
  "Cash policy": "Kebijakan Kas", "Save cash policy": "Simpan Kebijakan Kas",
  "Recommended action": "Tindakan yang Disarankan", "Short by": "Kurang",
  "at the worst point": "pada titik terburuk", "in": "di",
  "Safe until": "Aman sampai", "about": "sekitar", "weeks": "minggu", "all year": "sepanjang tahun",
  "No safe period at all": "Tidak ada periode aman sama sekali", "never": "tidak pernah",
  "cash is already below zero on the first day of the plan": "kas sudah di bawah nol pada hari pertama rencana",
  "cash is already under the buffer floor on the first day of the plan": "kas sudah di bawah batas aman pada hari pertama rencana",
  "This starts as an opening-balance problem, not a plan problem.": "Ini masalah saldo awal, bukan masalah rencana.",
  "Safe all year": "Aman sepanjang tahun", "Per entity": "Per Entitas",
  "Weekly cash": "Kas Mingguan", "Bound run": "Skenario Terikat",
  "Biggest outflows before the worst day": "Pengeluaran terbesar sebelum hari terburuk",
  "What": "Apa", "No cash plan yet": "Belum ada rencana kas", "Go to Budgets": "Buka Anggaran",
  "How wrong can we be before we are not safe?": "Seberapa meleset sebelum kita tidak aman?",
  "Plan as it stands": "Rencana apa adanya", "min headroom": "ruang terkecil",
  "One-way sensitivity": "Sensitivitas Satu Arah", "widest bar = the thing to manage": "batang terlebar = yang harus dikelola",
  "What could go wrong": "Apa yang bisa meleset", "Impact": "Dampak", "Levels": "Tingkat",
  "Break-even — the number to remember": "Titik Impas — angka yang perlu diingat",
  "Revenue vs expense — the safe region": "Pendapatan vs Biaya — wilayah aman",
  "Not applicable": "Tidak berlaku", "swing": "rentang", "breach": "tembus",
  "Convert the monthly budget into Week 1": "Konversi anggaran bulanan ke Minggu 1",
  "Folds every month of the": "Melipat setiap bulan anggaran",
  "budget into its first week, for company-level and project-level lines alike. Weeks 2-4 are ADDED into week 1, never dropped — the month total is identical before and after, and the result says so.":
    "ke minggu pertamanya, baik level perusahaan maupun level proyek. Minggu 2-4 DITAMBAHKAN ke minggu 1, tidak dibuang — total bulan sama persis sebelum dan sesudah, dan hasilnya menyatakan itu.",
  "A monthly budget tells you the month, not the week. Week 1 is its honest reading and the safest for cash: money out as early as it could go. This is what the Oracle then reads.":
    "Anggaran bulanan memberi tahu bulannya, bukan minggunya. Minggu 1 adalah pembacaan yang jujur dan paling aman untuk kas: uang keluar secepat mungkin. Inilah yang dibaca Ahli Nujum.",
  "All companies I can access": "Semua perusahaan yang bisa saya akses",
  "Fold every month into Week 1": "Lipat semua bulan ke Minggu 1",
  "Fold every month of": "Lipat semua bulan tahun", "into Week 1?": "ke Minggu 1?",
  "account-months folded into Week 1.": "akun-bulan dilipat ke Minggu 1.",
  "Total budget before": "Total anggaran sebelum", "after": "sesudah",
  "unchanged, as it must be.": "tidak berubah, sebagaimana mestinya.",
  "THESE DO NOT MATCH. Do not trust this result.": "TIDAK COCOK. Jangan percayai hasil ini.",
  "How to use": "Cara pakai",
  "Add picture": "Tambah gambar",
  "Change picture": "Ganti gambar",
  "Remove": "Hapus",
  "Shown beside the name in the list. PNG, JPG, WebP or GIF — resized to 480 px.": "Ditampilkan di samping nama pada daftar. PNG, JPG, WebP atau GIF — diperkecil ke 480 px.",
  "It is saved together with the new record.": "Gambar disimpan bersama data baru.",
  "That file is not a picture the browser can read": "File itu bukan gambar yang bisa dibaca browser",
  "Picture saved": "Gambar disimpan",
  "Picture removed": "Gambar dihapus",
  "Remove this picture?": "Hapus gambar ini?",
  "Prev": "Sebelumnya",
  "Next": "Berikutnya",
  "Showing": "Menampilkan",
  "page": "halaman",
  "Scenario": "Skenario",
  "weekly rows": "baris mingguan",
  "every budget line as it stands right now": "setiap baris anggaran seperti saat ini",
  "The Pythia on her tripod at Delphi, answering two petitioners": "Pythia di atas tripod di Delphi, menjawab dua pemohon",
  "CONSULT WITH ORACLE": "KONSULTASI DENGAN ORACLE",
  "Consulted at": "Dikonsultasikan pukul",
  "press again to re-read the budget": "tekan lagi untuk membaca ulang anggaran",
  "The Oracle is reading the budget…": "Oracle sedang membaca anggaran…",
  "The Oracle has not been consulted on this reading yet.": "Oracle belum dikonsultasikan untuk bacaan ini.",
  "Press CONSULT WITH ORACLE: it reads the budget exactly as it stands now and answers whether cash survives the year.": "Tekan KONSULTASI DENGAN ORACLE: Oracle membaca anggaran persis seperti saat ini dan menjawab apakah kas bertahan sepanjang tahun.",
  "draft": "draf",
  "approved": "disetujui",
  "scenario": "skenario",
  "P&L YTD": "L/R YTD",
  "Project Tracker": "Tracker Proyek",
  "Health Indicators": "Indikator Kesehatan",
  "SaaS Performance": "Kinerja SaaS",
  "Report settings": "Pengaturan laporan",
  "Forecast model": "Model proyeksi",
  "SaaS model": "Model SaaS",
  "Model settings & drivers": "Pengaturan model & driver",
  "Finance report": "Laporan keuangan",
  "The six-sheet finance report, like the NX-Sentimind template": "Laporan keuangan enam sheet, seperti template NX-Sentimind",
  "no net burn": "tidak ada burn",
  "Bulan": "Bulan",
  "Hari": "Hari",
  "Update": "Update",
  "closed through": "ditutup sampai",
  "no closed month in this year yet": "belum ada bulan yang ditutup tahun ini",
  "where this number comes from": "asal angka ini",
  "entered": "diisi",
  "ledger": "buku besar",
  "money tracker": "money tracker",
  "INDIKATOR KESEHATAN KEUANGAN": "INDIKATOR KESEHATAN KEUANGAN",
  "This SBU has no linked projects, so there is no ledger behind the report. Link its projects on Model settings & drivers.": "SBU ini belum punya proyek tertaut, jadi laporan tidak punya dasar buku besar. Tautkan proyeknya di Pengaturan model & driver.",
  "Dalam target": "Dalam target",
  "Perlu monitoring": "Perlu monitoring",
  "Tindakan segera": "Tindakan segera",
  "Perbarui setiap tutup bulan": "Perbarui setiap tutup bulan",
  "Indikator": "Indikator",
  "Nilai Aktual": "Nilai Aktual",
  "Batas AMAN (🟢)": "Batas AMAN (🟢)",
  "Batas PERHATIAN (🟡)": "Batas PERHATIAN (🟡)",
  "Catatan & Rekomendasi Direksi": "Catatan & Rekomendasi Direksi",
  "Interpretasi & Tindakan": "Interpretasi & Tindakan",
  "HPP / COGS YTD": "HPP YTD",
  "Gross profit YTD": "Laba kotor YTD",
  "OPEX YTD": "OPEX YTD",
  "Net profit YTD": "Laba bersih YTD",
  "tax est.": "estimasi pajak",
  "Show every month": "Tampilkan setiap bulan",
  "Variance: revenue and profit rows read actual − budget; cost rows read budget − actual, so red is always bad.": "Variance: baris pendapatan dan laba = aktual − anggaran; baris biaya = anggaran − aktual, jadi merah selalu buruk.",
  "KATEGORI": "KATEGORI",
  "PENDAPATAN (REVENUE)": "PENDAPATAN (REVENUE)",
  "TOTAL PENDAPATAN": "TOTAL PENDAPATAN",
  "HARGA POKOK PENJUALAN (HPP / COGS)": "HARGA POKOK PENJUALAN (HPP / COGS)",
  "Project Based:": "Berbasis Proyek:",
  "TOTAL HPP": "TOTAL HPP",
  "LABA KOTOR (GROSS PROFIT)": "LABA KOTOR (GROSS PROFIT)",
  "BIAYA OPERASIONAL (OPEX)": "BIAYA OPERASIONAL (OPEX)",
  "TOTAL OPEX": "TOTAL OPEX",
  "Pajak Penghasilan (est.)": "Pajak Penghasilan (est.)",
  "LABA BERSIH (NET PROFIT)": "LABA BERSIH (NET PROFIT)",
  "Actual = posted journal lines tagged to the SBU's projects; budget = the Budget Center rows on those projects. Revenue and HPP are split by the kind of project (client project or SaaS product) set in Report settings; the account codes behind each line are in brackets and can be changed there too. Tax is estimated on the year-to-date and full-year profit only.": "Aktual = jurnal terposting yang ditandai ke proyek SBU; anggaran = baris Budget Center pada proyek tersebut. Pendapatan dan HPP dipisah menurut jenis proyek (proyek klien atau produk SaaS) di Pengaturan laporan; kode akun tiap baris ada di dalam kurung dan bisa diubah di sana. Pajak hanya diestimasi atas laba YTD dan setahun penuh.",
  "Cash In Total": "Total Kas Masuk",
  "Cash Out Total": "Total Kas Keluar",
  "Net Cash": "Kas Bersih",
  "Posisi Kas (opening + net)": "Posisi Kas (saldo awal + bersih)",
  "opening": "saldo awal",
  "Burn rate": "Burn rate",
  "bln": "bln",
  "gross": "bruto",
  "Monthly Summary": "Ringkasan Bulanan",
  "Cash In": "Kas Masuk",
  "Cash Out": "Kas Keluar",
  "Ending Balance": "Saldo Akhir",
  "Net Cash Flow": "Arus Kas Bersih",
  "Every expense type": "Semua jenis biaya",
  "Every project": "Semua proyek",
  "Search description or reference": "Cari keterangan atau referensi",
  "Every posted revenue and cost line on the SBU's projects, as the workbook lists them; depreciation is left out because it is not cash. Rows after the closing month are shown faded and are not in the totals.": "Setiap baris pendapatan dan biaya terposting pada proyek SBU, seperti di workbook; penyusutan tidak dimasukkan karena bukan kas. Baris setelah bulan penutupan ditampilkan pudar dan tidak masuk total.",
  "PROYEK": "PROYEK",
  "NILAI KONTRAK": "NILAI KONTRAK",
  "BUDGET BIAYA": "BUDGET BIAYA",
  "REALISASI BIAYA": "REALISASI BIAYA",
  "RISIKO": "RISIKO",
  "Nama Proyek": "Nama Proyek",
  "Klien": "Klien",
  "Mulai": "Mulai",
  "Selesai": "Selesai",
  "Nilai Kontrak": "Nilai Kontrak",
  "Terbayar": "Terbayar",
  "Risiko": "Risiko",
  "No linked projects.": "Tidak ada proyek tertaut.",
  "RINGKASAN PIPELINE & COLLECTION": "RINGKASAN PIPELINE & COLLECTION",
  "Total Nilai Pipeline": "Total Nilai Pipeline",
  "Total Invoice Terkirim": "Total Invoice Terkirim",
  "Total Terbayar": "Total Terbayar",
  "Budget = Budget Center rows on the project; realisation = posted cost lines up to the closing month (5100-01 Direct, 5100-02 Non Direct, 5100-03 Material, everything else Fixed/Misc). Gross margin = (contract − realised cost) ÷ contract, or on revenue when no contract value is set. Invoice comes from the Money Tracker unless typed in Report settings; paid is the revenue the ledger has received unless typed.": "Budget = baris Budget Center pada proyek; realisasi = biaya terposting sampai bulan penutupan (5100-01 Direct, 5100-02 Non Direct, 5100-03 Material, sisanya Fixed/Misc). Gross margin = (kontrak − realisasi biaya) ÷ kontrak, atau atas pendapatan bila nilai kontrak kosong. Invoice dari Money Tracker kecuali diisi di Pengaturan laporan; terbayar = pendapatan yang diterima di buku besar kecuali diisi.",
  "PRIORITAS TINDAKAN DIREKSI": "PRIORITAS TINDAKAN DIREKSI",
  "Urgensi": "Urgensi",
  "Tindakan yang Diperlukan": "Tindakan yang Diperlukan",
  "No actions yet.": "Belum ada tindakan.",
  "Suggested from the KRITIS indicators. Write the board's own actions on Report settings and they replace these.": "Saran dari indikator KRITIS. Tulis tindakan direksi sendiri di Pengaturan laporan dan itu akan menggantikan saran ini.",
  "Terkini": "Terkini",
  "Pelanggan": "Pelanggan",
  "Rata-rata": "Rata-rata",
  "Aktual": "Aktual",
  "Customers (end)": "Pelanggan (akhir)",
  "METRIK": "METRIK",
  "Customer Awal Bulan": "Customer Awal Bulan",
  "Pelanggan Baru (Akuisisi)": "Pelanggan Baru (Akuisisi)",
  "Churned (Berhenti)": "Churned (Berhenti)",
  "Customer Akhir Bulan": "Customer Akhir Bulan",
  "assumes churn": "asumsi churn",
  "when none": "bila nol",
  "Benchmark SaaS Sehat: Churn < 5%/bln | LTV/CAC > 3x | NRR > 100% | MRR Growth > 15%/bln.": "Benchmark SaaS Sehat: Churn < 5%/bln | LTV/CAC > 3x | NRR > 100% | MRR Growth > 15%/bln.",
  "Customers, CAC spend and any MRR figure you type come from Report settings. A blank MRR actual is the revenue booked on the SBU's SaaS projects that month; a blank MRR budget is their revenue budget.": "Pelanggan, biaya CAC dan MRR yang Anda ketik berasal dari Pengaturan laporan. MRR aktual yang kosong = pendapatan yang dibukukan pada proyek SaaS SBU bulan itu; MRR budget kosong = anggaran pendapatannya.",
  "the report": "laporannya",
  "Report name on the banner": "Nama laporan di banner",
  "Subtitle": "Subjudul",
  "Closed through (month)": "Ditutup sampai (bulan)",
  "blank = last complete month": "kosong = bulan terakhir yang selesai",
  "Opening cash, 1 January (Rp)": "Kas awal, 1 Januari (Rp)",
  "Headcount (for revenue per employee)": "Jumlah karyawan (untuk pendapatan per karyawan)",
  "Income tax estimate (%)": "Estimasi pajak penghasilan (%)",
  "Churn assumed for LTV when nobody churned (%)": "Churn asumsi LTV bila tidak ada churn (%)",
  "Customers at the start of the year": "Pelanggan di awal tahun",
  "per linked project": "per proyek tertaut",
  "Kind decides where revenue and HPP land on the P&L: a client project or the SaaS product. Blank amounts fall back to what the system knows (shown faded).": "Jenis menentukan letak pendapatan dan HPP di L/R: proyek klien atau produk SaaS. Nilai kosong memakai angka dari sistem (ditampilkan pudar).",
  "Kind": "Jenis",
  "Client project": "Proyek klien",
  "SaaS product": "Produk SaaS",
  "Link projects on Model settings & drivers first.": "Tautkan proyek dulu di Pengaturan model & driver.",
  "month by month": "per bulan",
  "What the ledger cannot count. Leave MRR blank to use the SaaS projects' booked revenue and budget.": "Hal yang tidak bisa dihitung buku besar. Kosongkan MRR untuk memakai pendapatan dan anggaran proyek SaaS.",
  "New customers": "Pelanggan baru",
  "Churned": "Berhenti",
  "CAC spend (Rp)": "Biaya akuisisi (Rp)",
  "targets and notes": "target dan catatan",
  "Percentages in %. ‘Actual’ overrides the computed value (use it for what the ledger cannot measure, such as NRR). A blank note uses the automatic one.": "Persentase dalam %. ‘Aktual’ menggantikan nilai hitungan (pakai untuk yang tidak bisa diukur buku besar, seperti NRR). Catatan kosong memakai catatan otomatis.",
  "Better when": "Lebih baik bila",
  "Actual (override)": "Aktual (manual)",
  "Catatan": "Catatan",
  "higher": "lebih tinggi",
  "lower": "lebih rendah",
  "Add an action": "Tambah tindakan",
  "which accounts make each line": "akun pembentuk setiap baris",
  "Account code prefixes, comma separated; the longest match wins, so 5 on Others Cost only takes what no other HPP line claimed. Type - to leave a line empty. Anything left over lands on Other Operating Expense, so the P&L always adds up to the ledger.": "Awalan kode akun, dipisah koma; kecocokan terpanjang menang, jadi 5 pada Others Cost hanya mengambil yang tidak diklaim baris HPP lain. Ketik - untuk mengosongkan baris. Sisanya masuk Other Operating Expense, jadi L/R selalu sama dengan buku besar.",
  "Section": "Bagian",
  "Line label": "Label baris",
  "Account codes": "Kode akun",
  "Accounts found this year": "Akun yang ditemukan tahun ini",
  "Save report settings": "Simpan pengaturan laporan",
  "Report settings saved": "Pengaturan laporan disimpan",
  "Liquidity & Solvency": "Likuiditas & Solvabilitas",
  "Profitability": "Profitabilitas",
  "Operations & Projects": "Operasional & Proyek",
  "Cash vs Burn Rate": "Kas vs Burn Rate",
  "Outstanding Invoice": "Invoice Tertunggak",
  "Cash Position": "Posisi Kas",
  "Net Profit Margin": "Margin Laba Bersih",
  "EBITDA Margin": "Margin EBITDA",
  "Project Gross Margin": "Margin Kotor Proyek",
  "MRR vs Target": "MRR vs Target",
  "MRR Growth MoM": "Pertumbuhan MRR MoM",
  "Churn Rate": "Churn Rate",
  "LTV / CAC Ratio": "Rasio LTV / CAC",
  "NRR (Net Revenue Retention)": "NRR (Net Revenue Retention)",
  "Project Pipeline": "Pipeline Proyek",
  "Burn Rate (monthly)": "Burn Rate (bulanan)",
  "DSO — Days Sales Outstanding": "DSO — Days Sales Outstanding",
  "Revenue per Employee": "Pendapatan per Karyawan",
  "days": "hari",
  "Expense Breakdown": "Rincian Beban",
  "Devil in Detail — Petty Cash Monit & Grab Business Input": "Devil in Detail — Petty Cash Monit & Input Grab Business",
  "Whole year": "Setahun penuh",
  "Reading the ledger…": "Membaca buku besar…",
  "Petty Cash Monit usage": "Penggunaan Petty Cash Monit",
  "Money out of petty cash, by the cost account it was spent on.": "Uang keluar dari petty cash, menurut akun biaya tempat uang itu dipakai.",
  "No Petty Cash Monit account (1130) in this scope.": "Tidak ada akun Petty Cash Monit (1130) di cakupan ini.",
  "Grab Business Input usage": "Penggunaan Input Grab Business",
  "By type": "Per jenis",
  "By person": "Per orang",
  "Petty Cash Monit — money in and out": "Petty Cash Monit — uang masuk dan keluar",
  "Opening balance": "Saldo awal",
  "Money in (top-ups)": "Uang masuk (top-up)",
  "Money out (spent)": "Uang keluar (terpakai)",
  "Closing balance": "Saldo akhir",
  "movements": "mutasi",
  "on": "per",
  "In": "Masuk",
  "Out": "Keluar",
  "Where the money went (out)": "Ke mana uangnya pergi (keluar)",
  "Where it came from (in)": "Dari mana asalnya (masuk)",
  "Nothing spent in this period.": "Tidak ada pengeluaran di periode ini.",
  "No top-ups in this period.": "Tidak ada top-up di periode ini.",
  "Every movement": "Semua mutasi",
  "Every account": "Semua akun",
  "Search description or entry no.": "Cari keterangan atau no. jurnal",
  "Balance": "Saldo",
  "Show more": "Tampilkan lagi",
  "Share": "Porsi",
  "Everything else": "Lainnya",
  "Nothing matches.": "Tidak ada yang cocok.",
  "Grab Business Input — per person and per trip": "Input Grab Business — per orang dan per perjalanan",
  "Grab spending": "Belanja Grab",
  "rides, deliveries & orders": "perjalanan, kiriman & pesanan",
  "People": "Orang",
  "average": "rata-rata",
  "each": "per orang",
  "Average per transaction": "Rata-rata per transaksi",
  "Still owed to Grab": "Masih terutang ke Grab",
  "billed": "ditagih",
  "settled": "dilunasi",
  "no CORP PAY - GRAB account": "tidak ada akun CORP PAY - GRAB",
  "Per person": "Per orang",
  "Person": "Orang",
  "Group": "Grup",
  "Show this person's trips": "Tampilkan perjalanan orang ini",
  "Every transaction": "Semua transaksi",
  "Everyone": "Semua orang",
  "Search place, merchant, cost code…": "Cari tempat, merchant, kode biaya…",
  "Route / merchant": "Rute / merchant",
  "Cost code": "Kode biaya",
  "Booking ID": "Booking ID",
  "transactions": "transaksi",
  "Transport": "Transport",
  "Express": "Express",
  "Food": "Food",
  "No Grab bookings in this period.": "Tidak ada pemesanan Grab di periode ini.",
  "No Grab bookings in this period. Import the Grab for Business CSVs in Account Parsing → GRAB BUSINESS INPUT.": "Tidak ada pemesanan Grab di periode ini. Impor CSV Grab for Business di Account Parsing → INPUT GRAB BUSINESS.",
  "Devil in detail": "Devil in detail",
  "Petty Cash Monit and Grab, line by line": "Petty Cash Monit dan Grab, baris per baris",
  "GRAB BUSINESS INPUT": "INPUT GRAB BUSINESS",
  "Upload the Grab for Business CSV reports — Express, Transport and Food. You can pick all three at once.": "Unggah laporan CSV Grab for Business — Express, Transport dan Food. Ketiganya bisa dipilih sekaligus.",
  "Each booking becomes one entry: the date, the employee's name with the type of transaction as the description, and the right-most total on the row (what the company pays after any refund) as the amount.": "Setiap pemesanan menjadi satu jurnal: tanggal, nama karyawan beserta jenis transaksi sebagai keterangan, dan total paling kanan pada baris (yang dibayar perusahaan setelah refund) sebagai nilai.",
  "It is charged to the CORP PAY - GRAB cash account of the company — MDA by default — and debits the cost account: Food to Food & Beverage, Transport and Express to Transportation.": "Dibebankan ke akun kas CORP PAY - GRAB milik perusahaan — bawaan MDA — dan mendebit akun biaya: Food ke Makan & Minum, Transport dan Express ke Transportasi.",
  "Re-uploading is safe: bookings already posted are recognised by their Grab Booking ID.": "Aman diunggah ulang: pemesanan yang sudah dibukukan dikenali dari Booking ID Grab-nya.",
  "CSV file(s)": "File CSV",
  "Upload & parse": "Unggah & baca",
  "Charged to": "Dibebankan ke",
  "This company has no CORP PAY - GRAB account yet.": "Perusahaan ini belum punya akun CORP PAY - GRAB.",
  "Create CORP PAY - GRAB (cash)": "Buat CORP PAY - GRAB (kas)",
  "Account created": "Akun dibuat",
  "CORP PAY - GRAB account (charged) ": "Akun CORP PAY - GRAB (dibebankan) ",
  "Choose the Grab CSV file(s) first": "Pilih dulu file CSV Grab",
  "Parsing…": "Membaca…",
  "Contract value is what the project was sold for (set it on the project; blank falls back to its revenue budget). COGS is every cost account tagged to the project — the 5000 and 6000 families alike — so it matches the project's own expense figure. Gross profit is realized revenue less that cost.": "Nilai kontrak adalah harga jual proyek (atur di proyeknya; bila kosong dipakai anggaran pendapatannya). COGS adalah seluruh akun biaya yang ditandai ke proyek ini — keluarga 5000 maupun 6000 — sehingga sama dengan angka beban proyek itu sendiri. Laba kotor adalah pendapatan terealisasi dikurangi biaya tersebut.",
  "Reading size": "Ukuran baca",
  "Small": "Kecil",
  "Normal": "Normal",
  "Large": "Besar",
  "Extra large": "Sangat besar",
  "Sample": "Contoh",
  "This is how the app reads at this size.": "Beginilah tampilan aplikasi pada ukuran ini.",
  "Everything scales together — text, tables and charts — so columns keep lining up. Saved on this device, for every database you open.": "Semuanya berskala bersama — teks, tabel dan grafik — sehingga kolom tetap sejajar. Disimpan di perangkat ini, untuk semua database yang Anda buka.",
  "Contract value · COGS · Gross profit": "Nilai kontrak · COGS · Laba kotor",
  "per project": "per proyek",
  "Contract value": "Nilai kontrak",
  "Revenue realized": "Pendapatan terealisasi",
  "COGS total": "COGS total",
  "Other COGS": "COGS lainnya",
  "Contract value is what the project was sold for (set it on the project; blank falls back to its revenue budget). Gross profit is realized revenue less COGS — operating expense is a company cost and is not taken out here.": "Nilai kontrak adalah harga jual proyek (atur di proyeknya; bila kosong dipakai anggaran pendapatannya). Laba kotor adalah pendapatan terealisasi dikurangi COGS — beban operasional adalah biaya perusahaan dan tidak dikurangkan di sini.",
  "No contract value, revenue or COGS on any project yet.": "Belum ada nilai kontrak, pendapatan atau COGS di proyek mana pun.",
  "no contract value set on the project — its revenue budget is shown instead": "nilai kontrak belum diatur di proyek — yang ditampilkan anggaran pendapatannya",
  "no contract value set — showing the revenue budget": "nilai kontrak belum diatur — menampilkan anggaran pendapatan",
  "Contract value (Rp)": "Nilai kontrak (Rp)",
  "what the project was sold for — leave blank to use its revenue budget": "harga jual proyek — kosongkan untuk memakai anggaran pendapatannya",
  "Two shapes are read here. The PLAN TEMPLATE is written from your own database: every account and project is a drop-down and this year's budget is already in it, so a row reads \"5100-01 Direct Labor / Consultant Fees · project NX-01 · 25.000.000 · out · W2 December\". A HAND-KEPT CASH SHEET also works: the month over each block, W1..W4 under it, and a label with its amount in the next column (negative = money out).": "Dua bentuk bisa dibaca di sini. TEMPLATE RENCANA ditulis dari database Anda sendiri: tiap akun dan proyek berupa drop-down dan anggaran tahun ini sudah ada di dalamnya, sehingga satu baris berbunyi \"5100-01 Direct Labor / Consultant Fees · proyek NX-01 · 25.000.000 · keluar · W2 Desember\". SHEET KAS BUATAN SENDIRI juga bisa: bulan di atas tiap blok, W1..W4 di bawahnya, dan label dengan nominal di kolom sebelahnya (negatif = uang keluar).",
  "Either way it becomes a new Oracle scenario; your Budget Center is not touched.": "Keduanya menjadi skenario Oracle baru; Budget Center Anda tidak disentuh.",
  "Plan template": "Template rencana",
  "Used for a hand-kept sheet, and for any template row that leaves Certainty blank.": "Dipakai untuk sheet buatan sendiri, dan untuk baris template yang kolom Kepastiannya kosong.",
  "Every row carries its own account and project.": "Tiap baris membawa akun dan proyeknya sendiri.",
  "By account": "Per akun",
  "By week": "Per minggu",
  "Rows": "Baris",
  "and": "dan",
  "more accounts": "akun lainnya",
  "Export all projects": "Ekspor semua proyek",
  "One workbook with every project's budget, each row carrying its project code": "Satu workbook berisi anggaran semua proyek, tiap baris membawa kode proyeknya",
  "Put the rows on": "Tempatkan baris pada",
  "whatever each row's Project Code says": "sesuai Kode Proyek di tiap baris",
  "row": "baris",
  "rows": "baris",
  "Where the revenue goes": "Ke mana pendapatan pergi",
  "realization: revenue less every cost account booked to this project": "realisasi: pendapatan dikurangi seluruh akun biaya yang dibukukan ke proyek ini",
  "budget: the gross profit this project was promised to make": "anggaran: laba kotor yang dijanjikan proyek ini",
  "Gross profit": "Laba kotor",
  "Other costs": "Biaya lain-lain",
  "more cost accounts": "akun biaya lainnya",
  "cost accounts": "akun biaya",
  "Nothing posted to this project yet.": "Belum ada yang diposting ke proyek ini.",
  "Nothing budgeted on this project yet.": "Belum ada anggaran di proyek ini.",
  "All companies (consolidated)": "Semua perusahaan (konsolidasi)",
  "Show": "Tampilkan",
  "Lowest point": "Titik terendah",
  "at": "di",
  "buffer floor": "batas aman kas",
  "Four weeks a month, W4 runs to month end. Bound counts only committed money in, and committed + planned money out.": "Empat minggu sebulan, W4 sampai akhir bulan. Skenario Terikat hanya menghitung uang masuk yang dikomitmenkan, dan uang keluar yang dikomitmenkan + direncanakan.",
  "Consolidated adds every company together; the group verdict still follows the weakest company, because cash in one entity does not pay another's bills.": "Konsolidasi menjumlahkan semua perusahaan; putusan grup tetap mengikuti perusahaan terlemah, karena kas di satu entitas tidak membayar tagihan entitas lain.",
  "Import cashflow": "Impor arus kas",
  "Read a weekly cashflow sheet into a scenario": "Baca sheet arus kas mingguan menjadi skenario",
  "Import a cashflow projection": "Impor proyeksi arus kas",
  "Reads a weekly cash sheet — the month written over each block, W1..W4 under it, and beneath each week a label with its amount in the next column (negative = money out). It becomes a new Oracle scenario; your Budget Center is not touched.": "Membaca sheet kas mingguan — bulan di atas tiap blok, W1..W4 di bawahnya, dan di bawah tiap minggu label dengan nominal di kolom sebelahnya (negatif = uang keluar). Hasilnya menjadi skenario Oracle baru; Budget Center Anda tidak disentuh.",
  "Check the file": "Periksa file",
  "Create the scenario": "Buat skenario",
  "Scenario name": "Nama skenario",
  "e.g. Q4 cash drive": "mis. dorongan kas Q4",
  "Count money in as": "Hitung uang masuk sebagai",
  "Count money out as": "Hitung uang keluar sebagai",
  "Year, if the sheet does not say": "Tahun, bila sheet tidak menyebutkan",
  "cash items": "pos kas",
  "months": "bulan",
  "Money in": "Uang masuk",
  "Money out": "Uang keluar",
  "Items": "Pos",
  "Money in books to": "Uang masuk dibukukan ke",
  "money out to": "uang keluar ke",
  "Scenario created": "Skenario dibuat",
  "The sheet's own weekly balances add up: every week's opening plus its rows equals the next week's opening.": "Saldo mingguan sheet ini konsisten: saldo awal tiap minggu ditambah barisnya sama dengan saldo awal minggu berikutnya.",
  "The sheet does not add up week to week — it still imports, but check these:": "Sheet ini tidak konsisten antar minggu — tetap bisa diimpor, tapi periksa ini:",
  "Progress & outcome": "Kemajuan & hasil",
  "milestones done": "milestone selesai",
  "no milestones yet": "belum ada milestone",
  "of the weighted plan is done": "dari rencana berbobot sudah selesai",
  "Add the milestones this investment must hit — progress is measured against them, not against how much money has left.": "Tambahkan milestone yang harus dicapai investasi ini — kemajuan diukur dari situ, bukan dari berapa uang yang sudah keluar.",
  "scheduled": "terjadwal",
  "Paid so far": "Dibayar sejauh ini",
  "of committed": "dari komitmen",
  "Still to pay": "Sisa yang harus dibayar",
  "Outcome": "Hasil",
  "of money spent": "dari uang yang dikeluarkan",
  "nothing spent yet": "belum ada pengeluaran",
  "Milestone": "Milestone",
  "Due": "Jatuh tempo",
  "Weight": "Bobot",
  "No milestones yet": "Belum ada milestone",
  "Milestone — e.g. pilot signed off": "Milestone — mis. pilot disetujui",
  "Add milestone": "Tambah milestone",
  "Due date": "Tanggal jatuh tempo",
  "Remove this milestone?": "Hapus milestone ini?",
  "Give the milestone a name": "Beri nama milestone",
  "done": "selesai",
  "INVESTMENT": "INVESTASI",
  "Open in Investment Center": "Buka di Investment Center",
  "Funded as an investment — click to open it": "Didanai sebagai investasi — klik untuk membuka",
  "This project is funded as an investment. Its payments are planned in the Investment Center, and the Oracle already counts them as cash leaving on those weeks.": "Proyek ini didanai sebagai investasi. Pembayarannya direncanakan di Investment Center, dan Oracle sudah menghitungnya sebagai kas keluar pada minggu-minggu tersebut.",
  "Cashflow payments": "Pembayaran arus kas",
  "No payment schedule yet — set one in the Investment Center so the Oracle knows when this money leaves.": "Belum ada jadwal pembayaran — atur di Investment Center agar Oracle tahu kapan uang ini keluar.",
  "Committed but not scheduled": "Dikomitmenkan tapi belum terjadwal",
  "Jakarta Office Expense Breakdown": "Rincian Biaya Kantor Jakarta",
  "Nothing was imported — fix these and try again:": "Tidak ada yang diimpor — perbaiki ini lalu coba lagi:",
  "All SBUs": "Semua SBU",
  "Back to all SBUs": "Kembali ke semua SBU",
  "— all SBUs —": "— semua SBU —",
  "Switch SBU": "Ganti SBU",
  "Open": "Buka",
  "Excel model": "Model Excel",
  "Blank template": "Template kosong",
  "Import Excel": "Impor Excel",
  "Download this SBU's whole model as a workbook": "Unduh seluruh model SBU ini sebagai workbook",
  "Stage": "Tahap",
  "From an Excel file": "Dari file Excel",
  "Click an SBU to open it. The selector at the top switches SBU from any tab.": "Klik SBU untuk membukanya. Pemilih di atas mengganti SBU dari tab mana pun.",
  "Upload an SBU model workbook. It replaces this SBU's drivers, cost lines, one-offs, CAPEX and linked projects with what the file says.": "Unggah workbook model SBU. Isinya menggantikan asumsi, pos biaya, pos sekali jalan, CAPEX dan proyek tertaut SBU ini.",
  "Upload a filled-in SBU model workbook to create a new SBU from it.": "Unggah workbook model SBU yang sudah diisi untuk membuat SBU baru.",
  "Download this SBU as a workbook first": "Unduh SBU ini sebagai workbook dulu",
  "Download the blank template": "Unduh template kosong",
  "Company, when the file does not name one": "Perusahaan, bila file tidak menyebutkannya",
  "Excel file": "File Excel",
  "Import": "Impor",
  "Import the SBU model from Excel": "Impor model SBU dari Excel",
  "New SBU from Excel": "SBU baru dari Excel",
  "Reading the file…": "Membaca file…",
  "This replaces the SBU's whole model with the file's. Continue?": "Ini menggantikan seluruh model SBU dengan isi file. Lanjutkan?",
  "Nothing was imported — fix these and upload again:": "Tidak ada yang diimpor — perbaiki ini lalu unggah lagi:",
  "Imported": "Diimpor",
  "cost lines": "pos biaya",
  "one-offs": "pos sekali jalan",
  "linked projects": "proyek tertaut",
  "SBU": "SBU", "Strategic Business Unit · is it good, and does it make real profit?": "Unit Bisnis Strategis · apakah bagus, dan benar-benar menghasilkan untung?",
  "Launch an SBU": "Luncurkan SBU", "No SBUs yet.": "Belum ada SBU.", "Start from a blank SBU": "Mulai dari SBU kosong",
  "SBU name": "Nama SBU", "A blank SBU": "SBU kosong", "SBU launched": "SBU diluncurkan", "The SBU": "SBU ini",
  "Ledger projects this SBU spends from": "Proyek di buku besar yang dipakai SBU ini",
  "Delete SBU": "Hapus SBU", "SBU deleted": "SBU dihapus",
  "Cost Breakdown — Realization vs Plan": "Rincian Biaya — Realisasi vs Rencana",
  "By category · full year": "Per kategori · setahun penuh", "By account · realized": "Per akun · realisasi",
  "Other accounts": "Akun lainnya", "Operating cost": "Biaya operasional", "Realization": "Realisasi",
  "Plan": "Rencana", "realized": "terealisasi", "is non-cash and sits outside the donut.": "bersifat non-kas dan tidak masuk donat.",
  "Nothing is booked in the ledger for this year yet — every month is forecast. Switch to ‘By category’ to see the plan.":
    "Belum ada yang dibukukan tahun ini — semua bulan masih proyeksi. Pilih ‘Per kategori’ untuk melihat rencana.",
  "No cost is planned for this year.": "Tidak ada biaya direncanakan tahun ini.",
  "Active Loan": "Pinjaman Aktif", "from Payables": "dari Utang", "open bill(s)": "tagihan terbuka",
  "overdue": "jatuh tempo", "Active loan": "Pinjaman aktif",
  "Show or hide the Active Loan tile (taken from the Payables module)": "Tampilkan atau sembunyikan kartu Pinjaman Aktif (diambil dari modul Utang)",
  "Product Finance": "Keuangan Produk", "Product Finance Analysis": "Analisis Keuangan Produk",
  "is the product good, and does it make real profit?": "apakah produknya bagus, dan benar-benar menghasilkan untung?",
  "Launch a product": "Luncurkan produk", "Launch": "Luncurkan", "No products yet.": "Belum ada produk.",
  "Overview": "Ringkasan", "P&L by month": "Laba rugi per bulan", "SaaS metrics": "Metrik SaaS",
  "Server cost": "Biaya server", "Target & marketing": "Target & marketing", "Settings & drivers": "Pengaturan & asumsi",
  "Running the numbers…": "Menghitung…",
  "PROFITABLE": "UNTUNG", "RUN-RATE PROFITABLE · NOT PAID BACK": "UNTUNG BULANAN · BELUM BALIK MODAL",
  "Making money month by month by the target, but the cash spent getting there is not back yet":
    "Sudah untung per bulan pada target, tapi kas yang dikeluarkan untuk sampai ke sana belum kembali",
  "Making money month by month by the target, and every rupiah spent getting there is back":
    "Sudah untung per bulan pada target, dan semua kas yang dikeluarkan sudah kembali",
  "Still losing money in the target month": "Masih rugi pada bulan target",
  "NOT PROFITABLE": "BELUM UNTUNG", "NO DATA": "BELUM ADA DATA",
  "idea": "ide", "build": "pengembangan", "launch": "peluncuran", "growth": "pertumbuhan", "sunset": "dihentikan",
  "Break-even month": "Bulan impas", "Cash payback": "Balik modal kas", "Funding required": "Dana yang dibutuhkan",
  "Burn budget · runway": "Anggaran bakar · runway", "Active users": "Pengguna aktif", "Gross margin": "Margin kotor",
  "Net burn": "Net burn", "Runway": "Runway", "Churn": "Churn", "CAC payback": "Balik modal CAC",
  "Actual through": "Aktual sampai", "actual": "aktual", "forecast": "proyeksi", "forecast months": "bulan proyeksi",
  "target": "target", "cost": "biaya", "profit / (loss)": "laba / (rugi)", "Profit / (loss)": "Laba / (rugi)",
  "margin": "margin", "Margin": "Margin", "Opex": "Biaya operasional", "Depreciation": "Penyusutan",
  "Net cash": "Kas bersih", "Cumulative cash": "Kas kumulatif", "Cumulative profit": "Laba kumulatif",
  "Year by year": "Per tahun", "Where the money goes": "Ke mana uangnya pergi", "Basis": "Dasar",
  "Profit & loss, month by month": "Laba rugi, bulan demi bulan",
  "Server & infrastructure": "Server & infrastruktur", "Revenue & users": "Pendapatan & pengguna",
  "Cost lines (forecast)": "Pos biaya (proyeksi)", "One-off items": "Pos sekali jalan",
  "Ledger projects this product spends from": "Proyek di buku besar yang dipakai produk ini",
  "Save & re-run the analysis": "Simpan & hitung ulang", "Delete product": "Hapus produk",
  "Growth ladder": "Tangga pertumbuhan", "Burn": "Pembakaran dana",
  "Active users needed": "Pengguna aktif yang dibutuhkan", "New users per month": "Pengguna baru per bulan",
  "CAC ceiling": "Batas atas CAC", "Gap to close": "Selisih yang harus ditutup",
  "What marketing has to deliver for the product to be profitable by": "Yang harus dicapai marketing agar produk untung pada",
  "ENOUGH": "CUKUP", "NOT ENOUGH": "TIDAK CUKUP", "YES": "YA", "no": "tidak",
  "A budget exists for this year": "Anggaran tahun ini sudah ada",
  "Contracted revenue is marked 'committed'": "Pendapatan terkontrak sudah ditandai 'terkontrak'",
  "Every company has a minimum cash floor": "Tiap perusahaan punya batas kas minimum",
  "Investment commitments carry a schedule": "Komitmen investasi punya jadwal",
  "Open receivables have a payment history": "Piutang terbuka punya riwayat pembayaran",
  "Accounts say how they move cash": "Akun menyatakan cara menggerakkan kas",
  "Open Budget Center": "Buka Pusat Anggaran",
  "Set certainty in Budget Center": "Atur kepastian di Pusat Anggaran",
  "Open Cash policy": "Buka Kebijakan kas",
  "Open Investment Center": "Buka Investment Center",
  "Open Receivables": "Buka Piutang",
  "Settings → Budget & Oracle": "Pengaturan → Anggaran & Ahli Nujum",
  "Before the answer means anything": "Sebelum jawabannya berarti apa-apa",
  "Everything the Oracle needs is set.": "Semua yang dibutuhkan Ahli Nujum sudah diatur.",
  "blocking": "menghalangi", "assumptions in play": "asumsi sedang dipakai",
  "A forecast is only as honest as what it was given. These six things decide whether the verdict is a finding or an artefact of missing data — read from your live database, not from a manual.":
    "Ramalan hanya sejujur data yang diberikan. Enam hal ini menentukan apakah putusannya temuan atau sekadar akibat data yang kurang — dibaca dari database Anda, bukan dari buku manual.",
  "What the Oracle actually does": "Apa yang sebenarnya dikerjakan Ahli Nujum",
  "It takes the budget your finance team already set, turns every line into a dated movement of cash, adds the receivables, payables and investment commitments already on the books, and then runs the year day by day to answer one question: does cash ever fall below the line you said it must never fall below?":
    "Ia mengambil anggaran yang sudah disusun tim keuangan, mengubah tiap baris menjadi pergerakan kas bertanggal, menambahkan piutang, utang dan komitmen investasi yang sudah tercatat, lalu menjalankan setahun hari demi hari untuk menjawab satu pertanyaan: apakah kas pernah jatuh di bawah batas yang Anda tetapkan?",
  "It is a forecast, not a record. That is why this section is a different colour from the rest of the console — the books are teal, the Oracle is not, and nothing here has been posted to anything.":
    "Ini ramalan, bukan catatan. Itu sebabnya bagian ini berbeda warna dari sisa konsol — pembukuan berwarna tosca, Ahli Nujum tidak, dan tidak ada apa pun di sini yang diposting ke mana pun.",
  "The five steps": "Lima langkah",
  "Budget the year, by week": "Anggarkan setahun, per minggu",
  "Say how sure each line is": "Nyatakan seberapa pasti tiap baris",
  "Say how low cash is allowed to go": "Nyatakan sampai serendah apa kas boleh turun",
  "Date the money that is already promised": "Beri tanggal pada uang yang sudah dijanjikan",
  "Read the verdict, then act on it": "Baca putusannya, lalu tindak lanjuti",
  "Set certainty": "Atur kepastian",
  "Certainty — which money counts, and where": "Kepastian — uang mana yang dihitung, dan di mana",
  "This table is the whole engine in six rows. A run only counts a line if its certainty appears in that run's column.":
    "Tabel ini adalah seluruh mesinnya dalam enam baris. Sebuah run hanya menghitung baris bila kepastiannya muncul di kolom run itu.",
  "Means": "Artinya", "the verdict": "putusannya",
  "out only": "hanya keluar", "in only": "hanya masuk",
  "in at half weight, + out": "masuk dengan bobot separuh, + keluar",
  "Signed, contracted, already owed.": "Ditandatangani, terkontrak, sudah terutang.",
  "Budgeted, not yet signed.": "Dianggarkan, belum diteken.",
  "Likely, unsigned.": "Mungkin, belum diteken.", "Pipeline, a hope.": "Pipeline, sebatas harapan.",
  "Read the Bound column twice. 'Planned' is an outflow but never an inflow — money you intend to spend counts against you, money you merely hope to receive does not count for you. That asymmetry is the point of the whole tool.":
    "Baca kolom Bound dua kali. 'Direncanakan' dihitung sebagai uang keluar tapi tidak pernah sebagai uang masuk — uang yang berniat Anda belanjakan memberatkan Anda, uang yang baru Anda harapkan tidak menguntungkan Anda. Ketimpangan itulah inti alat ini.",
  "The four verdicts": "Empat putusan",
  "Cash goes below zero. A payment will not clear.": "Kas jatuh di bawah nol. Ada pembayaran yang tidak akan cair.",
  "Cash stays positive but breaks the buffer floor.": "Kas tetap positif tapi menembus batas aman.",
  "Inside the floor but with little room, or the Base run breaches.": "Masih di atas batas tapi tipis, atau run Base menembusnya.",
  "Headroom stays above 25% of the floor every day.": "Ruang aman tetap di atas 25% batas setiap hari.",
  "The verdict is always taken from the Bound run, and always from the worst entity.":
    "Putusan selalu diambil dari run Bound, dan selalu dari entitas terburuk.",
  "The words on the screen": "Istilah di layar",
  "Buffer floor": "Batas aman kas", "Headroom": "Ruang aman", "Safe period": "Periode aman",
  "Bound / Base / Optimistic": "Bound / Base / Optimistic",
  "Pessimistic settlement": "Penyelesaian pesimistis", "Cash pooling: off": "Cash pooling: mati",
  "Reading Sensitivity & crisis": "Membaca Sensitivitas & krisis",
  "Tornado": "Tornado", "Break-even": "Titik impas", "Crisis": "Krisis", "The 5 × 5 grid": "Kisi 5 × 5",
  "If the plan already breaches with no stress applied, sensitivity says so instead of printing a break-even. There is no margin to measure when you are already through the floor.":
    "Bila rencana sudah tembus tanpa tekanan apa pun, sensitivitas menyatakannya alih-alih mencetak titik impas. Tidak ada margin untuk diukur kalau Anda sudah menembus batas.",
  "When the answer looks wrong": "Kalau jawabannya terlihat salah",
  "Reading": "Membaca", "Live budget (Budget Center)": "Anggaran hidup (Pusat Anggaran)",
  "Freeze as scenario": "Bekukan jadi skenario", "Frozen": "Dibekukan",
  "Name this frozen scenario": "Beri nama skenario beku ini", "Budget snapshot": "Salinan anggaran",
  "Keep a copy of the budget exactly as it is today, so this verdict can be quoted against it later":
    "Simpan salinan anggaran persis seperti hari ini, agar putusan ini bisa dirujuk nanti",
  "Budget Center": "Pusat Anggaran", "Company level": "Level perusahaan",
  "Per project": "Per proyek", "Weekly (4 weeks a month)": "Mingguan (4 minggu sebulan)",
  "Month roll-up": "Rekap bulanan", "Monthly → Week 1": "Bulanan → Minggu 1",
  "Move each month's whole budget into its first week": "Pindahkan seluruh anggaran tiap bulan ke minggu pertama",
  "Move every month's whole budget into its first week? Existing week 2-4 amounts are folded into week 1, not lost.":
    "Pindahkan seluruh anggaran tiap bulan ke minggu pertama? Nilai minggu 2-4 dilipat ke minggu 1, tidak hilang.",
  "PENDAPATAN · Revenue": "PENDAPATAN", "BEBAN · Expense": "BEBAN",
  "Certainty": "Kepastian", "Year": "Tahun", "Net": "Neto",
  "committed": "terkontrak", "planned": "direncanakan", "expected": "diperkirakan",
  "speculative": "spekulatif", "mixed": "campuran",
  "weekly cells": "sel mingguan", "Budget saved": "Anggaran disimpan",
  "Projects belong to the selected company. The budget below is for this project only.":
    "Proyek mengikuti perusahaan yang dipilih. Anggaran di bawah hanya untuk proyek ini.",
  "Amounts are in IDR. Certainty drives the Oracle: only 'committed' money in counts in the Bound run.":
    "Nilai dalam IDR. Kepastian menentukan Ahli Nujum: hanya uang masuk 'terkontrak' yang dihitung di run Bound.",
  "choose account to add": "pilih akun untuk ditambah",
  "choose account to remove": "pilih akun untuk dihapus",
  "Add account to budget": "Tambah akun ke anggaran",
  "Remove account from budget": "Hapus akun dari anggaran",
  "removed from budget": "dihapus dari anggaran", "from the": "dari", "budget?": "anggaran?",
  "Create a project in this company to budget for it.": "Buat proyek di perusahaan ini untuk menganggarkannya.",
  "(no projects in this company yet)": "(belum ada proyek di perusahaan ini)",
  "Pick or create a project first": "Pilih atau buat proyek dulu", "Pick a project first": "Pilih proyek dulu",
  "No budget lines yet — add accounts below or import from Excel":
    "Belum ada baris anggaran — tambah akun di bawah atau impor dari Excel",
  "No budget defined for": "Belum ada anggaran untuk",
  "data to": "data s/d", "Data complete to (date)": "Data lengkap sampai (tanggal)",
  "Leave empty if this database is kept current. Shown next to the database name everywhere.":
    "Kosongkan jika database ini selalu terkini. Ditampilkan di samping nama database.",
  "Monthly budget \u2192 weekly cash plan": "Anggaran bulanan \u2192 rencana kas mingguan",
  "Where a month of budget lands when it is converted into weeks. This is what the Oracle reads.":
    "Di minggu mana anggaran satu bulan jatuh saat dikonversi. Inilah yang dibaca Ahli Nujum.",
  "Convert every monthly budget into weeks now": "Konversi semua anggaran bulanan menjadi mingguan sekarang",
  "Reads the company-level and project-level budgets for": "Membaca anggaran level perusahaan dan level proyek untuk",
  "and writes them into the plan version below, using the setting above. Existing cells for the same account and week are overwritten; nothing else in the plan is touched.":
    "lalu menuliskannya ke versi rencana di bawah, memakai pengaturan di atas. Sel yang sama (akun dan minggu) ditimpa; sisanya tidak disentuh.",
  "Plan version": "Versi rencana", "cells": "sel",
  "Convert budget \u2192 cash plan": "Konversi anggaran \u2192 rencana kas",
  "No draft or submitted plan version for": "Tidak ada versi rencana draft/submitted untuk",
  "Create one in Budgets \u2192 Cash Plan (weekly) first.": "Buat dulu di Anggaran \u2192 Rencana Kas (mingguan).",
  "Convert every monthly budget line for": "Konversi semua baris anggaran bulanan tahun",
  "into the selected plan version?": "ke versi rencana yang dipilih?",
  "plan cells written": "sel rencana ditulis", "Conversion setting saved": "Pengaturan konversi disimpan",
  "How each account moves cash": "Bagaimana tiap akun menggerakkan kas",
  "Only 'operating' expenses count towards the buffer floor. Depreciation and other non-cash lines must be marked 'noncash' or the Oracle will demand a cash buffer for money that never leaves the bank.":
    "Hanya beban 'operating' yang dihitung ke batas aman kas. Penyusutan dan baris non-kas lain harus ditandai 'noncash', kalau tidak Ahli Nujum menuntut cadangan kas untuk uang yang tidak pernah keluar bank.",
  "Cash-flow class": "Kelas arus kas", "\u2014 unset \u2014": "\u2014 belum diatur \u2014",
  "accounts updated": "akun diperbarui",
  "Four week buckets every month — W4 runs to the end of the month, so no plan line can ever land in a week that does not exist.":
    "Empat kantong minggu setiap bulan — W4 berjalan sampai akhir bulan, jadi tidak ada baris rencana yang bisa jatuh di minggu yang tidak ada.",
  "Months of cover": "Bulan Cadangan", "Minimum cash": "Kas Minimum",
  "Company": "Perusahaan", "Floor in force": "Batas Berlaku",
  "Fixed cash opex / month": "Biaya Tetap Kas / bulan",
  "Open the Oracle": "Buka Oracle",
  "none — this axis changes nothing here": "nihil — sumbu ini tidak mengubah apa pun",
  "No break-even to report: the plan already breaches with no stress applied.": "Tidak ada titik impas: rencana sudah tembus tanpa tekanan apa pun.", "Click an account to see its transactions.": "Klik akun untuk melihat transaksinya.",
  // Money Tracker
  "Money Tracker": "Pelacak Uang", "invoicing process per project": "proses penagihan per proyek",
  "New invoice track": "Tagihan Baru", "Total tracked": "Total Dilacak", "In process": "Dalam Proses",
  "Received": "Diterima", "Current phase": "Fase Saat Ini", "Progress": "Progres",
  "Mark done / advance phase": "Tandai selesai / lanjut fase", "or jump to": "atau lompat ke",
  "Move": "Pindah", "Phase history": "Riwayat Fase", "Phase": "Fase", "Plan": "Rencana",
  "Entered": "Masuk", "Est. end": "Perkiraan Selesai", "Completed": "Selesai", "Project": "Proyek",
  "Notes": "Catatan", "Notes & context for this phase": "Catatan & konteks fase ini",
  "No notes for this phase yet.": "Belum ada catatan untuk fase ini.",
  "Add context for this phase…": "Tambah konteks untuk fase ini…", "Add": "Tambah",
  "Comments": "Komentar", "Write a message…": "Tulis pesan…", "Add comment": "Kirim Komentar",
  "Project status": "Status Proyek", "Active": "Aktif", "On hold": "Ditahan",
  "Cancelled": "Dibatalkan", "Done": "Selesai", "Project cancelled": "Proyek Dibatalkan",
  // Accountant section
  "Accountant Section": "Bagian Akuntan",
  "audit view · all companies": "tampilan audit · semua perusahaan",
  // wallet/card Excel template + format guide
  "Download Excel template": "Unduh Template Excel",
  "Format guide": "Panduan Format",
  "The template has the exact columns plus a Format Guide sheet.": "Template berisi kolom yang tepat plus lembar Panduan Format.",
  "Wallet / Card Excel — Format guide": "Excel Wallet / Kartu — Panduan Format",
  "Booking rules": "Aturan Pembukuan",
  // dashboard revenue/COGS attribution toggle
  "By project company": "Per perusahaan proyek",
  "By booking entity": "Per entitas pembukuan",
  "Revenue & COGS follow the project's company (management view) or stay with the booking entity (legal view).":
    "Pendapatan & HPP mengikuti perusahaan proyek (tampilan manajemen) atau tetap di entitas pembukuan (tampilan legal).",
  // weekly cash flow + cash budget
  "Monthly": "Bulanan", "Weekly": "Mingguan",
  "Weekly Cash — Actual vs Budget": "Kas Mingguan — Aktual vs Anggaran",
  "Weekly Cash Flow": "Arus Kas Mingguan", "set the cash budget by week": "atur anggaran kas per minggu",
  "Save Cash Budget": "Simpan Anggaran Kas",
  "Pick a single company to set the weekly cash budget": "Pilih satu perusahaan untuk mengatur anggaran kas mingguan",
  "Week": "Minggu", "Period": "Periode", "Actual In": "Kas Masuk Aktual", "Actual Out": "Kas Keluar Aktual",
  "Net": "Bersih", "Ending": "Saldo Akhir", "Budget In": "Anggaran Masuk", "Budget Out": "Anggaran Keluar",
  "Budget Ending": "Saldo Anggaran", "Variance": "Selisih",
  "Actual closing": "Saldo Akhir Aktual", "Budget closing": "Saldo Akhir Anggaran",
  "Cash Flow — Actual vs Budget (Weekly)": "Arus Kas — Aktual vs Anggaran (Mingguan)",
  "Cumulative cash position — realization vs the weekly cash budget.": "Posisi kas kumulatif — realisasi vs anggaran kas mingguan.",
  "Set a weekly cash budget in Reports → Cash Flow → Weekly to compare against the budget line.": "Atur anggaran kas mingguan di Laporan → Arus Kas → Mingguan untuk membandingkan dengan garis anggaran.",
  // budget vs realization tabs
  "Revenue": "Pendapatan", "Expenses": "Beban", "Budget": "Anggaran", "Realization": "Realisasi",
  "Variance vs Target": "Selisih vs Target", "Over / (Under)": "Lebih / (Kurang)",
  "Achieved": "Tercapai", "Used": "Terpakai",
  "Realization = posted actuals (Realisasi)": "Realisasi = aktual yang sudah diposting",
  "Revenue target (budget) vs realization. Green = at or above target.": "Target pendapatan (anggaran) vs realisasi. Hijau = mencapai atau melebihi target.",
  "Expense budget vs realization. Green = at or under budget; red = overspent.": "Anggaran beban vs realisasi. Hijau = sesuai atau di bawah anggaran; merah = melebihi anggaran.",
  "No revenue budget": "Belum ada anggaran pendapatan", "No expense budget": "Belum ada anggaran beban",
  // change password
  "Change password": "Ubah Kata Sandi", "Current password": "Kata Sandi Saat Ini",
  "New password": "Kata Sandi Baru", "Confirm new password": "Konfirmasi Kata Sandi Baru",
  "at least 6 characters": "minimal 6 karakter",
  "New password must be at least 6 characters.": "Kata sandi baru minimal 6 karakter.",
  "New passwords do not match.": "Kata sandi baru tidak cocok.", "Password changed": "Kata sandi berhasil diubah",
  // common buttons
  "Apply": "Terapkan", "Export Excel": "Ekspor Excel", "Export PDF": "Ekspor PDF",
};
function t(s) { return state.lang === "id" ? (TR[s] || s) : s; }

// nav routes -> [icon glyph, English label]
// "13 June 2026 14.23" — created_at is stored in UTC, shown in local time
const MONTHS_FULL = {
  en: ["January", "February", "March", "April", "May", "June", "July",
       "August", "September", "October", "November", "December"],
  id: ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
       "Agustus", "September", "Oktober", "November", "Desember"],
};
function fmtInputStamp(ts) {
  if (!ts) return "";
  const d = new Date(String(ts).replace(" ", "T") + (String(ts).endsWith("Z") ? "" : "Z"));
  if (isNaN(d)) return String(ts);
  const p2 = n => String(n).padStart(2, "0");
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}.${p2(d.getMinutes())}`;
}

const NAV_ITEMS = [
  // HV sections
  ["dashboard", "▦", "Dashboard"], ["projecthv", "◉", "Project HV"],
  ["projects", "△", "Project Details"], ["money", "◈", "Money Tracker"],
  ["investments", "✦", "Investment Center"], ["oracle", "☾", "The Oracle"],
  ["product", "◇", "SBU"],
  // Devil in Detail
  ["journals", "☰", "Journal Entries"], ["expenses", "◔", "Expense Breakdown"], ["bank", "⇄", "Account Parsing"],
  ["receivables", "◰", "Receivables"], ["payables", "◱", "Payables"],
  ["budgets", "◎", "Budget Center"], ["reports", "▤", "Reports"],
  ["accountant", "⚖", "Accountant Section"],
  // Admin panel
  ["settings", "⚙", "Settings"],
];
// left-nav grouping headers (data-sec on each link/header in app.html)
const NAV_SECTIONS = { hv: "HV Sections", detail: "Devil in Detail", admin: "Admin Panel" };
function relabelChrome() {
  // per-user menu access: 'all' or a CSV of allowed routes. Admins always see
  // everything; Settings stays admin-only via its own gate below.
  const ma = (state.me && state.me.menu_access) || "all";
  const allowed = ma === "all" ? null : new Set(String(ma).split(",").map(s => s.trim()));
  $$("#nav a").forEach(a => {
    const item = NAV_ITEMS.find(n => n[0] === a.dataset.route);
    if (item) a.innerHTML = `${item[1]} <span class="nav-t">${esc(t(item[2]))}</span>`;
    const route = a.dataset.route;
    const hide = !isAdmin() && allowed && route !== "settings" && !allowed.has(route);
    a.style.display = hide ? "none" : "";
  });
  // section headers: translate, and hide a header whose links are all hidden
  $$("#nav .nav-sec").forEach(h => {
    const sec = h.dataset.sec;
    h.textContent = t(NAV_SECTIONS[sec] || sec);
    const any = $$(`#nav a[data-sec="${sec}"]`).some(a => a.style.display !== "none");
    h.style.display = any ? "" : "none";
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
    <span class="muted">${esc(ROLE_LABELS[state.me.role] || state.me.role)}</span>
    <a href="#" id="changePw" class="userbox-link">${t("Change password")}</a>`;
  $("#changePw").onclick = (e) => { e.preventDefault(); changePasswordModal(); };
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

function changePasswordModal() {
  openModal(`<div class="form-col" style="display:flex;flex-direction:column;gap:12px">
    <label>${t("Current password")} <input type="password" id="pwCur" autocomplete="current-password"></label>
    <label>${t("New password")} <input type="password" id="pwNew" autocomplete="new-password" placeholder="${t("at least 6 characters")}"></label>
    <label>${t("Confirm new password")} <input type="password" id="pwNew2" autocomplete="new-password"></label>
    <div id="pwErr" style="color:var(--red);font-size:12.5px;min-height:16px"></div>
    <div class="form-actions"><button class="btn btn-primary" id="pwSave">${t("Change password")}</button></div>
  </div>`, { title: t("Change password"), small: true });
  $("#pwSave").onclick = async () => {
    const n1 = $("#pwNew").value, n2 = $("#pwNew2").value, err = $("#pwErr");
    if (n1.length < 6) { err.textContent = t("New password must be at least 6 characters."); return; }
    if (n1 !== n2) { err.textContent = t("New passwords do not match."); return; }
    try {
      await api("/api/me/password", { json: { current_password: $("#pwCur").value, new_password: n1 } });
      toast(t("Password changed")); closeModal();
    } catch (e) { err.textContent = e.message; }
  };
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
  dashboard: pageDashboard, projecthv: pageProjectHV, journals: pageJournals, expenses: pageExpenses,
  bank: pageBank, receivables: pageReceivables, payables: pagePayables, budgets: pageBudgets,
  investments: pageInvestments, oracle: pageOracle, product: pageProduct,
  projects: pageProjects, money: pageMoneyTracker,
  reports: pageReports, accountant: pageAccountant, settings: pageSettings,
};
const INV_CATEGORIES = {
  scholarship: "Scholarship", partnership: "Partnership", rnd: "R&D",
  csr: "CSR", strategic: "Strategic", other: "Other",
};

async function render() {
  const route = (location.hash || "#/dashboard").replace("#/", "").split("?")[0] || "dashboard";
  // the current page is stamped on <html> so a section can carry its own palette
  document.documentElement.dataset.page = route;
  $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === route));
  const fn = routes[route] || pageDashboard;
  const el = $("#content");
  el.innerHTML = `<div class="empty">Loading…</div>`;
  try { await fn(el); } catch (e) { el.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; }
}

/* ------------------------------------------------------------------ dashboard */
async function pageDashboard(el) {
  if (!state.dashAttr) state.dashAttr = "project";
  const d = await api(`/api/reports/dashboard?${scopeQS()}&attribution=${state.dashAttr}`);
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
  // Expense breakdown shows only the Operating Expenses group (6000) and its
  // subsidiaries (61xx–69xx); COGS (5xxx), interest (72xx) and C-AKUN (73xx) are excluded.
  const opexRows = d.expense_breakdown.filter(r => String(r.code).startsWith("6"));
  // Office Expense = rent (6200) + utilities (6300) + office & admin group (66xx, incl. bank admin fees)
  const officeRows = opexRows.filter(r => ["6200", "6300"].includes(r.code) || String(r.code).startsWith("66"));
  const officeActual = round2(officeRows.reduce((a, r) => a + r.actual, 0));
  const officeBudget = round2(officeRows.reduce((a, r) => a + r.budget, 0));
  const officeUsed = officeBudget ? Math.round(100 * officeActual / officeBudget) : null;
  // C-AKUN: parent account 7300 and its children (7300-01 … 7300-04) — budget vs realization
  const caktRows = d.expense_breakdown
    .filter(r => String(r.code).startsWith("73") && String(r.code) !== "7300")
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const caktActual = round2(caktRows.reduce((a, r) => a + r.actual, 0));
  const caktBudget = round2(caktRows.reduce((a, r) => a + r.budget, 0));
  const caktUsed = caktBudget ? Math.round(100 * caktActual / caktBudget) : null;
  // company-information resume tiles — admins choose which show (Settings →
  // Dashboard). d.kpi_visible is the allow-list of keys; null/empty = show all.
  const KPI_TILES = [
    ["revenue_ytd", kpi(t("Revenue YTD"), k.revenue_ytd)],
    ["net_profit", kpi(t("Net Profit"), k.net_profit_ytd, k.net_profit_ytd >= 0 ? "green" : "red", `Margin ${k.margin_pct}%`)],
    ["gross_margin", kpiv(t("Gross Margin"), fmtPct(k.gross_margin), st("gross_margin"), `target ≥ ${fmtPct((hb.gross_margin || {}).target)}`)],
    ["operating_profit", kpi(t("Operating Profit"), k.operating_profit, k.operating_profit >= 0 ? "green" : "red")],
    ["cash_buffer", kpiv(t("Cash Buffer"), fmtMonths(k.cash_buffer_months), st("cash_buffer_months"), `target ≥ ${fmtMonths((hb.cash_buffer_months || {}).target)}`)],
    ["dso", kpiv(t("DSO"), fmtDays(k.dso_days), st("dso_days"), `target ≤ ${fmtDays((hb.dso_days || {}).target)}`)],
    ["current_ratio", kpiv(t("Current Ratio"), fmtRatio(k.current_ratio), st("current_ratio"), `target ≥ ${fmtRatio((hb.current_ratio || {}).target)}`)],
    ["working_capital", kpi(t("Working Capital · Today"), k.working_capital, "", `as of ${fmtDate(d.as_of)} · CA ${fmtShortRp(k.current_assets)} − CL ${fmtShortRp(k.current_liabilities)}`)],
    ["cash_bank", kpi(t("Cash & Bank"), k.cash_balance, "hl")],
    ["receivables", kpi(t("Receivables"), k.accounts_receivable)],
    ["payables", kpi(t("Payables"), k.accounts_payable)],
    // Active Loan is read from the Payables MODULE - the bills and loans people
    // actually record and chase - not from the 2100 ledger balance beside it.
    ["active_loan", `<div class="kpi ${k.active_loan_overdue > 0 ? "amber" : ""}">
        <div class="kpi-label">${t("Active Loan")} <span class="muted" style="font-weight:500">· ${t("from Payables")}</span></div>
        <div class="kpi-value" title="${fmtRp(k.active_loan)}">${fmtShortRp(k.active_loan)}</div>
        <div class="kpi-sub">${k.active_loan_bills || 0} ${t("open bill(s)")}${k.active_loan_overdue ? ` · ${fmtShortRp(k.active_loan_overdue)} ${t("overdue")}` : ""}</div></div>`],
    ["budget_used", `<div class="kpi ${bvaPct != null && bvaPct > 100 ? "red" : ""}">
        <div class="kpi-label">${t("Budget Used")}</div>
        <div class="kpi-value">${bvaPct == null ? "n/a" : bvaPct + "%"}</div>
        <div class="kpi-sub">of ${fmtShortRp(k.budget_expense)} expense budget</div></div>`],
  ];
  const kpiVisible = (d.kpi_visible && d.kpi_visible.length) ? new Set(d.kpi_visible) : null;
  const kpiGrid = KPI_TILES.filter(([key]) => !kpiVisible || kpiVisible.has(key)).map(([, html]) => html).join("");
  el.innerHTML = `
    <div class="page-head"><h2>${t("Dashboard")} — ${state.year} <span class="muted" style="font-size:13px;font-weight:500">· ${t("all figures in IDR (Rp)")}${d.last_input ? ` · ${t("Last input")}: <b>${esc(fmtInputStamp(d.last_input.created_at))}</b>${d.last_input.ref ? ` (${esc(d.last_input.ref)})` : ""}` : ""}</span></h2>
      <div class="page-actions" style="gap:14px;flex-wrap:wrap">
        ${isAdmin() ? `<label class="seg-check" title="${t("Show or hide the Active Loan tile (taken from the Payables module)")}">
          <input type="checkbox" id="dashLoan" ${(!kpiVisible || kpiVisible.has("active_loan")) ? "checked" : ""}> ${t("Active loan")}</label>` : ""}
        <div class="seg-group" id="dashAttr" title="${t("Revenue & COGS follow the project's company (management view) or stay with the booking entity (legal view).")}">
          <button class="seg ${state.dashAttr === "project" ? "active" : ""}" data-attr="project">${t("By project company")}</button>
          <button class="seg ${state.dashAttr === "entity" ? "active" : ""}" data-attr="entity">${t("By booking entity")}</button>
        </div>
        <div class="seg-group" id="dashScope">
          ${seg(t("Consolidated"), "all")}
          ${holding ? seg("Holding", holding.id) : ""}
          ${state.me.companies.filter(c => !c.is_holding).map(c => seg(c.code, c.id)).join("")}
        </div>
      </div></div>
    ${(d.warnings && d.warnings.length) ? `<div class="warn-banner">
      ${d.warnings.map(w => `<div class="warn ${w.level === "danger" ? "danger" : "watch"}">
        <span class="warn-ic">${w.level === "danger" ? "⚠" : "›"}</span>
        <span><b>${esc(w.title)}</b> — ${esc(w.detail)}${w.amount ? ` <b>${fmtRp(w.amount)}</b>` : ""}</span></div>`).join("")}
    </div>` : ""}
    <div class="grid kpis">${kpiGrid}</div>
    <div class="grid two-col">
      <div class="card"><h3>${t("Monthly Revenue vs Expense — IDR")} (${state.year})</h3>
        ${chartBars(MONTH_NAMES, [
          { name: "Revenue", color: C_REV, values: monthly.map(m => m.revenue) },
          { name: "Expense", color: C_EXP, values: monthly.map(m => m.expense) },
          { name: "Profit", color: C_PROFIT, values: monthly.map(m => m.profit), type: "line" },
        ])}</div>
      <div class="card"><h3>${t("Expense Breakdown — Realization vs Budget")} <span class="muted" style="font-weight:500;font-size:13px">· ${t("Operating Expenses (6000)")}</span>
        <a href="#/expenses" class="btn btn-sm" style="float:right" title="${t("Petty Cash Monit and Grab, line by line")}">${t("Devil in detail")} &rarr;</a></h3>
        ${chartDonut(opexRows.slice(0, 8).map((r, i) => ({
          label: r.code + " " + r.name, value: r.actual, color: PALETTE[i % PALETTE.length] })))}
        <div class="office-total mt">
          <span><b>${t("Jakarta Office Expense Breakdown")}</b> <span class="muted">(rent · utilities · admin)</span></span>
          <span>Realization <b>${fmtRp(officeActual)}</b> · Budget <b>${fmtRp(officeBudget)}</b>
            ${officeUsed == null ? "" : `· <span class="${officeUsed > 100 ? "neg" : "pos"}">${officeUsed}% used</span>`}</span>
        </div>
        <div style="max-height:240px;overflow:auto" class="mt"><table class="tbl">
          <thead><tr><th>Account</th><th class="num">Realization</th><th class="num">Budget</th><th class="num">Used</th></tr></thead>
          <tbody>${opexRows.map(r => {
            const used = r.budget ? Math.round(100 * r.actual / r.budget) : null;
            return `<tr><td><a href="#" class="opex-code" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${esc(r.code)} ${esc(r.name)}</a></td>
              <td class="num">${fmt(r.actual)}</td>
              <td class="num muted">${fmt(r.budget)}</td>
              <td class="num ${used != null && used > 100 ? "neg" : ""}">${used == null ? "—" : used + "%"}</td></tr>`;
          }).join("") || `<tr><td colspan="4" class="empty">No operating expenses</td></tr>`}</tbody></table>
          <p class="muted mt" style="font-size:12px">Click an account to see its month-by-month realization vs budget.</p></div>
      </div>
    </div>
    <div class="card mt"><h3>${t("C-AKUN (7300) — Budget vs Realization")}
        <span class="muted" style="font-weight:500;font-size:13px">· ${t("account 7300 & its sub-accounts")}</span></h3>
      ${caktRows.length ? chartBars(caktRows.map(r => r.code.replace("7300-", "C-") + " " + r.name.replace(/^C-?\d*\s*/, "")), [
          { name: t("Budget"), color: "#c87a08", values: caktRows.map(r => r.budget) },
          { name: t("Realization"), color: C_REV, values: caktRows.map(r => r.actual) },
        ], { height: 260, valueLabels: true, valueFmt: fmtShort })
        : `<div class="empty">${t("No C-AKUN (7300) accounts with activity yet.")}</div>`}
      ${caktRows.length ? `<div style="max-height:220px;overflow:auto" class="mt"><table class="tbl">
        <thead><tr><th>${t("Account")}</th><th class="num">${t("Budget")}</th><th class="num">${t("Realization")}</th><th class="num">${t("Variance")}</th><th class="num">${t("Used")}</th></tr></thead>
        <tbody>${caktRows.map(r => {
          const used = r.budget ? Math.round(100 * r.actual / r.budget) : null;
          const varc = round2(r.budget - r.actual);
          return `<tr><td><a href="#" class="cakun-code" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${esc(r.code)} ${esc(r.name)}</a></td>
            <td class="num muted">${fmt(r.budget)}</td>
            <td class="num">${fmt(r.actual)}</td>
            <td class="num ${varc < 0 ? "neg" : "pos"}">${fmt(varc)}</td>
            <td class="num ${used != null && used > 100 ? "neg" : ""}">${used == null ? "—" : used + "%"}</td></tr>`;
        }).join("")}
        <tr class="total"><td>${t("TOTAL")} C-AKUN</td><td class="num">${fmt(caktBudget)}</td><td class="num">${fmt(caktActual)}</td>
          <td class="num ${caktBudget - caktActual < 0 ? "neg" : "pos"}">${fmt(round2(caktBudget - caktActual))}</td>
          <td class="num ${caktUsed != null && caktUsed > 100 ? "neg" : ""}">${caktUsed == null ? "—" : caktUsed + "%"}</td></tr>
        </tbody></table>
        <p class="muted mt" style="font-size:12px">${t("Click an account to see its transactions.")}</p></div>` : ""}
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
          <tr><td>${t("Overdue AP (> 90 days)")}</td><td class="num muted">${aa.risky_ap == null ? "— (from AP Aging)" : fmtRp(aa.risky_ap)}</td></tr>
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
    ${(d.weekly_cash && d.weekly_cash.length) ? `<div class="card mt"><h3>${t("Cash Flow — Actual vs Budget (Weekly)")}</h3>
      ${chartBars(d.weekly_cash.map(w => (w.week % 4 === 1 ? "W" + w.week : "")), [
        { name: "Actual Ending", color: C_REV, values: d.weekly_cash.map(w => w.ending), type: "line" },
        { name: "Budget Ending", color: "#c87a08", values: d.weekly_cash.map(w => w.budget_ending), type: "line" },
      ], { height: 280 })}
      <div class="muted mt">${d.cash_budget_set
        ? t("Cumulative cash position — realization vs the weekly cash budget.")
        : t("Set a weekly cash budget in Reports → Cash Flow → Weekly to compare against the budget line.")}</div>
    </div>` : ""}
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
  if ($("#dashLoan")) $("#dashLoan").onchange = async e => {
    // one source of truth: the same tile list Settings → Dashboard edits
    try {
      const cfg = await api("/api/settings/dashboard-kpis");
      const allKeys = cfg.all.map(x => x.key);
      let keys = (cfg.selected && cfg.selected.length ? cfg.selected : allKeys).filter(x => x !== "active_loan");
      if (e.target.checked) keys.push("active_loan");
      // every tile on is stored as "all", so a tile added later is never silently hidden
      await api("/api/settings/dashboard-kpis", { json: { keys: keys.length === allKeys.length ? [] : keys } });
      pageDashboard(el);
    } catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
  };
  $$("#dashAttr .seg").forEach(b => b.onclick = () => {
    state.dashAttr = b.dataset.attr;
    render();
  });
  $$("#content tr[data-proj]").forEach(tr => tr.onclick = () =>
    dashProjectDetail(tr.dataset.proj, tr.dataset.company, tr.dataset.name));
  $$("#content .opex-code").forEach(a => a.onclick = e => {
    e.preventDefault(); accountMonthlyModal(a.dataset.code, a.dataset.name);
  });
  // C-AKUN (7300): click an account for its actual transactions
  $$("#content .cakun-code").forEach(a => a.onclick = e => {
    e.preventDefault(); openAccountLedger(a.dataset.code, a.dataset.name);
  });
}

async function accountMonthlyModal(code, name) {
  try {
    const d = await api(`/api/reports/account-monthly?${scopeQS()}&attribution=${state.dashAttr || "project"}&code=${encodeURIComponent(code)}`);
    const used = d.budget_total ? Math.round(100 * d.actual_total / d.budget_total) : null;
    openModal(`
      <div class="muted" style="margin-top:-4px">${esc(d.scope)} · ${state.year} · realization vs budget by month</div>
      <div class="grid kpis mt">
        <div class="kpi"><div class="kpi-label">Realization YTD</div><div class="kpi-value">${fmtShortRp(d.actual_total)}</div></div>
        <div class="kpi"><div class="kpi-label">Budget</div><div class="kpi-value">${fmtShortRp(d.budget_total)}</div></div>
        <div class="kpi ${used != null && used > 100 ? "red" : ""}"><div class="kpi-label">Used</div>
          <div class="kpi-value">${used == null ? "—" : used + "%"}</div></div>
      </div>
      ${chartBars(MONTH_NAMES, [
        { name: "Budget", color: "#c87a08", values: d.budget_months },
        { name: "Realization", color: C_REV, values: d.actual_months },
      ], { height: 280, valueLabels: false })}
      <p class="muted mt" style="font-size:12px">Realization follows the ${(state.dashAttr || "project") === "project" ? "project company (management)" : "booking entity (legal)"} view — same as the dashboard toggle.</p>`,
      { title: `${code} — ${name}` });
  } catch (e) { toast(e.message, true); }
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
      contract_value: p.contract_value || 0,
      revenue: 0, expense: 0, profit: 0, margin_pct: 0, budget_revenue: 0, budget_expense: 0,
      cogs: 0, opex: 0, cogs_by: {}, cost_by: {} },
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
    ${phContractTable(rows)}
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
        <td>${esc(fmtDate(j.date))}</td><td>${esc(j.entry_no)}</td><td>${esc(j.company)}</td>
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
    <div class="muted">${esc(fmtDate(j.date))} &middot; ${esc(j.company)} &middot; ${esc(j.reference || "")}</div>
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
  // Projects come from EVERY company the user can see. A project's costs are
  // often paid out of another entity's books - NX-01 belongs to SBR-NX but is
  // paid from MDA - and reports attribute a project line to the project's own
  // company, so tagging across companies is how that is recorded properly.
  const [fields, allProjects] = await Promise.all([
    api("/api/custom-fields?entity=journal"),
    api("/api/projects?company_id=all").catch(() => []),
  ]);
  const root = openModal(`
    <div class="form-grid">
      <label>Company <select id="jeCompany" ${canWrite() ? "" : "disabled"}>${companyOptions(cid)}</select></label>
      <label>Date <input type="date" id="jeDate" value="${existing ? esc(existing.date) : new Date().toISOString().slice(0, 10)}"></label>
      <div class="je-company-note" id="jeCoNote" hidden></div>
      <label class="full">Description <input id="jeDesc" value="${existing ? esc(existing.description) : ""}" placeholder="What is this entry for?"></label>
      <label>Reference <input id="jeRef" value="${existing ? esc(existing.reference) : ""}" placeholder="invoice no, contract…"></label>
      ${fields.map(f => customFieldInput(f, existing && existing.custom ? existing.custom[f.id] || "" : "")).join("")}
    </div>
    <table class="tbl je-lines mt">
      <colgroup><col class="c-acc"><col class="c-prj"><col class="c-desc"><col class="c-amt"><col class="c-amt"><col class="c-del"></colgroup>
      <thead><tr><th>Account <span class="muted" style="font-weight:400">(this company)</span></th>
        <th>Project <span class="muted" style="font-weight:400">(any company)</span></th>
        <th>Line description</th><th class="amt">Debit</th><th class="amt">Credit</th><th></th></tr></thead>
      <tbody id="jeLines"></tbody></table>
    <button class="btn btn-sm mt" id="addLine">+ Add line</button>
    <div class="je-balance" id="jeBalance"></div>
    <div class="form-actions">
      ${existing ? `<button class="btn btn-primary" id="saveEdit">Save Changes (stays ${existing.status})</button>`
        : `<button class="btn" id="saveDraft">Save as Draft</button>
           <button class="btn btn-primary" id="savePost">Save &amp; Post</button>`}
    </div>`, { title: existing ? `Edit ${existing.entry_no}` : "New Journal Entry", wide: true });

  const origCompany = String(cid);
  let accounts = [];
  const companyLabel = id => {
    const c = (state.me.companies || []).find(x => String(x.id) === String(id));
    return c ? `${c.code} — ${c.name}` : `company ${id}`;
  };

  function accountOpts(sel) {
    return `<option value="">—</option>` + accounts.map(a =>
      `<option value="${a.id}" data-code="${esc(a.code)}" ${String(sel) === String(a.id) ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("");
  }
  function projectOpts(sel) {
    const entryCo = String($("#jeCompany").value);
    const groups = new Map();
    allProjects.forEach(p => {
      const k = String(p.company_id);
      if (!groups.has(k)) groups.set(k, { code: p.company_code, name: p.company_name, items: [] });
      groups.get(k).items.push(p);
    });
    // the entry's own company first, then the rest alphabetically
    const keys = [...groups.keys()].sort((x, y) =>
      x === entryCo ? -1 : y === entryCo ? 1 : String(groups.get(x).code).localeCompare(groups.get(y).code));
    return `<option value="">— no project —</option>` + keys.map(k => {
      const g = groups.get(k);
      return `<optgroup label="${esc(g.code)} — ${esc(g.name)}${k === entryCo ? " · this entry's company" : ""}">${
        g.items.map(p => `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("")
      }</optgroup>`;
    }).join("");
  }

  // Switching company swaps the chart of accounts. Every line keeps its account
  // CODE and is re-pointed at the new company's account with the same code; a
  // code that does not exist there is cleared and reported, never guessed.
  async function loadCompanyData(remap) {
    const c = $("#jeCompany").value;
    if (remap) $$("#jeLines tr").forEach(tr => {
      const o = $(".je-acc", tr).selectedOptions[0];
      tr.dataset.code = o && o.value ? (o.dataset.code || "") : "";
    });
    accounts = (await api("/api/accounts?company_id=" + c)).filter(a => a.is_active);
    let lost = 0;
    $$("#jeLines tr").forEach(tr => {
      const prj = $(".je-prj", tr).value;
      if (remap) {
        const code = tr.dataset.code;
        const hit = code ? accounts.find(a => a.code === code) : null;
        if (code && !hit) lost++;
        $(".je-acc", tr).innerHTML = accountOpts(hit ? hit.id : "");
      } else {
        $(".je-acc", tr).innerHTML = accountOpts($(".je-acc", tr).value);
      }
      $(".je-prj", tr).innerHTML = projectOpts(prj);
    });
    const note = $("#jeCoNote");
    if (existing && String(c) !== origCompany) {
      note.hidden = false;
      note.textContent = `Moving this entry from ${companyLabel(origCompany)} to ${companyLabel(c)}. ` +
        `Accounts are matched by code in the new company's chart of accounts` +
        (lost ? ` — ${lost} line(s) had no matching code and were cleared; choose them before saving.`
              : " — every line found its account.") +
        " If the entry number is already used there, a new one is assigned.";
    } else {
      note.hidden = true;
    }
  }
  function addLine(line) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><select class="je-acc">${accountOpts(line ? line.account_id : "")}</select></td>
      <td><select class="je-prj">${projectOpts(line ? line.project_id : "")}</select></td>
      <td><textarea class="je-ldesc" rows="1" placeholder="What this line is">${line ? esc(line.description) : ""}</textarea></td>
      <td><input class="je-debit amt" type="number" min="0" step="any" placeholder="0" value="${line && line.debit ? line.debit : ""}"></td>
      <td><input class="je-credit amt" type="number" min="0" step="any" placeholder="0" value="${line && line.credit ? line.credit : ""}"></td>
      <td><button class="btn btn-sm btn-ghost je-del" title="Remove line">&times;</button></td>`;
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
    const rows = $$("#jeLines tr");
    const missing = rows.filter(tr => !$(".je-acc", tr).value &&
      ((parseFloat($(".je-debit", tr).value) || 0) || (parseFloat($(".je-credit", tr).value) || 0)));
    if (missing.length) { toast(`${missing.length} line(s) with an amount have no account — choose one before saving`, true); return; }
    const lines = rows.map(tr => ({
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
        const res = await api("/api/journals/" + existing.id, { method: "PUT", json: payload });
        toast(res.moved
          ? `Entry moved to ${companyLabel(payload.company_id)}${res.renumbered ? ` and renumbered ${res.entry_no}` : ""}`
          : `Entry ${res.entry_no} updated`);
      } else {
        const res = await api("/api/journals", { json: payload });
        toast(`Entry ${res.entry_no} saved (${status})`);
      }
      closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  }
  $("#addLine").onclick = () => addLine();
  $("#jeCompany").onchange = () => loadCompanyData(true);
  if (existing) $("#saveEdit").onclick = () => save(existing.status);
  else { $("#saveDraft").onclick = () => save("draft"); $("#savePost").onclick = () => save("posted"); }
  await loadCompanyData(false);
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
const BANK_SOURCE_BY_MODE = { paste: "bca_bank", csv: "bca_csv", pdf: "bca_pdf", wallet: "monit_wallet", cc: "cc_card", custom: "custom", grab: "grab_business" };

// wallet/card Excel format documentation — mirrors the Format Guide sheet in
// the downloadable template (excel_io.WALLET_TEMPLATE_COLUMNS)
const WALLET_FORMAT_DOC = [
  ["Transaction Type", "Optional", "PAYMENT · INTERNAL_TRANSFER · CARD_ADD_BALANCE · CARD_REFUND_BALANCE", "Internal types (moves between your own wallets/cards) are left unticked."],
  ["Reference ID", "Recommended", "Any unique text, e.g. WLT-2026-0001", "Duplicate detection — already-booked refs are flagged. Blank = auto fingerprint."],
  ["Status", "Optional", "SUCCESS · SETTLED · COMPLETED — anything else is skipped", "Only successful transactions import."],
  ["Category", "Optional", "FOOD_AND_BEVERAGE · TRANSPORTATION · EXPEDITION_EXPENSES · OFFICE_SUPPLIES · SOFTWARE · TELECOMMUNICATION · MISCELLANEOUS", "Suggests the expense account: OFFICE_SUPPLIES→6600, SOFTWARE/TELECOM→6300, others→6900."],
  ["Transaction Datetime", "REQUIRED", "YYYY-MM-DD HH:MM:SS or DD/MM/YYYY", "The journal entry date."],
  ["Amount", "REQUIRED", "Number — NEGATIVE = money out (spending), positive = money in", "Spending books: debit expense (5000–8000) · credit Petty Cash / Cash & Bank."],
  ["Description", "Optional", "Free text", "Journal entry description."],
  ["Account Name", "Optional", "Wallet / account label", "Shown as the source account."],
  ["Card Name", "Optional", "Card label", "Shown with the transaction."],
  ["Recipient Holder Name", "Optional", "Counterparty name", "Merged into the description."],
  ["Notes", "Optional", "Free text", "Merged into the description."],
];

function walletFormatGuide() {
  openModal(`
    <p class="muted" style="margin-top:-4px">Column <b>names</b> must match exactly; column <b>order</b> doesn't matter
      (lookup is by header name) and extra columns are ignored. The downloadable template contains these columns
      plus example rows and this guide as a second sheet.</p>
    <div style="max-height:46vh;overflow:auto"><table class="tbl">
      <thead><tr><th>Column</th><th>Required</th><th>Format / accepted values</th><th>How it is used</th></tr></thead>
      <tbody>${WALLET_FORMAT_DOC.map(r => `<tr>
        <td><b>${esc(r[0])}</b></td><td>${r[1] === "REQUIRED" ? `<span class="pill bad">REQUIRED</span>` : esc(r[1])}</td>
        <td>${esc(r[2])}</td><td class="muted">${esc(r[3])}</td></tr>`).join("")}
      </tbody></table></div>
    <h3 style="margin-top:14px">${t("Booking rules")}</h3>
    <ul class="muted" style="margin:6px 0 0 18px;line-height:1.7">
      <li>Money <b>OUT</b> (negative Amount): <b>debit</b> the expense account you pick (5000–8000 only) · <b>credit</b> the Petty Cash / Cash &amp; Bank account.</li>
      <li>Money <b>IN</b> (positive Amount): debit Petty Cash / Cash &amp; Bank · credit the account you pick.</li>
      <li>Internal transaction types are detected as own-wallet moves and left unticked.</li>
      <li>Rows whose Status is not SUCCESS / SETTLED / COMPLETED are skipped.</li>
      <li>Re-uploading the same file is safe — booked rows (same Reference ID) are flagged as duplicates.</li>
    </ul>
    <div class="form-actions"><a class="btn btn-primary" href="/api/bank/wallet-template">&#x2913; ${t("Download Excel template")}</a></div>`,
    { title: t("Wallet / Card Excel — Format guide") });
}

async function pageBank(el) {
  if (!canWrite()) {
    el.innerHTML = `<div class="card"><div class="empty">Account Parsing requires the Admin or Accountant role.</div></div>`;
    return;
  }
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Account Parsing")}</h2>
      <div class="page-actions"><label class="muted">Company <select id="bkCompany">${companyOptions(cid)}</select></label></div>
    </div>
    <div class="card">
      <h3>1. Choose import method</h3>
      <div class="tabs" id="bkModes" style="margin-bottom:12px">
        <button data-m="paste" class="active">Paste receipt(s)</button>
        <button data-m="csv">CSV file — mutasi rekening</button>
        <button data-m="pdf">PDF e-statement (BCA)</button>
        <button data-m="wallet">Wallet / Card Excel (petty cash)</button>
        <button data-m="grab">GRAB BUSINESS INPUT</button>
        <button data-m="cc">CC Card statement (credit card)</button>
        <button data-m="custom">Custom format (import/export)</button>
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
        <div class="filters" style="margin-top:6px">
          <a class="btn btn-sm" id="bkWalletTpl" href="/api/bank/wallet-template">&#x2913; ${t("Download Excel template")}</a>
          <button class="btn btn-sm" id="bkWalletGuide">&#x25A4; ${t("Format guide")}</button>
          <span class="muted">${t("The template has the exact columns plus a Format Guide sheet.")}</span>
        </div>
      </div>
      <div id="bkGrabBox" hidden>
        <p class="muted" style="margin-top:-2px">${t("Upload the Grab for Business CSV reports — Express, Transport and Food. You can pick all three at once.")}
        ${t("Each booking becomes one entry: the date, the employee's name with the type of transaction as the description, and the right-most total on the row (what the company pays after any refund) as the amount.")}
        ${t("It is charged to the CORP PAY - GRAB cash account of the company — MDA by default — and debits the cost account: Food to Food & Beverage, Transport and Express to Transportation.")}
        ${t("Re-uploading is safe: bookings already posted are recognised by their Grab Booking ID.")}</p>
        <div class="filters">
          <label>${t("CSV file(s)")} <input type="file" id="bkGrabFile" accept=".csv,.txt" multiple></label>
          <button class="btn btn-primary" id="bkGrabParse">${t("Upload & parse")}</button>
          <span class="muted" id="bkGrabInfo"></span>
        </div>
        <div class="filters" style="margin-top:6px" id="bkGrabAcct"></div>
      </div>
      <div id="bkCcBox" hidden>
        <p class="muted" style="margin-top:-2px">Upload the <b>credit-card statement PDF</b> (BCA Kartu Kredit — REKENING KARTU KREDIT).
        Every <b>purchase</b> is read with its transaction date, merchant and Rupiah amount (the USD detail is kept in the description) and
        booked as an <b>expense</b>: debit the cost account you pick (5000–8000) · credit the card / cash account selected below.
        <b>Payment</b> rows (PEMBAYARAN … CR) are left <b>unticked</b> — they already appear as an outflow on your bank statement.</p>
        <div class="filters">
          <label>PDF file <input type="file" id="bkCcFile" accept=".pdf"></label>
          <button class="btn btn-primary" id="bkCcParse">Upload &amp; parse</button>
          <span class="muted" id="bkCcInfo"></span>
        </div>
      </div>
      <div id="bkCustomBox" hidden>
        <p class="muted" style="margin-top:-2px">Use a <b>custom format profile</b> to import a CSV/Excel from any other bank —
        the profile maps that bank's columns (date, description, amount, direction, balance) onto ours. <b>Export</b> a built-in
        format as a starting point, edit the column names to match your file, then <b>Import</b> it back and pick it here.</p>
        <div class="filters" style="flex-wrap:wrap;gap:10px">
          <label>Format <select id="bkFmtSel" style="min-width:220px"></select></label>
          <label>File <input type="file" id="bkFmtFile" accept=".csv,.txt,.xlsx,.xlsm"></label>
          <button class="btn btn-primary" id="bkFmtParse">Upload &amp; parse</button>
          <span class="muted" id="bkFmtInfo"></span>
        </div>
        <div class="filters" style="flex-wrap:wrap;gap:10px;margin-top:6px">
          <label>Export a template <select id="bkFmtTpl" style="min-width:180px"></select></label>
          <a class="btn btn-sm" id="bkFmtExportTpl">&#x2913; Download template JSON</a>
          <a class="btn btn-sm" id="bkFmtExportSel">&#x2913; Export selected format</a>
          <label class="btn btn-sm" style="cursor:pointer">&#x2912; Import format JSON
            <input type="file" id="bkFmtImport" accept=".json" hidden></label>
          <button class="btn btn-sm btn-danger" id="bkFmtDelete">Delete selected</button>
        </div>
      </div>
    </div>
    <div class="card mt" id="bkStage2" hidden>
      <h3>2. Assign accounts &amp; book entries</h3>
      <p class="muted" style="margin-top:-6px">Each transfer is booked as: <b>debit</b> the account you choose below (cost/expense by default) and <b>credit</b> the bank account. Duplicates (same No Referensi already booked) are unticked automatically.</p>
      <div class="filters">
        <label id="bkBankLabel">Cash / Bank account (the cash side) <select id="bkBank" style="min-width:240px"></select></label>
        <button class="btn btn-sm" id="bkSetDefault" title="Remember this cash/bank account as the default contra for imports in this database">&#9733; Set as default</button>
        <label>Book as <select id="bkStatus"><option value="draft">Draft</option><option value="posted" selected>Posted</option></select></label>
      </div>
      <div style="overflow-x:auto"><table class="tbl bk-compact" id="bkTable"></table></div>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="btn btn-primary" id="bkBook">Book selected transfers</button>
        <span class="muted" id="bkBookInfo"></span>
      </div>
      <div id="bkResults" class="mt"></div>
    </div>`;

  let txs = [], accounts = [], projects = [], mode = "paste", bankCfg = { default_cash_code: "" };

  async function loadCompanyData() {
    // accounts must belong to the import company; projects span the whole
    // database (a bank line can be tagged to any project, in any company)
    [accounts, projects, bankCfg] = await Promise.all([
      api("/api/accounts?company_id=" + $("#bkCompany").value),
      api("/api/projects?company_id=all"),
      api("/api/settings/bank-config").catch(() => ({ default_cash_code: "" })),
    ]);
    accounts = accounts.filter(a => a.is_active);
    // CC-card mode also lets the "cash side" be a liability (a Credit Card
    // Payable account), since the card is what you owe; other modes use 11xx
    const banks = accounts.filter(a =>
      (a.type === "asset" && a.code.startsWith("11")) ||
      (mode === "cc" && a.type === "liability"));
    // configurable default cash/bank contra account (Settings); wallet keeps
    // Petty Cash Monit, CC card defaults to 1170 (CC BCA VISA CARD)
    const cashDefault = mode === "wallet" ? "1130" : mode === "cc" ? "1170" : (bankCfg.default_cash_code || "1120");
    const has = banks.some(a => a.code === cashDefault);
    $("#bkBank").innerHTML = banks.map(a =>
      `<option value="${a.id}" ${a.code === (has ? cashDefault : "1120") ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("");
    if (mode === "grab") selectGrabAccount();
  }

  // Grab bookings are charged to the company's CORP PAY - GRAB cash account
  const grabAccount = () => accounts.find(a => a.type === "asset" && String(a.name).trim().toUpperCase() === "CORP PAY - GRAB");
  function selectGrabAccount() {
    const ga = grabAccount();
    if (ga) $("#bkBank").value = String(ga.id);
    const box = $("#bkGrabAcct");
    if (!box) return;
    box.innerHTML = ga
      ? `<span class="muted">${t("Charged to")} <b>${esc(ga.code)} ${esc(ga.name)}</b></span>`
      : `<span class="neg">${t("This company has no CORP PAY - GRAB account yet.")}</span>
         <button class="btn btn-sm" id="bkGrabMake">+ ${t("Create CORP PAY - GRAB (cash)")}</button>`;
    if ($("#bkGrabMake")) $("#bkGrabMake").onclick = async () => {
      try {
        const r = await api("/api/bank/grab-account", { json: { company_id: parseInt($("#bkCompany").value, 10) } });
        toast(`${t("Account created")}: ${r.code} ${r.name}`);
        await loadCompanyData();
      } catch (e) { toast(e.message, true); }
    };
  }

  function debitOptions(sel, direction) {
    const grp = (label, list) => list.length
      ? `<optgroup label="${label}">` + list.map(a =>
          `<option value="${a.id}" ${String(sel) === String(a.id) ? "selected" : ""}>${esc(a.code)} ${esc(a.name)}</option>`).join("") + "</optgroup>"
      : "";
    // Wallet/card Excel, CC-card and custom-format parses book strictly:
    // DEBIT an expense account (5000–8000) · CREDIT the Cash & Bank / card account
    if (mode === "wallet" || mode === "custom" || mode === "cc" || mode === "grab") {
      return `<option value="">— choose account —</option>`
        + grp("Costs / Expenses (5000–8000)",
              accounts.filter(a => a.type === "expense" && /^[5-8]/.test(a.code)));
    }
    const exp = grp("Costs / Expenses", accounts.filter(a => a.type === "expense"));
    const rev = grp("Revenue", accounts.filter(a => a.type === "revenue"));
    // cash/bank (11xx) accounts are offered as a contra so an interbank / cash
    // transfer (bank ↔ bank, bank ↔ petty cash) can be booked
    const interbank = grp("Cash / Bank (interbank transfer)",
      accounts.filter(a => a.type === "asset" && a.code.startsWith("11")));
    return `<option value="">— choose account —</option>`
      + (direction === "in" ? rev + exp : exp + rev)
      + interbank
      + grp("Assets", accounts.filter(a => a.type === "asset" && !a.code.startsWith("11")))
      + grp("Liabilities", accounts.filter(a => a.type === "liability"));
  }
  function projectOpts(sel) {
    // all projects in the database, grouped by company so the source is clear
    const byCo = {};
    projects.forEach(p => { (byCo[p.company_code] = byCo[p.company_code] || []).push(p); });
    const groups = Object.keys(byCo).sort().map(co =>
      `<optgroup label="${esc(co)}">` + byCo[co].map(p =>
        `<option value="${p.id}" ${String(sel) === String(p.id) ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("") + "</optgroup>").join("");
    return `<option value="">—</option>` + groups;
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
    $("#bkTable").innerHTML = `<thead><tr><th></th><th>Date</th><th>In/Out</th><th style="min-width:150px">Description</th>
      <th class="num">Amount<br><span style="font-weight:400;text-transform:none">(Jumlah / Nominal)</span></th>
      <th class="num">Balance<br><span style="font-weight:400;text-transform:none">(Saldo)</span></th>
      <th>No Referensi<br><span style="font-weight:400;text-transform:none">(Ref. No.)</span></th><th>Status</th>
      <th style="min-width:140px">Contra account<br><span style="font-weight:400;text-transform:none">(cost OUT / revenue IN)</span></th><th>Project</th></tr></thead>
      <tbody>${txs.map((t, i) => `<tr data-i="${i}" ${t.duplicate || t.internal ? 'style="opacity:.55"' : ""}>
        <td><input type="checkbox" class="bk-sel" ${t.ok && !t.duplicate && !t.internal && t.amount && t.date ? "checked" : ""}></td>
        <td>${esc(t.date ? fmtDate(t.date) : "?")}<br><span class="muted">${esc(t.time)}</span></td>
        <td><span class="pill ${t.direction === "in" ? "posted" : "draft"}">${t.direction === "in" ? "IN" : "OUT"}</span></td>
        <td><textarea class="bk-desc" rows="2" style="width:100%;min-width:140px;resize:vertical;font-family:inherit">${esc(t.description)}</textarea>
          ${t.va_number ? `<span class="muted">VA ${esc(t.va_number)}</span>` : ""}
          ${t.category ? `<span class="muted">${esc(t.category.toLowerCase().replace(/_/g, " "))}</span>` : ""}
          ${t.grab && t.note ? `<span class="muted" style="font-size:11.5px">${esc(t.note)}</span>` : ""}</td>
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
  $$("#bkModes button").forEach(b => b.onclick = async () => {
    $$("#bkModes button").forEach(x => x.classList.toggle("active", x === b));
    const was = mode;
    mode = b.dataset.m;
    // Grab bills PT MORES DATA ANALITIK - the Grab import starts on MDA
    if (mode === "grab" && was !== "grab") {
      const mda = state.me.companies.find(c => c.code === "MDA");
      if (mda && $("#bkCompany").value !== String(mda.id)) {
        $("#bkCompany").value = String(mda.id);
        await loadCompanyData();
        if (txs.length) renderTable();
      }
    }
    $("#bkGrabBox").hidden = mode !== "grab";
    $("#bkPasteBox").hidden = mode !== "paste";
    $("#bkCsvBox").hidden = mode !== "csv";
    $("#bkPdfBox").hidden = mode !== "pdf";
    $("#bkWalletBox").hidden = mode !== "wallet";
    $("#bkCcBox").hidden = mode !== "cc";
    $("#bkCustomBox").hidden = mode !== "custom";
    if (mode === "custom") loadFormats();
    // CC mode widens the cash-side dropdown to include liability (card) accounts,
    // so rebuild the options for the current mode
    const banks = accounts.filter(a =>
      (a.type === "asset" && a.code.startsWith("11")) ||
      (mode === "cc" && a.type === "liability"));
    $("#bkBank").innerHTML = banks.map(a =>
      `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join("");
    // default the cash side: Petty Cash Monit for wallet, CC BCA VISA CARD for
    // credit card, else the configured default cash/bank account (falls back to 1120)
    const wantCode = mode === "wallet" ? "1130" : mode === "cc" ? "1170" : (bankCfg.default_cash_code || "1120");
    let opt = Array.from($("#bkBank").options).find(o => o.textContent.trim().startsWith(wantCode + " "));
    if (!opt && mode !== "wallet") opt = Array.from($("#bkBank").options).find(o => o.textContent.trim().startsWith("1120 "));
    if (opt) $("#bkBank").value = opt.value;
    if (mode === "grab") selectGrabAccount();
    $("#bkBankLabel").firstChild.textContent = mode === "wallet"
      ? "Petty Cash account (deducted from this) "
      : mode === "cc" ? "Credit card / cash account (credited) "
      : mode === "grab" ? t("CORP PAY - GRAB account (charged) ") + " "
      : "Cash / Bank account (the cash side) ";
  });
  $("#bkSetDefault").onclick = async () => {
    const sel = $("#bkBank").selectedOptions[0];
    if (!sel) return;
    const code = sel.textContent.trim().split(" ")[0];
    try {
      await api("/api/settings/bank-config", { json: { default_cash_code: code } });
      bankCfg.default_cash_code = code;
      toast(`Default cash/bank account set to ${code} for this database`);
    } catch (e) { toast(e.message, true); }
  };
  const showParsed = (res, infoEl) => {
    txs = res.transactions;
    const dups = txs.filter(t => t.duplicate).length;
    infoEl.textContent = `${txs.length} transaction(s) found` +
      (dups ? ` (${dups} already booked)` : "") +
      (res.meta && res.meta["no. rekening"] ? ` — account ${res.meta["no. rekening"]} ${res.meta["nama"] || ""} ${res.meta["periode"] || ""}` : "") +
      (res.meta && res.meta.statement_date ? ` — card ${res.meta.customer || ""} · statement ${fmtDate(res.meta.statement_date)}` : "") +
      (res.meta && res.meta.files ? " — " + res.meta.files.map(m => `${m.service} ${fmt(m.parsed_total)}${m.reconciled ? " ✓" : ""}`).join(" · ") : "") +
      (res.warnings.length ? ` — ${res.warnings.length} warning(s): ${fmtDatesIn(res.warnings.join("; "))}` : "");
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
  $("#bkCcParse").onclick = () => uploadParse($("#bkCcFile"), "/api/bank/parse-cc", $("#bkCcInfo"));
  $("#bkGrabParse").onclick = async () => {
    const files = Array.from($("#bkGrabFile").files || []);
    if (!files.length) { toast(t("Choose the Grab CSV file(s) first"), true); return; }
    const fd = new FormData();
    fd.append("company_id", $("#bkCompany").value);
    files.forEach(f => fd.append("file", f));
    $("#bkGrabInfo").textContent = t("Parsing…");
    try {
      const res = await api("/api/bank/parse-grab", { method: "POST", body: fd });
      showParsed(res, $("#bkGrabInfo"));
      selectGrabAccount();
    } catch (e) { $("#bkGrabInfo").textContent = ""; toast(e.message, true); }
  };
  $("#bkWalletGuide").onclick = walletFormatGuide;

  // ---- custom format profiles (import / export) ----
  let fmtLoaded = false;
  async function loadFormats() {
    let data;
    try { data = await api("/api/bank/formats"); } catch (e) { toast(e.message, true); return; }
    fmtLoaded = true;
    $("#bkFmtSel").innerHTML = data.profiles.length
      ? data.profiles.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.format_type)})</option>`).join("")
      : `<option value="">— no custom formats yet — import one below —</option>`;
    $("#bkFmtTpl").innerHTML = data.templates.map(tp =>
      `<option value="${esc(tp.key)}">${esc(tp.name)}</option>`).join("");
    const selId = () => $("#bkFmtSel").value;
    $("#bkFmtExportTpl").href = `/api/bank/formats/export?template=${encodeURIComponent($("#bkFmtTpl").value || "")}`;
    $("#bkFmtTpl").onchange = () => { $("#bkFmtExportTpl").href = `/api/bank/formats/export?template=${encodeURIComponent($("#bkFmtTpl").value)}`; };
    const syncExportSel = () => { $("#bkFmtExportSel").href = selId() ? `/api/bank/formats/export?id=${selId()}` : "#"; };
    $("#bkFmtSel").onchange = syncExportSel; syncExportSel();
  }
  $("#bkFmtParse").onclick = async () => {
    const f = $("#bkFmtFile").files[0];
    const fid = $("#bkFmtSel").value;
    if (!fid) { toast("Pick a custom format (import one first)", true); return; }
    if (!f) { toast("Choose the file to parse", true); return; }
    const fd = new FormData();
    fd.append("company_id", $("#bkCompany").value);
    fd.append("format_id", fid);
    fd.append("file", f);
    $("#bkFmtInfo").textContent = "Parsing…";
    try { showParsed(await api("/api/bank/parse-custom", { method: "POST", body: fd }), $("#bkFmtInfo")); }
    catch (e) { $("#bkFmtInfo").textContent = ""; toast(e.message, true); }
  };
  $("#bkFmtImport").onchange = async () => {
    const f = $("#bkFmtImport").files[0];
    if (!f) return;
    try {
      const profile = JSON.parse(await f.text());
      const r = await api("/api/bank/formats", { json: profile });
      toast(`Format "${r.name}" imported`);
      await loadFormats();
      const opt = Array.from($("#bkFmtSel").options).find(o => o.value == r.id);
      if (opt) $("#bkFmtSel").value = r.id;
      $("#bkFmtSel").dispatchEvent(new Event("change"));
    } catch (e) { toast("Import failed: " + e.message, true); }
    $("#bkFmtImport").value = "";
  };
  $("#bkFmtDelete").onclick = async () => {
    const fid = $("#bkFmtSel").value;
    if (!fid) { toast("No custom format selected", true); return; }
    if (!confirm("Delete this custom format profile?")) return;
    try { await api("/api/bank/formats/" + fid, { method: "DELETE" }); toast("Format deleted"); await loadFormats(); }
    catch (e) { toast(e.message, true); }
  };
  $("#bkBook").onclick = async () => {
    const bankAcc = parseInt($("#bkBank").value, 10);
    const status = $("#bkStatus").value;
    const rows = $$("#bkTable tbody tr").filter(tr => $(".bk-sel", tr).checked);
    if (!rows.length) { toast("No transfers selected", true); return; }
    const missing = rows.filter(tr => !$(".bk-acc", tr).value);
    if (missing.length) { toast(`${missing.length} selected transfer(s) have no debit account chosen`, true); return; }
    const selfTransfer = rows.filter(tr => parseInt($(".bk-acc", tr).value, 10) === bankAcc);
    if (selfTransfer.length) { toast(`${selfTransfer.length} selected transfer(s) use the same account for both sides — pick a different contra account`, true); return; }
    $("#bkBook").disabled = true;
    let okCount = 0; const results = [];
    for (const tr of rows) {
      const t = txs[tr.dataset.i];
      const contra = {
        account_id: parseInt($(".bk-acc", tr).value, 10),
        project_id: parseInt($(".bk-prj", tr).value, 10) || null,
        description: t.tx_type || "transaction",
      };
      const bankLine = { account_id: bankAcc, description: (mode === "wallet" ? "Petty cash — ref " : mode === "cc" ? "Credit card — ref " : mode === "grab" ? "Grab — " : "Bank — ref ") + t.reference };
      // A credit-card PURCHASE books DEBIT the expense account · CREDIT the card
      // account (1170) — the expense side is the debit, the card is the credit.
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
          grab: mode === "grab" && t.grab ? t.grab : undefined,
        }});
        okCount++;
        results.push(`<li class="pos">✓ ${esc(t.reference || fmtDate(t.date))} — booked as <b>${esc(res.entry_no)}</b> (${status})</li>`);
        $(".bk-sel", tr).checked = false;
        tr.style.opacity = ".5";
      } catch (e) {
        results.push(`<li class="neg">✗ ${esc(t.reference || fmtDate(t.date))} — ${esc(e.message)}</li>`);
      }
    }
    $("#bkBook").disabled = false;
    $("#bkBookInfo").textContent = `${okCount}/${rows.length} booked`;
    $("#bkResults").innerHTML = `<ul style="margin:0;padding-left:18px">${results.join("")}</ul>`;
    if (okCount) toast(`${okCount} bank transfer(s) booked`);
  };
  await loadCompanyData();
}

/* ------------------------------------------------------------ expense breakdown */
// The devil in the detail: Petty Cash Monit and Grab for Business, the two
// places where money leaves in many small pieces. Every figure is a posted
// ledger line; the Grab import adds who took the ride and where it went.
const GRAB_COLOR = { Express: "#c87a08", Transport: "#00a2b6", Food: "#1f9d57", Other: "#9aa6b1" };
const EX_PAGE = 50;          // rows per page in the Every movement / Every transaction tables

// Page numbers under a long table: first, last, and two either side of the
// current page, with an ellipsis for the gaps. onPage(n) redraws the table.
function exPager(box, total, page, onPage) {
  const pages = Math.max(1, Math.ceil(total / EX_PAGE));
  if (total <= EX_PAGE) { box.innerHTML = ""; return; }
  const want = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) want.add(p);
  const nums = [...want].sort((a, b) => a - b);
  let html = `<button class="ex-pg" data-p="${page - 1}" ${page <= 1 ? "disabled" : ""}>&lsaquo; ${t("Prev")}</button>`;
  nums.forEach((p, i) => {
    if (i && p - nums[i - 1] > 1) html += `<span class="ex-pg-gap">…</span>`;
    html += `<button class="ex-pg ${p === page ? "active" : ""}" data-p="${p}">${p}</button>`;
  });
  html += `<button class="ex-pg" data-p="${page + 1}" ${page >= pages ? "disabled" : ""}>${t("Next")} &rsaquo;</button>`;
  html += `<span class="muted ex-pg-info">${t("Showing")} ${fmt((page - 1) * EX_PAGE + 1)}–${fmt(Math.min(total, page * EX_PAGE))} ${t("of")} ${fmt(total)} · ${t("page")} ${page} / ${pages}</span>`;
  box.innerHTML = html;
  box.querySelectorAll(".ex-pg[data-p]").forEach(b => b.onclick = () => {
    const p = parseInt(b.dataset.p, 10);
    if (p >= 1 && p <= pages && p !== page) onPage(p);
  });
}

function exDonutItems(list, labelOf, valueOf, n = 7) {
  const sorted = list.filter(x => valueOf(x) > 0).sort((a, b) => valueOf(b) - valueOf(a));
  const top = sorted.slice(0, n).map((x, i) => ({ label: labelOf(x), value: valueOf(x), color: PALETTE[i % PALETTE.length] }));
  const rest = sorted.slice(n).reduce((a, x) => a + valueOf(x), 0);
  if (rest > 0) top.push({ label: t("Everything else"), value: rest, color: "#c9d1d9" });
  return top;
}

function exShareTable(list, total, emptyMsg) {
  if (!list.length) return `<div class="empty">${emptyMsg}</div>`;
  return `<table class="tbl"><thead><tr><th>${t("Account")}</th><th class="num">#</th><th class="num">${t("Amount")}</th><th style="width:34%">${t("Share")}</th></tr></thead>
    <tbody>${list.map(r => { const pct = total ? r.amount / total * 100 : 0; return `<tr>
      <td><b>${esc(r.code || "")}</b> ${esc(r.name || "")}</td><td class="num muted">${r.count}</td>
      <td class="num">${fmt(r.amount)}</td>
      <td><div class="ex-bar"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></div><span class="muted" style="font-size:11px">${pct.toFixed(1)}%</span></td></tr>`; }).join("")}</tbody></table>`;
}

async function pageExpenses(el) {
  if (state.exMonth == null) state.exMonth = "";
  if (!state.exGrabBy) state.exGrabBy = "service";
  const qs = `${scopeQS()}${state.exMonth ? "&month=" + state.exMonth : ""}`;
  el.innerHTML = `
    <div class="page-head"><h2>${t("Expense Breakdown")} <span class="muted" style="font-size:13px;font-weight:500">· ${t("Devil in Detail — Petty Cash Monit & Grab Business Input")}</span></h2>
      <div class="page-actions">
        <label class="muted">${t("Period")} <select id="exMonth">
          <option value="">${t("Whole year")} ${state.year}</option>
          ${MONTH_NAMES.map((m, i) => `<option value="${i + 1}" ${String(state.exMonth) === String(i + 1) ? "selected" : ""}>${t(m)} ${state.year}</option>`).join("")}
        </select></label>
      </div></div>
    <div id="exBody"><div class="card"><div class="empty">${t("Reading the ledger…")}</div></div></div>`;
  const root = $("#exBody");
  $("#exMonth").onchange = e => { state.exMonth = e.target.value; pageExpenses(el); };
  let d;
  try { d = await api("/api/expense-detail?" + qs); }
  catch (e) { root.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
  if (!document.body.contains(root)) return;
  $("#scopeBadge").textContent = d.scope;
  const P = d.petty, G = d.grab;
  const multi = (P.accounts.length + G.accounts.length) > 1 || state.companyId === "all";
  const period = state.exMonth ? `${t(MONTH_NAMES[state.exMonth - 1])} ${d.year}` : `${d.year}`;

  root.innerHTML = `
    <div class="ex-two">
      <div class="card"><h3>${t("Petty Cash Monit usage")} <span class="muted" style="font-weight:500">· ${period}</span></h3>
        <p class="muted" style="margin-top:-6px;font-size:12px">${t("Money out of petty cash, by the cost account it was spent on.")}</p>
        ${P.accounts.length ? chartDonut(exDonutItems(P.usage, x => `${x.code} ${x.name}`, x => x.amount), { size: 200 })
          : `<div class="empty">${t("No Petty Cash Monit account (1130) in this scope.")}</div>`}
      </div>
      <div class="card"><h3>${t("Grab Business Input usage")} <span class="muted" style="font-weight:500">· ${period}</span></h3>
        <div class="seg-group" id="exGrabBy" style="margin:-4px 0 8px">
          ${[["service", t("By type")], ["person", t("By person")], ["account", t("By account")]].map(([k, l]) =>
            `<button class="seg ${state.exGrabBy === k ? "active" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
        <div id="exGrabDonut"></div>
      </div>
    </div>

    <div class="card mt"><h3>${t("Petty Cash Monit — money in and out")}</h3>
      ${P.accounts.length ? `<p class="muted" style="margin-top:-6px;font-size:12px">${P.accounts.map(a => `${esc(a.company_code)} ${esc(a.code)} ${esc(a.name)}`).join(" · ")}</p>` : ""}
      <div class="ex-kpis">
        ${exTile(t("Opening balance"), P.opening, `${t("on")} ${fmtDate(P.start)}`)}
        ${exTile(t("Money in (top-ups)"), P.in_total, `${P.sources.reduce((a, s) => a + s.count, 0)} ${t("movements")}`, "pos")}
        ${exTile(t("Money out (spent)"), P.out_total, `${P.usage.reduce((a, s) => a + s.count, 0)} ${t("movements")}`, "neg")}
        ${exTile(t("Closing balance"), P.closing, `${t("on")} ${fmtDate(P.end)}`, P.closing < 0 ? "neg" : "")}
      </div>
      ${state.exMonth ? "" : `<div class="mt">${chartBars(P.months.map(m => t(MONTH_NAMES[parseInt(m.month.slice(5), 10) - 1])), [
        { name: t("In"), color: "#1f9d57", values: P.months.map(m => m.in) },
        { name: t("Out"), color: "#bd362f", values: P.months.map(m => -m.out) },
      ], { height: 210 })}</div>`}
      <div class="ex-two mt">
        <div><h4 class="ex-h4">${t("Where the money went (out)")}</h4>${exShareTable(P.usage, P.out_total, t("Nothing spent in this period."))}</div>
        <div><h4 class="ex-h4">${t("Where it came from (in)")}</h4>${exShareTable(P.sources, P.in_total, t("No top-ups in this period."))}</div>
      </div>
      <h4 class="ex-h4 mt">${t("Every movement")}</h4>
      <div class="filters" style="flex-wrap:wrap;gap:8px">
        <div class="seg-group" id="exPcDir">${[["", t("All")], ["in", t("In")], ["out", t("Out")]].map(([k, l]) =>
          `<button class="seg ${k === "" ? "active" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
        <select id="exPcAcc"><option value="">${t("Every account")}</option>${[...P.usage, ...P.sources].filter((x, i, arr) => arr.findIndex(y => y.code === x.code) === i)
          .map(x => `<option value="${esc(x.code)}">${esc(x.code)} ${esc(x.name)}</option>`).join("")}</select>
        <input id="exPcQ" placeholder="${t("Search description or entry no.")}" style="min-width:220px">
        <span class="muted" id="exPcCount"></span>
      </div>
      <div class="pf-scroll"><table class="tbl ex-tbl"><thead><tr><th>${t("Date")}</th><th>${t("Entry")}</th><th>${t("Description")}</th>
        ${multi ? `<th>${t("Company")}</th>` : ""}<th>${t("Account")}</th><th>${t("Project")}</th>
        <th class="num">${t("In")}</th><th class="num">${t("Out")}</th><th class="num">${t("Balance")}</th></tr></thead>
        <tbody id="exPcRows"></tbody></table></div>
      <div class="ex-pager" id="exPcPager"></div>
    </div>

    <div class="card mt"><h3>${t("Grab Business Input — per person and per trip")}</h3>
      ${G.accounts.length ? `<p class="muted" style="margin-top:-6px;font-size:12px">${G.accounts.map(a => `${esc(a.company_code)} ${esc(a.code)} ${esc(a.name)}`).join(" · ")}</p>` : ""}
      <div class="ex-kpis">
        ${exTile(t("Grab spending"), G.total, `${G.count} ${t("rides, deliveries & orders")}`, "neg")}
        ${exTile(t("People"), null, G.people ? `${t("average")} ${fmtRp(G.total / G.people)} ${t("each")}` : "", "", String(G.people))}
        ${exTile(t("Average per transaction"), G.average, "")}
        ${exTile(t("Still owed to Grab"), -Math.min(0, G.closing), G.accounts.length ? `${t("billed")} ${fmt(G.billed)} · ${t("settled")} ${fmt(G.settled)}` : t("no CORP PAY - GRAB account"), G.closing < 0 ? "neg" : "")}
      </div>
      ${G.count ? `
      <h4 class="ex-h4 mt">${t("Per person")}</h4>
      <div class="pf-scroll"><table class="tbl ex-tbl"><thead><tr><th>${t("Person")}</th><th>${t("Group")}</th>
        ${["Express", "Transport", "Food"].map(s => `<th class="num"><span class="dot" style="background:${GRAB_COLOR[s]}"></span> ${t(s)}</th>`).join("")}
        <th class="num">#</th><th class="num">${t("Total")}</th></tr></thead>
        <tbody>${G.by_person.map(p => `<tr class="ex-person" data-p="${esc(p.employee)}" style="cursor:pointer" title="${t("Show this person's trips")}">
          <td><b>${esc(p.employee)}</b></td><td class="muted">${esc(p.group || "")}</td>
          ${["Express", "Transport", "Food"].map(s => { const v = (p.services[s] || {}); return `<td class="num">${v.amount ? fmt(v.amount) + ` <span class="muted">(${v.count})</span>` : "—"}</td>`; }).join("")}
          <td class="num muted">${p.count}</td><td class="num"><b>${fmt(p.total)}</b></td></tr>`).join("")}
          <tr class="total"><td colspan="2"><b>${t("TOTAL")}</b></td>
          ${["Express", "Transport", "Food"].map(s => { const v = G.by_service.find(x => x.service === s) || {}; return `<td class="num"><b>${fmt(v.amount || 0)}</b></td>`; }).join("")}
          <td class="num"><b>${G.count}</b></td><td class="num"><b>${fmt(G.total)}</b></td></tr></tbody></table></div>
      <h4 class="ex-h4 mt">${t("Every transaction")}</h4>
      <div class="filters" style="flex-wrap:wrap;gap:8px">
        <div class="seg-group" id="exGrSvc">${[["", t("All")], ["Express", t("Express")], ["Transport", t("Transport")], ["Food", t("Food")]].map(([k, l]) =>
          `<button class="seg ${k === "" ? "active" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
        <select id="exGrPerson"><option value="">${t("Everyone")}</option>${G.by_person.map(p => `<option value="${esc(p.employee)}">${esc(p.employee)}</option>`).join("")}</select>
        <input id="exGrQ" placeholder="${t("Search place, merchant, cost code…")}" style="min-width:220px">
        <span class="muted" id="exGrCount"></span>
      </div>
      <div class="pf-scroll"><table class="tbl ex-tbl"><thead><tr><th>${t("Date")}</th><th>${t("Person")}</th><th>${t("Type")}</th>
        <th>${t("Service")}</th><th style="min-width:220px">${t("Route / merchant")}</th><th>${t("Cost code")}</th><th>${t("Booking ID")}</th>
        <th>${t("Account")}</th><th class="num">${t("Amount")}</th><th>${t("Entry")}</th></tr></thead>
        <tbody id="exGrRows"></tbody></table></div>
      <div class="ex-pager" id="exGrPager"></div>`
      : `<div class="empty mt">${t("No Grab bookings in this period. Import the Grab for Business CSVs in Account Parsing → GRAB BUSINESS INPUT.")}</div>`}
    </div>`;

  // ---- Grab donut (type / person / account) ----
  const grabDonut = () => {
    const by = state.exGrabBy;
    const items = by === "service"
      ? G.by_service.filter(s => s.amount > 0).map(s => ({ label: `${t(s.service)} (${s.count})`, value: s.amount, color: GRAB_COLOR[s.service] || GRAB_COLOR.Other }))
      : by === "person" ? exDonutItems(G.by_person, p => p.employee, p => p.total)
      : exDonutItems(G.by_account, a => `${a.code} ${a.name}`, a => a.amount);
    $("#exGrabDonut").innerHTML = items.length ? chartDonut(items, { size: 200 }) : `<div class="empty">${t("No Grab bookings in this period.")}</div>`;
  };
  $$("#exGrabBy .seg").forEach(b => b.onclick = () => {
    state.exGrabBy = b.dataset.k;
    $$("#exGrabBy .seg").forEach(x => x.classList.toggle("active", x === b));
    grabDonut();
  });
  grabDonut();

  // ---- petty cash movements ----
  let pcDir = "", pcPage = 1;
  const pcRows = () => {
    const q = ($("#exPcQ").value || "").toLowerCase(), acc = $("#exPcAcc").value;
    const list = P.rows.filter(r => (!pcDir || r.direction === pcDir)
      && (!acc || r.counter.some(c => c.code === acc))
      && (!q || `${r.description} ${r.entry_no} ${r.reference}`.toLowerCase().includes(q))).slice().reverse();
    $("#exPcCount").textContent = `${list.length} ${t("movements")}` + (list.length ? ` · ${t("in")} ${fmt(list.reduce((a, r) => a + r.in, 0))} · ${t("out")} ${fmt(list.reduce((a, r) => a + r.out, 0))}` : "");
    const pcPages = Math.max(1, Math.ceil(list.length / EX_PAGE));
    if (pcPage > pcPages) pcPage = pcPages;
    $("#exPcRows").innerHTML = list.slice((pcPage - 1) * EX_PAGE, pcPage * EX_PAGE).map(r => `<tr data-id="${r.entry_id}" class="ex-open">
      <td>${fmtDate(r.date)}</td><td><b style="font-size:12px">${esc(r.entry_no)}</b></td>
      <td>${esc(r.description)}</td>${multi ? `<td>${esc(r.company_code)}</td>` : ""}
      <td>${r.counter.map(c => `<span title="${esc(c.name)}">${esc(c.code || "—")}</span> <span class="muted">${esc(c.name)}</span>`).join("<br>")}</td>
      <td class="muted">${esc(r.projects.join(", "))}</td>
      <td class="num pos">${r.in ? fmt(r.in) : ""}</td><td class="num neg">${r.out ? fmt(r.out) : ""}</td>
      <td class="num">${fmt(r.balance)}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">${t("Nothing matches.")}</td></tr>`;
    exPager($("#exPcPager"), list.length, pcPage, p => { pcPage = p; pcRows();
      $("#exPcDir").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $$("#exPcRows .ex-open").forEach(tr => tr.onclick = () => viewJournal(parseInt(tr.dataset.id, 10), () => pageExpenses(el)));
  };
  $$("#exPcDir .seg").forEach(b => b.onclick = () => {
    pcDir = b.dataset.k; pcPage = 1;
    $$("#exPcDir .seg").forEach(x => x.classList.toggle("active", x === b)); pcRows();
  });
  $("#exPcAcc").onchange = () => { pcPage = 1; pcRows(); };
  $("#exPcQ").oninput = () => { pcPage = 1; pcRows(); };
  pcRows();

  // ---- grab trips ----
  if (!G.count) return;
  let grSvc = "", grPage = 1;
  const grRows = () => {
    const q = ($("#exGrQ").value || "").toLowerCase(), who = $("#exGrPerson").value;
    const list = G.trips.filter(r => (!grSvc || r.service === grSvc) && (!who || r.employee === who)
      && (!q || `${r.pickup} ${r.dropoff} ${r.merchant} ${r.items} ${r.cost_code} ${r.trip_description} ${r.booking_id} ${r.employee}`.toLowerCase().includes(q))).slice().reverse();
    $("#exGrCount").textContent = `${list.length} ${t("transactions")} · ${fmtRp(list.reduce((a, r) => a + r.amount, 0))}`;
    const grPages = Math.max(1, Math.ceil(list.length / EX_PAGE));
    if (grPage > grPages) grPage = grPages;
    $("#exGrRows").innerHTML = list.slice((grPage - 1) * EX_PAGE, grPage * EX_PAGE).map(r => {
      const route = r.service === "Food"
        ? `<b>${esc(r.merchant)}</b>${r.items ? `<br><span class="muted" style="font-size:11.5px">${esc(r.items)}</span>` : ""}`
        : `${esc(r.pickup || "?")} &rarr; ${esc(r.dropoff || "?")}`;
      return `<tr data-id="${r.entry_id}" class="ex-open">
        <td>${fmtDate(r.date)}<br><span class="muted">${esc(r.time || "")}</span></td>
        <td><b>${esc(r.employee)}</b><br><span class="muted">${esc(r.employee_group || "")}</span></td>
        <td><span class="ex-chip" style="background:${GRAB_COLOR[r.service] || GRAB_COLOR.Other}">${esc(t(r.service))}</span></td>
        <td class="muted">${esc(r.service_type || "")}</td><td>${route}</td>
        <td>${esc(r.cost_code || "")}${r.trip_description ? `<br><span class="muted">${esc(r.trip_description)}</span>` : ""}</td>
        <td style="font-size:11.5px">${esc(r.booking_id || "")}</td>
        <td><span title="${esc(r.account_name)}">${esc(r.account_code)}</span>${r.project_code ? `<br><span class="muted">${esc(r.project_code)}</span>` : ""}</td>
        <td class="num"><b>${fmt(r.amount)}</b></td><td style="font-size:12px">${esc(r.entry_no)}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="empty">${t("Nothing matches.")}</td></tr>`;
    exPager($("#exGrPager"), list.length, grPage, p => { grPage = p; grRows();
      $("#exGrSvc").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $$("#exGrRows .ex-open").forEach(tr => tr.onclick = () => viewJournal(parseInt(tr.dataset.id, 10), () => pageExpenses(el)));
  };
  $$("#exGrSvc .seg").forEach(b => b.onclick = () => {
    grSvc = b.dataset.k; grPage = 1;
    $$("#exGrSvc .seg").forEach(x => x.classList.toggle("active", x === b)); grRows();
  });
  $("#exGrPerson").onchange = () => { grPage = 1; grRows(); };
  $("#exGrQ").oninput = () => { grPage = 1; grRows(); };
  $$("#exBody .ex-person").forEach(tr => tr.onclick = () => {
    $("#exGrPerson").value = tr.dataset.p; grPage = 1; grRows();
    $("#exGrPerson").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  grRows();
}

function exTile(label, value, sub, cls, text) {
  return `<div class="kpi ex-kpi"><div class="kpi-label">${label}</div>
    <div class="kpi-value ${cls || ""}" ${value != null ? `title="${fmtRp(value)}"` : ""}>${text != null ? esc(text) : fmtShortRp(value)}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;
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
      <td class="muted">${esc(fmtDate(it.invoice_date))}</td>
      <td>${esc(fmtDate(it.due_date))}</td>
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

/* ------------------------------------------------------------------ payables (AP aging / Hutang) */
async function pagePayables(el) {
  const today = new Date().toISOString().slice(0, 10);
  if (!state.apAsOf) state.apAsOf = today;
  const cid = state.companyId === "all" ? "all" : parseInt(state.companyId, 10);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Payables")} — ${t("AP Aging (Hutang)")}</h2>
      <div class="page-actions">
        <label class="muted">${t("Company")} <select id="apCompany">${companyOptions(cid, { includeAll: true })}</select></label>
        <label class="muted">${t("As of")} <input type="date" id="apAsOf" value="${state.apAsOf}"></label>
        <a class="btn btn-sm" id="apExp">&#x2913; ${t("Export Excel")}</a>
        ${canWrite() ? `<button class="btn btn-sm btn-primary" id="apNew">+ ${t("Add Bill")}</button>` : ""}
      </div></div>
    <div id="apBody"><div class="empty">Loading…</div></div>`;
  const scopeFor = () => $("#apCompany").value;
  const load = async () => {
    state.apAsOf = $("#apAsOf").value || today;
    const qs = `company_id=${scopeFor()}&as_of=${state.apAsOf}`;
    $("#apExp").href = `/api/export/payables?${qs}`;
    const d = await api(`/api/payables?${qs}`);
    $("#scopeBadge").textContent = d.scope;
    const consol = scopeFor() === "all";
    const bcell = (it, b) => it.bucket === b ? `<b>${fmt(it.outstanding)}</b>` : `<span class="muted">-</span>`;
    const rows = d.items.map((it, i) => `<tr>
      <td>${i + 1}</td>
      ${consol ? `<td>${esc(it.company_code)}</td>` : ""}
      <td><b>${esc(it.vendor)}</b></td>
      <td>${esc(it.bill_no)}</td>
      <td class="muted">${esc(fmtDate(it.bill_date))}</td>
      <td>${esc(fmtDate(it.due_date))}</td>
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
    </tr>`).join("") || `<tr><td colspan="${14 + (consol ? 1 : 0) + (canWrite() ? 1 : 0)}" class="empty">No bills yet — add one to start tracking AP aging.</td></tr>`;
    const totalRow = `<tr class="total"><td colspan="${consol ? 7 : 6}">${t("TOTAL")}</td>
      <td class="num">${fmt(d.total_outstanding)}</td>
      <td class="num">${fmt(d.buckets.not_due)}</td><td class="num">${fmt(d.buckets.d1_30)}</td>
      <td class="num">${fmt(d.buckets.d31_60)}</td><td class="num">${fmt(d.buckets.d61_90)}</td>
      <td class="num">${fmt(d.buckets.d90)}</td><td colspan="${canWrite() ? 3 : 2}"></td></tr>`;
    $("#apBody").innerHTML = `
      <div class="card"><div style="overflow-x:auto"><table class="tbl ar-tbl">
        <thead><tr><th>No</th>${consol ? "<th>Co.</th>" : ""}<th>${t("Vendor")}</th><th>${t("Bill")}</th>
          <th>${t("Bill Date")}</th><th>${t("Due Date")}</th><th class="num">${t("Amount")}</th><th class="num">${t("Outstanding")}</th>
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
            <div class="kpi ${d.risky > 0 ? "red" : ""}"><div class="kpi-label">${t("Overdue AP (> 90 days)")}</div><div class="kpi-value">${fmtShortRp(d.risky)}</div>
              <div class="kpi-sub">${d.total_outstanding ? Math.round(100 * d.risky / d.total_outstanding) : 0}% of outstanding</div></div>
          </div>
          <p class="muted mt">Enter only the bill fields (vendor, bill, dates, amount, paid) — buckets, days late and status are computed, mirroring the Hutang side of your Excel.</p>
        </div>
      </div>`;
    $$("#apBody [data-edit]").forEach(b => b.onclick = () => payableEditor(d.items.find(x => x.id == b.dataset.edit), load));
  };
  $("#apCompany").onchange = load;
  $("#apAsOf").onchange = load;
  if ($("#apNew")) $("#apNew").onclick = () => payableEditor(null, load);
  await load();
}

function payableEditor(r, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const newCompany = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  openModal(`<div class="form-grid">
    ${r ? "" : `<label class="full">Company <select id="pvCompany">${companyOptions(newCompany)}</select></label>`}
    <label class="full">Vendor <input id="pvVendor" value="${esc(r ? r.vendor : "")}" placeholder="e.g. PT Sumber Rejeki"></label>
    <label>Bill No <input id="pvBill" value="${esc(r ? r.bill_no : "")}" placeholder="BILL-2026-051"></label>
    <label>Bill Date <input type="date" id="pvBdate" value="${esc(r ? (r.bill_date || "") : today)}"></label>
    <label>Due Date <input type="date" id="pvDue" value="${esc(r ? (r.due_date || "") : "")}"></label>
    <label>Amount (Rp) <input id="pvAmount" inputmode="numeric" value="${r ? fmt(r.amount) : ""}"></label>
    <label>Paid (Rp) <input id="pvPaid" inputmode="numeric" value="${r ? fmt(r.paid) : "0"}"></label>
    <label class="full">Notes <input id="pvNotes" value="${esc(r ? r.notes : "")}"></label>
    </div><div class="form-actions">
      ${r ? `<button class="btn btn-danger" id="pvDel">Delete</button>` : ""}
      <button class="btn btn-primary" id="pvSave">Save bill</button></div>`,
    { title: r ? "Edit payable" : "New payable", small: true });
  const numv = id => parseInt(($("#" + id).value || "0").replace(/[^\d-]/g, ""), 10) || 0;
  $("#pvSave").onclick = async () => {
    const body = {
      vendor: $("#pvVendor").value, bill_no: $("#pvBill").value,
      bill_date: $("#pvBdate").value || null, due_date: $("#pvDue").value || null,
      amount: numv("pvAmount"), paid: numv("pvPaid"), notes: $("#pvNotes").value,
    };
    try {
      if (r) await api("/api/payables/" + r.id, { method: "PUT", json: body });
      else await api("/api/payables", { json: Object.assign(body, { company_id: parseInt($("#pvCompany").value, 10) }) });
      toast("Payable saved"); closeModal(); reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#pvDel")) $("#pvDel").onclick = async () => {
    if (!confirm("Delete this bill from AP aging?")) return;
    try { await api("/api/payables/" + r.id, { method: "DELETE" }); toast("Deleted"); closeModal(); reload(); }
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
    <div class="page-head"><h2>${t("Investment Center")}</h2>
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
      <table class="tbl"><thead><tr><th style="width:52px"></th><th>Initiative</th><th>Category</th><th>Company</th><th>Linked project</th>
        <th class="num">Committed</th><th class="num">Invested</th><th>Progress</th>
        <th class="num">Benefits</th><th class="num">Payback</th><th>Status</th><th style="min-width:170px"></th></tr></thead>
      <tbody>${rows.map(r => {
        const prog = r.committed_amount ? Math.min(100, Math.round(100 * r.invested / r.committed_amount)) : 0;
        const payback = r.invested ? Math.round(100 * r.benefit / r.invested) : null;
        return `<tr>
          <td class="ent-cell">${entThumb("investment", r.id, r.image_v, r.name)}</td>
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
      }).join("") || `<tr><td colspan="12" class="empty">No investments yet — add the first initiative</td></tr>`}</tbody></table>
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
    ${entImageField("investment", inv ? inv.id : null, inv ? inv.image_v : null, inv ? inv.name : "")}
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
  const imgBox = wireEntImageField($("#modalRoot") || document, inv ? inv.name : "", () => reload());
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
      else {
        const made = await api("/api/investments", { json: body });
        if (imgBox && imgBox.pending) await entImageUpload("investment", made.id, imgBox.pending);
      }
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
  const [inv, comments, thr] = await Promise.all([
    api("/api/investments/" + iid),
    api("/api/investments/" + iid + "/comments").catch(() => []),
    api("/api/settings/thresholds").catch(() => ({ thresholds: {} })),
  ]);
  const payback = inv.invested ? Math.round(100 * inv.benefit / inv.invested) : null;
  const analysis = payback == null
    ? "No outflows recorded yet."
    : payback >= 100
      ? `<b class="pos">Paid back</b> — benefits cover ${payback}% of invested capital.`
      : `Benefits cover <b>${payback}%</b> of invested capital — payback pending over the ${inv.horizon_years}-year horizon.`;
  // Contribution margin = (PIC/salesperson cost + other investment cost) / total sales-or-benefit
  const pic = inv.cm_pic_cost || 0, other = inv.cm_other_cost || 0, base = inv.cm_total_benefit || 0;
  const cm = base ? (pic + other) / base : null;
  const cmt = (thr.thresholds || {}).cm_ratio || { healthy: 0.4, watch: 0.6, dir: "low" };
  const cmStatus = cm == null ? "n/a"
    : cm <= cmt.healthy ? "healthy" : cm <= cmt.watch ? "watch" : "danger";
  const cmVerdict = { healthy: ["green", "Healthy", "cost is well within the threshold — an efficient investment."],
    watch: ["", "Watch", "approaching the cost ceiling — monitor the spend vs benefit."],
    danger: ["red", "Over threshold", "cost per unit of benefit exceeds the limit — review this investment."],
    "n/a": ["", "—", "enter the total sales / benefit to compute the contribution margin."] }[cmStatus];
  openModal(`
    <div class="muted">${INV_CATEGORIES[inv.category] || inv.category} · ${esc(inv.company_code)} ·
      started ${esc(inv.start_date ? fmtDate(inv.start_date) : "?")} · horizon ${inv.horizon_years} years
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
    ${invProgressCard(inv)}

    <div class="card" style="margin-top:14px;background:var(--panel)">
      <div class="page-head"><h3 style="margin:0">${t("Contribution Margin")}</h3>
        ${canWrite() ? `<button class="btn btn-sm btn-primary" id="cmSave">Save</button>` : ""}</div>
      <p class="muted" style="margin-top:-6px">(PIC / salesperson cost + other investment cost) ÷ total sales or benefit.
        Lower is better — a smaller cost per unit of benefit.</p>
      <div class="form-grid">
        <label>PIC / salesperson cost (Rp) <input id="cmPic" inputmode="numeric" ${canWrite() ? "" : "disabled"} value="${pic ? fmt(pic) : ""}"></label>
        <label>Other investment cost (Rp) <input id="cmOther" inputmode="numeric" ${canWrite() ? "" : "disabled"} value="${other ? fmt(other) : ""}"></label>
        <label>Total sales / benefit (Rp) <input id="cmBase" inputmode="numeric" ${canWrite() ? "" : "disabled"} value="${base ? fmt(base) : ""}"></label>
      </div>
      <div class="grid kpis" style="margin-top:10px">
        <div class="kpi ${cmVerdict[0]}"><div class="kpi-label">${t("Contribution Margin")}</div>
          <div class="kpi-value">${cm == null ? "—" : fmtPct(cm)}</div>
          <div class="kpi-sub">${cm == null ? "" : "cost / benefit"}</div></div>
        <div class="kpi"><div class="kpi-label">Total cost</div><div class="kpi-value">${fmtShortRp(pic + other)}</div></div>
        <div class="kpi"><div class="kpi-label">Threshold</div><div class="kpi-value">${fmtPct(cmt.healthy)}<span class="muted" style="font-size:12px"> / ${fmtPct(cmt.watch)}</span></div>
          <div class="kpi-sub">healthy / watch · Settings → Thresholds</div></div>
      </div>
      <p class="mt"><span class="pill ${HEALTH_PILL[cmStatus] || "inactive"}">${cmVerdict[1]}</span> ${cmVerdict[2]}</p>
    </div>

    <div id="ivCommit"></div>
    <h3 style="margin-top:16px">${t("Entries")}</h3>
    <table class="tbl"><thead><tr><th>Date</th><th>Type</th><th>Description</th>
      <th class="num">Amount</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
      <tbody>${inv.events.map(e => `<tr>
        <td>${esc(fmtDate(e.date))}</td>
        <td><span class="pill ${e.kind === "benefit" ? "posted" : "draft"}">${e.kind}</span></td>
        <td>${esc(e.description)}</td><td class="num">${fmt(e.amount)}</td>
        ${canWrite() ? `<td><button class="btn btn-sm btn-ghost" data-del-ev="${e.id}">&times;</button></td>` : ""}</tr>`).join("") ||
        `<tr><td colspan="5" class="empty">No entries yet</td></tr>`}</tbody></table>
    <div class="form-actions">
      ${canWrite() ? `<button class="btn btn-primary" id="ivAddEntry">+ Add Entry</button>` : ""}
    </div>

    <h3 style="margin-top:16px">${t("Discussion")}</h3>
    <div id="cmComments" style="max-height:220px;overflow:auto">${renderInvComments(comments)}</div>
    <div class="filters" style="margin-top:8px">
      <input id="cmNewComment" placeholder="${t("Add a comment for the team…")}" style="flex:1;min-width:200px">
      <button class="btn btn-primary" id="cmPostComment">${t("Post")}</button>
    </div>`, { title: inv.name });
  renderInvestmentCommitments(iid, () => investmentDetail(iid, reload));
  invWireMilestones(iid, () => investmentDetail(iid, reload));
  const numv = id => parseInt(($("#" + id).value || "0").replace(/[^\d-]/g, ""), 10) || 0;
  if ($("#cmSave")) $("#cmSave").onclick = async () => {
    try {
      await api("/api/investments/" + iid + "/cm", { method: "PUT", json: {
        cm_pic_cost: numv("cmPic"), cm_other_cost: numv("cmOther"), cm_total_benefit: numv("cmBase") } });
      toast("Contribution margin saved"); investmentDetail(iid, reload);
    } catch (e) { toast(e.message, true); }
  };
  const postComment = async () => {
    const bodyv = $("#cmNewComment").value.trim();
    if (!bodyv) return;
    try { await api("/api/investments/" + iid + "/comments", { json: { body: bodyv } });
      $("#cmNewComment").value = "";
      $("#cmComments").innerHTML = renderInvComments(await api("/api/investments/" + iid + "/comments"));
      bindInvCommentDeletes(iid, reload);
    } catch (e) { toast(e.message, true); }
  };
  $("#cmPostComment").onclick = postComment;
  $("#cmNewComment").onkeydown = e => { if (e.key === "Enter") postComment(); };
  bindInvCommentDeletes(iid, reload);
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

function renderInvComments(comments) {
  if (!comments || !comments.length)
    return `<p class="muted">No comments yet — start the discussion.</p>`;
  return comments.map(c => `<div class="cm-comment" style="padding:8px 0;border-bottom:1px solid var(--border)">
    <div style="display:flex;justify-content:space-between;gap:8px">
      <b>${esc(c.author || "—")}</b>
      <span class="muted" style="font-size:11px">${esc(fmtInputStamp(c.created_at))}
        ${canWrite() ? `<a href="#" class="cm-del" data-cid="${c.id}" style="margin-left:8px">delete</a>` : ""}</span>
    </div>
    <div style="white-space:pre-wrap">${esc(c.body)}</div></div>`).join("");
}

function bindInvCommentDeletes(iid, reload) {
  $$("#cmComments .cm-del").forEach(a => a.onclick = async e => {
    e.preventDefault();
    if (!confirm("Delete this comment?")) return;
    try { await api("/api/investment-comments/" + a.dataset.cid, { method: "DELETE" });
      $("#cmComments").innerHTML = renderInvComments(await api("/api/investments/" + iid + "/comments"));
      bindInvCommentDeletes(iid, reload);
    } catch (err) { toast(err.message, true); }
  });
}

/* ------------------------------------------------------------------ budget center */
// ONE place to set the budget: company level and project level, revenue and
// expense, at WEEK grain. A month is always four weeks and W4 runs to the end of
// the month, so nothing can be budgeted into a week that does not exist.
//
// There is deliberately no separate "cash plan" any more. Two screens holding
// two versions of the same intention is how they drift apart, and the Oracle
// reads THIS table directly - what finance types here is what the forecast sees.

// W1 1-7, W2 8-14, W3 15-21, W4 22-end. The last bucket absorbs the odd days so
// a 28-day February and a 31-day March have the same four columns.
function weekRanges(year, month) {
  const last = new Date(year, month, 0).getDate();
  return [1, 2, 3, 4].map(w => ({
    week: w,
    start: (w - 1) * 7 + 1,
    end: w === 4 ? last : Math.min(w * 7, last),
  }));
}

async function pageBudgets(el) {
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  if (!state.bcView) state.bcView = "weeks";
  if (!state.bcScope) state.bcScope = "company";

  el.innerHTML = `
    <div class="page-head"><h2>${t("Budget Center")} — ${state.year}</h2>
      <div class="page-actions">
        <label class="muted">${t("Company")} <select id="bCompany">${companyOptions(cid)}</select></label>
        <button class="btn" id="bTemplate">&#x2913; ${t("Template")}</button>
        ${canWrite() ? `<button class="btn" id="bImport">&#x2912; ${t("Import Excel")}</button>` : ""}
        <button class="btn" id="bExport">&#x2913; ${t("Export Excel")}</button>
        ${canWrite() ? `<button class="btn btn-primary" id="bSave">${t("Save Budget")}</button>` : ""}
      </div></div>

    <div class="tabs" id="bModes">
      <button data-m="company" class="${state.bcScope === "company" ? "active" : ""}">${t("Company level")}</button>
      <button data-m="project" class="${state.bcScope === "project" ? "active" : ""}">${t("Per project")}</button>
    </div>

    <div class="filters" id="bProjectBar" hidden>
      <label>${t("Project")} <select id="bProject" style="min-width:260px"></select></label>
      ${canWrite() ? `<button class="btn btn-sm" id="bNewProject">+ ${t("New project")}</button>` : ""}
      <button class="btn btn-sm" id="bExportAllPrj" title="${t("One workbook with every project's budget, each row carrying its project code")}">&#x2913; ${t("Export all projects")}</button>
      <span class="muted">${t("Projects belong to the selected company. The budget below is for this project only.")}</span>
    </div>

    <div class="filters bc-bar">
      <div class="seg-group" id="bView">
        <button class="seg ${state.bcView === "weeks" ? "active" : ""}" data-v="weeks">${t("Weekly (4 weeks a month)")}</button>
        <button class="seg ${state.bcView === "months" ? "active" : ""}" data-v="months">${t("Month roll-up")}</button>
      </div>
      ${canWrite() ? `<button class="btn btn-sm" id="bToW1" title="${t("Move each month's whole budget into its first week")}">${t("Monthly → Week 1")}</button>` : ""}
      <button class="btn btn-sm" id="bOracle">&#x263E; ${t("Ask the Oracle")}</button>
      <span class="muted" id="bcTotals"></span>
    </div>

    <div class="card budget-wrap"><div id="bGrid"></div>
      ${canWrite() ? `<div class="mt filters">
        <label>${t("Add account to budget")} <select id="bAddAcc" style="min-width:280px"></select></label>
        <label>${t("Remove account from budget")} <select id="bRemAcc" style="min-width:280px"></select></label>
        <span class="muted">${t("Amounts are in IDR. Certainty drives the Oracle: only 'committed' money in counts in the Bound run.")}</span></div>` : ""}
    </div>

    <div class="card mt"><h3 id="bvaTitle">${t("Budget vs Realization")} — ${state.year}</h3><div id="bvaBox"></div>
      <div class="mt"><a class="btn btn-sm" id="bvaExport">&#x2913; ${t("Export Budget vs Realization")}</a></div>
    </div>`;

  let rows = [], projectId = null, projectList = [], certainties = ["committed", "planned", "expected", "speculative"];
  const mode = () => state.bcScope;
  const company = () => $("#bCompany").value;
  const pid = () => (mode() === "project" ? projectId : null);
  const rowTotal = r => r.weeks.reduce((a, m) => a + m.reduce((x, y) => x + y, 0), 0);
  const monthTotal = (r, mi) => r.weeks[mi].reduce((x, y) => x + y, 0);

  async function refreshProjects() {
    projectList = await api("/api/projects?company_id=" + company());
    const sel = $("#bProject");
    if (!sel) return;                       // the page was left while this was in flight
    sel.innerHTML = projectList.length
      ? projectList.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join("")
      : `<option value="">${t("(no projects in this company yet)")}</option>`;
    if (!projectList.find(p => String(p.id) === String(projectId)))
      projectId = projectList.length ? projectList[0].id : null;
    sel.value = projectId || "";
  }

  // Every await below can land after the user has moved to another page, and
  // writing to elements that no longer exist is how a quiet console fills up.
  // The router swaps what is INSIDE the page container, so the container itself
  // is no test - this page's own root node is.
  const pageRoot = $("#bModes");
  const gone = () => !document.body.contains(pageRoot);

  async function load() {
    if (gone()) return;
    $("#bProjectBar").hidden = mode() !== "project";
    if (mode() === "project") {
      await refreshProjects();
      if (gone()) return;
      if (!projectId) {
        rows = [];
        renderGrid();
        if ($("#bAddAcc")) $("#bAddAcc").innerHTML = "";
        if ($("#bRemAcc")) $("#bRemAcc").innerHTML = "";
        if ($("#bvaBox"))
          $("#bvaBox").innerHTML = `<div class="empty">${t("Create a project in this company to budget for it.")}</div>`;
        return;
      }
    }
    const targetPid = pid();
    const data = await api(`/api/budgets?company_id=${company()}&year=${state.year}`);
    if (gone()) return;
    certainties = data.certainties || certainties;
    rows = data.rows
      .filter(r => (mode() === "project" ? String(r.project_id) === String(targetPid) : !r.project_id))
      .map(r => ({ ...r, weeks: r.weeks || r.amounts.map(a => [a, 0, 0, 0]) }));
    renderGrid();

    const accounts = await api("/api/accounts?company_id=" + company());
    if (gone()) return;
    function rebuildDropdowns() {
      const inGrid = new Set(rows.map(r => r.account_id));
      const addSel = $("#bAddAcc");
      if (addSel) {
        addSel.innerHTML = `<option value="">— ${t("choose account to add")} —</option>` +
          accounts.filter(a => a.is_active && !inGrid.has(a.id) && (a.type === "revenue" || a.type === "expense"))
            .map(a => `<option value="${a.id}" data-code="${esc(a.code)}" data-name="${esc(a.name)}" data-type="${a.type}">${esc(a.code)} ${esc(a.name)}</option>`).join("");
        addSel.onchange = () => {
          const o = addSel.selectedOptions[0];
          if (!o || !o.value) return;
          rows.push({
            account_id: parseInt(o.value, 10), code: o.dataset.code, name: o.dataset.name,
            type: o.dataset.type, project_id: targetPid, certainty: "planned", cf_class: "",
            weeks: Array.from({ length: 12 }, () => [0, 0, 0, 0]), amounts: Array(12).fill(0),
          });
          rows.sort((a, b) => a.code.localeCompare(b.code));
          renderGrid(); rebuildDropdowns(); addSel.value = "";
        };
      }
      const remSel = $("#bRemAcc");
      if (remSel) {
        remSel.innerHTML = `<option value="">— ${t("choose account to remove")} —</option>` +
          rows.map((r, ri) => `<option value="${ri}">${esc(r.code)} ${esc(r.name)}</option>`).join("");
        remSel.onchange = async () => {
          const r = rows[remSel.value];
          remSel.value = "";
          if (r) await removeRow(r);
        };
      }
    }
    rebuildDropdowns();

    const bvaUrl = mode() === "project"
      ? `/api/reports/project-budget-vs-actual?company_id=${company()}&project_id=${targetPid}&year=${state.year}`
      : `/api/reports/budget-vs-actual?company_id=${company()}&year=${state.year}`;
    const bva = await api(bvaUrl);
    if (gone()) return;
    renderBva(bva);
    const exp = $("#bvaExport");
    if (mode() === "project") { exp.style.display = "none"; }
    else { exp.style.display = ""; exp.href = `/api/export/budget-vs-actual?company_id=${company()}&year=${state.year}`; }
    $("#bvaTitle").textContent = mode() === "project"
      ? `${t("Budget vs Realization")} — ${($("#bProject").selectedOptions[0] || {}).text || "project"} (${state.year})`
      : `${t("Budget vs Realization")} — ${state.year}`;
  }

  async function removeRow(r) {
    if (!confirm(`${t("Remove")} ${r.code} ${r.name} ${t("from the")} ${state.year} ${t("budget?")}`)) return;
    try {
      await api(`/api/budgets?company_id=${company()}&year=${state.year}&account_id=${r.account_id}&project_id=${r.project_id || ""}`,
        { method: "DELETE" });
      toast(`${r.code} ${t("removed from budget")}`);
      load();
    } catch (e) { toast(e.message, true); }
  }

  const fmtIn = n => n ? Math.round(n).toLocaleString("id-ID") : "";

  function certSelect(r, ri) {
    const opts = certainties.map(c =>
      `<option value="${c}" ${r.certainty === c ? "selected" : ""}>${esc(t(c))}</option>`).join("");
    const mixed = r.certainty === "mixed"
      ? `<option value="mixed" selected>${t("mixed")}</option>` : "";
    return canWrite()
      ? `<select class="bc-cert-in" data-ri="${ri}" title="${esc(t(CERTAINTY_HINT[r.certainty] || ""))}">${mixed}${opts}</select>`
      : `<span class="pill ${CERTAINTY_PILL[r.certainty] || "inactive"}">${esc(r.certainty)}</span>`;
  }

  function renderGrid() {
    const weekly = state.bcView === "weeks";
    const ro = canWrite() ? "" : "readonly";
    const ranges = MONTH_NAMES.map((_, mi) => weekRanges(state.year, mi + 1));

    const head = weekly
      ? `<tr><th class="bc-acc" rowspan="2">${t("Account")}</th><th rowspan="2">${t("Certainty")}</th>
           ${MONTH_NAMES.map(m => `<th class="num bc-mh" colspan="4">${m}</th>`).join("")}
           <th class="num" rowspan="2">${t("Year")}</th>${canWrite() ? `<th rowspan="2"></th>` : ""}</tr>
         <tr>${ranges.map(rg => rg.map(w =>
             `<th class="num bc-wh ${w.week === 1 ? "bc-msep" : ""}" title="${w.start}–${w.end}">W${w.week}</th>`).join("")).join("")}</tr>`
      : `<tr><th class="bc-acc">${t("Account")}</th><th>${t("Certainty")}</th>
           ${MONTH_NAMES.map(m => `<th class="num">${m}</th>`).join("")}
           <th class="num">${t("Year")}</th>${canWrite() ? "<th></th>" : ""}</tr>`;

    const section = (label, kind) => {
      const rs = rows.map((r, ri) => [r, ri]).filter(([r]) => r.type === kind);
      if (!rs.length) return "";
      const span = weekly ? 51 : 15;
      const tot = rs.reduce((a, [r]) => a + rowTotal(r), 0);
      return `<tr class="section"><td colspan="${span}"><b>${label}</b>
          <span class="muted"> · ${fmtShort(tot)}</span></td></tr>` +
        rs.map(([r, ri]) => `<tr data-ri="${ri}">
          <td class="bc-acc"><b>${esc(r.code)}</b> ${esc(r.name)}</td>
          <td>${certSelect(r, ri)}</td>
          ${weekly
            ? r.weeks.map((m, mi) => m.map((a, wi) =>
                `<td class="${wi === 0 ? "bc-msep" : ""}"><input ${ro} class="bc-in" data-mi="${mi}" data-wi="${wi}" type="text" inputmode="numeric" value="${fmtIn(a)}"></td>`).join("")).join("")
            : r.weeks.map((m, mi) => `<td class="num muted">${fmtShort(monthTotal(r, mi))}</td>`).join("")}
          <td class="num row-total">${fmtShort(rowTotal(r))}</td>
          ${canWrite() ? `<td><button class="btn btn-sm btn-ghost b-del" title="${t("Remove account from budget")}">&times;</button></td>` : ""}
        </tr>`).join("");
    };

    const body = section(t("PENDAPATAN · Revenue"), "revenue") + section(t("BEBAN · Expense"), "expense");
    $("#bGrid").innerHTML = `<div class="bc-scroll"><table class="tbl budget-grid bc-grid">
      <thead>${head}</thead>
      <tbody>${body || `<tr><td colspan="${weekly ? 51 : 15}" class="empty">${t("No budget lines yet — add accounts below or import from Excel")}</td></tr>`}</tbody>
    </table></div>`;

    const rin = rows.filter(r => r.type === "revenue").reduce((a, r) => a + rowTotal(r), 0);
    const rout = rows.filter(r => r.type === "expense").reduce((a, r) => a + rowTotal(r), 0);
    $("#bcTotals").innerHTML = `${t("Revenue")} <b class="pos">${fmtShortRp(rin)}</b> ·
      ${t("Expense")} <b class="neg">${fmtShortRp(rout)}</b> ·
      ${t("Net")} <b class="${rin - rout >= 0 ? "pos" : "neg"}">${fmtShortRp(rin - rout)}</b>`;

    $$("#bGrid .bc-in").forEach(inp => {
      const tr = () => inp.closest("tr");
      const row = () => rows[tr().dataset.ri];
      const cell = () => row().weeks[inp.dataset.mi][inp.dataset.wi];
      inp.addEventListener("focus", () => {
        const v = cell();
        inp.value = v ? String(Math.round(v)) : "";
        inp.select();
      });
      inp.addEventListener("input", () => {
        row().weeks[inp.dataset.mi][inp.dataset.wi] = Number(inp.value.replace(/[^\d]/g, "")) || 0;
        $(".row-total", tr()).textContent = fmtShort(rowTotal(row()));
      });
      inp.addEventListener("blur", () => { inp.value = fmtIn(cell()); });
    });
    $$("#bGrid .bc-cert-in").forEach(sel => sel.onchange = () => {
      rows[sel.dataset.ri].certainty = sel.value;
    });
    $$("#bGrid .b-del").forEach(btn => btn.onclick = () => removeRow(rows[btn.closest("tr").dataset.ri]));
  }

  function renderBva(bva) {
    $("#bvaBox").innerHTML = `<table class="tbl"><thead><tr><th>${t("Account")}</th><th>${t("Type")}</th>
      <th class="num">${t("Budget")}</th><th class="num">${t("Realization")}</th>
      <th class="num">${t("Variance")}</th><th class="num">${t("Used")}</th></tr></thead>
      <tbody>${bva.rows.map(r => {
        const bad = r.type === "expense" ? r.variance > 0 : r.variance < 0;
        return `<tr><td>${esc(r.code)} ${esc(r.name)}</td><td>${r.type}</td>
          <td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.actual)}</td>
          <td class="num ${bad ? "neg" : "pos"}">${fmt(r.variance)}</td>
          <td class="num">${r.used_pct == null ? "-" : r.used_pct + "%"}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="empty">${t("No budget defined for")} ${state.year}</td></tr>`}</tbody></table>`;
  }

  async function save() {
    if (mode() === "project" && !projectId) { toast(t("Pick or create a project first"), true); return; }
    try {
      const res = await api("/api/budgets", { method: "PUT", json: {
        company_id: parseInt(company(), 10), year: state.year,
        rows: rows.map(r => ({
          account_id: r.account_id, project_id: r.project_id,
          certainty: r.certainty, weeks: r.weeks,
        })),
      }});
      toast(`${t("Budget saved")} (${res.cells} ${t("weekly cells")})`);
      load();
    } catch (e) { toast(e.message, true); }
  }

  $("#bCompany").onchange = () => { projectId = null; load(); };
  $$("#bModes button").forEach(b => b.onclick = () => {
    state.bcScope = b.dataset.m;
    $$("#bModes button").forEach(x => x.classList.toggle("active", x === b));
    load();
  });
  $$("#bView .seg").forEach(b => b.onclick = () => {
    state.bcView = b.dataset.v;
    $$("#bView .seg").forEach(x => x.classList.toggle("active", x === b));
    renderGrid();
  });
  $("#bProject").onchange = () => { projectId = parseInt($("#bProject").value, 10) || null; load(); };
  if ($("#bNewProject")) $("#bNewProject").onclick = () =>
    projectEditor(null, async () => { await refreshProjects(); await load(); }, parseInt(company(), 10));
  $("#bOracle").onclick = () => { location.hash = "#/oracle"; };
  if ($("#bToW1")) $("#bToW1").onclick = async () => {
    if (!confirm(t("Move every month's whole budget into its first week? Existing week 2-4 amounts are folded into week 1, not lost."))) return;
    rows.forEach(r => r.weeks.forEach((m, mi) => {
      const total = m.reduce((x, y) => x + y, 0);
      r.weeks[mi] = [total, 0, 0, 0];
    }));
    renderGrid();
    await save();
  };
  // the template knows the company (and the open project), so column B can be
  // copied from a real list instead of guessed at
  const templateUrl = () => `/api/templates/budget?year=${state.year}&company_id=${company()}`
    + (mode() === "project" && projectId ? `&project_id=${projectId}` : "");
  $("#bExport").onclick = () => {
    if (mode() === "project" && !projectId) { toast(t("Pick a project first"), true); return; }
    const pq = mode() === "project" ? `&project_id=${projectId}` : "";
    window.location = `/api/export/budget?company_id=${company()}&year=${state.year}${pq}`;
  };
  if ($("#bExportAllPrj")) $("#bExportAllPrj").onclick = () => {
    window.location = `/api/export/budget?company_id=${company()}&year=${state.year}&project_id=all`;
  };
  if ($("#bTemplate")) $("#bTemplate").onclick = () => { window.location = templateUrl(); };
  if ($("#bSave")) $("#bSave").onclick = save;
  if ($("#bImport")) $("#bImport").onclick = () => {
    const prj = mode() === "project" && projectId ? projectList.find(p => p.id === projectId) : null;
    importModal({
      title: prj ? `${t("Import Budget")} — ${prj.code}` : t("Import Budget"),
      url: "/api/import/budget", templateUrl: templateUrl(),
      extraFields: `<label>${t("Year")} <input name="year" type="number" value="${state.year}"></label>`
        + (prj ? `<label>${t("Put the rows on")} <select name="project_id">
            <option value="${prj.id}">${esc(prj.code)} — ${esc(prj.name)}</option>
            <option value="">${t("whatever each row's Project Code says")}</option>
          </select></label>` : ""),
      company: company(), onDone: load,
    });
  };
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
        return `<tr><td class="clickable" data-id="${p.id}" data-name="${esc(p.name)}"><b>${esc(p.code)}</b> ${esc(p.name)}
          ${p.investment_id ? `<span class="pill posted" data-inv="${p.investment_id}" style="cursor:pointer"
            title="${t("Funded as an investment — click to open it")}">${t("INVESTMENT")}</span>` : ""}</td>
          <td>${esc(p.company_code)}</td><td><span class="pill ${p.status}">${p.status.replace("_", " ")}</span></td>
          <td class="num">${fmt(f.revenue)}</td><td class="num">${fmt(f.expense)}</td>
          <td class="num ${f.profit >= 0 ? "pos" : "neg"}">${fmt(f.profit)}</td>
          <td class="num">${f.margin_pct}%</td>
          <td class="num muted">${fmt(f.budget_revenue)}</td><td class="num muted">${fmt(f.budget_expense)}</td>
          <td>${canWrite() ? `<button class="btn btn-sm" data-edit="${p.id}">Edit</button>` : ""}</td></tr>`;
      }).join("") || `<tr><td colspan="10" class="empty">No projects</td></tr>`}</tbody></table>`;
    $$("#pList td.clickable").forEach(td => td.onclick = () => projectDetail(td.dataset.id, td.dataset.name));
    $$("#pList [data-inv]").forEach(b => b.onclick = e => {
      e.stopPropagation();                       // the row opens the project, the pill the investment
      investmentDetail(b.dataset.inv, load);
    });
    $$("#pList [data-edit]").forEach(b => b.onclick = () => projectEditor(all.find(p => p.id == b.dataset.edit), load));
  };
  if ($("#pNew")) $("#pNew").onclick = () => projectEditor(null, load);
  await load();
}

async function projectDetail(pid, name) {
  if (!state.prjScheme) state.prjScheme = "monthly";
  const render = async () => {
    const monthly = state.prjScheme === "monthly"
      ? await api(`/api/projects/${pid}/monthly?year=${state.year}`) : null;
    const perf = state.prjScheme === "performance"
      ? await api(`/api/projects/${pid}/performance?year=${state.year}`) : null;
    const linked = await api(`/api/projects/${pid}/investment`).catch(() => ({ investment: null }));
    const seg = `<div class="seg-group" id="prjScheme" style="margin-bottom:12px">
      <button class="seg ${state.prjScheme === "monthly" ? "active" : ""}" data-s="monthly">${t("Monthly basis")}</button>
      <button class="seg ${state.prjScheme === "performance" ? "active" : ""}" data-s="performance">${t("Performance")}</button>
    </div>`;
    let body;
    if (state.prjScheme === "monthly") {
      const tR = monthly.reduce((a, m) => a + m.revenue, 0);
      const tE = monthly.reduce((a, m) => a + m.expense, 0);
      body = `${seg}
        <h3 class="muted" style="margin-top:0">${t("Monthly performance")} — ${state.year}</h3>
        ${chartBars(MONTH_NAMES, [
          { name: "Revenue", color: C_REV, values: monthly.map(m => m.revenue) },
          { name: "Expense", color: C_EXP, values: monthly.map(m => m.expense) },
          { name: "Profit", color: C_PROFIT, values: monthly.map(m => m.profit), type: "line" },
        ])}
        <table class="tbl mt"><thead><tr><th>${t("Month")}</th><th class="num">${t("Revenue")}</th>
          <th class="num">${t("Expense")}</th><th class="num">${t("Profit")}</th></tr></thead>
        <tbody>${monthly.map((m, i) => `<tr><td>${MONTH_NAMES[i]}</td><td class="num">${fmt(m.revenue)}</td>
          <td class="num">${fmt(m.expense)}</td><td class="num ${m.profit >= 0 ? "pos" : "neg"}">${fmt(m.profit)}</td></tr>`).join("")}
        <tr class="total"><td>${t("Total")}</td><td class="num">${fmt(tR)}</td>
          <td class="num">${fmt(tE)}</td><td class="num ${tR - tE >= 0 ? "pos" : "neg"}">${fmt(tR - tE)}</td></tr></tbody></table>`;
    } else {
      const rev = perf.rows.filter(r => r.type === "revenue");
      const cost = perf.rows.filter(r => r.type === "expense");
      const tR = perf.total_actual_revenue, tC = perf.total_actual_expense;
      const bR = perf.total_budget_revenue, bC = perf.total_budget_expense;
      const profit = round2(tR - tC);
      const margin = tR ? Math.round(1000 * profit / tR) / 10 : 0;
      const accRows = (list, kind) => list.map(r => {
        const used = r.budget ? Math.round(100 * r.actual / r.budget) : null;
        return `<tr><td><a href="#" class="prj-acc" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${esc(r.code)} ${esc(r.name)}</a></td>
          <td class="num">${fmt(r.actual)}</td><td class="num muted">${fmt(r.budget)}</td>
          <td class="num ${r.variance >= 0 ? (kind === "rev" ? "pos" : "neg") : (kind === "rev" ? "neg" : "pos")}">${fmt(r.variance)}</td>
          <td class="num ${used != null && used > 100 && kind === "cost" ? "neg" : ""}">${used == null ? "—" : used + "%"}</td></tr>`;
      }).join("");
      body = `${seg}
        <div class="grid kpis">
          <div class="kpi hl"><div class="kpi-label">${t("Total Revenue")}</div><div class="kpi-value">${fmtShortRp(tR)}</div>
            <div class="kpi-sub">${t("budget")} ${fmtShortRp(bR)}</div></div>
          <div class="kpi"><div class="kpi-label">${t("Total Cost")}</div><div class="kpi-value">${fmtShortRp(tC)}</div>
            <div class="kpi-sub">${t("cost budget")} ${fmtShortRp(bC)}</div></div>
          <div class="kpi ${profit >= 0 ? "green" : "red"}"><div class="kpi-label">${t("Profit")}</div>
            <div class="kpi-value">${fmtShortRp(profit)}</div><div class="kpi-sub">${t("margin")} ${margin}%</div></div>
        </div>
        ${chartBars([t("Revenue"), t("Cost")], [
          { name: t("Budget"), color: "#c87a08", values: [bR, bC] },
          { name: t("Realization"), color: C_REV, values: [tR, tC] },
        ], { height: 240, valueLabels: true, valueFmt: fmtShort })}
        ${pfWaterfallCard(perf)}
        <h3 style="margin-top:14px">${t("Revenue by account")}</h3>
        <table class="tbl"><thead><tr><th>${t("Account")}</th><th class="num">${t("Realization")}</th>
          <th class="num">${t("Budget")}</th><th class="num">${t("Variance")}</th><th class="num">${t("Used")}</th></tr></thead>
          <tbody>${accRows(rev, "rev") || `<tr><td colspan="5" class="empty">${t("No revenue posted to this project")}</td></tr>`}
          ${rev.length ? `<tr class="total"><td>${t("Total Revenue")}</td><td class="num">${fmt(tR)}</td>
            <td class="num">${fmt(bR)}</td><td class="num">${fmt(round2(tR - bR))}</td><td></td></tr>` : ""}</tbody></table>
        <h3 style="margin-top:14px">${t("Cost by account")}</h3>
        <table class="tbl"><thead><tr><th>${t("Account")}</th><th class="num">${t("Realization")}</th>
          <th class="num">${t("Cost budget")}</th><th class="num">${t("Variance")}</th><th class="num">${t("Used")}</th></tr></thead>
          <tbody>${accRows(cost, "cost") || `<tr><td colspan="5" class="empty">${t("No cost posted to this project")}</td></tr>`}
          ${cost.length ? `<tr class="total"><td>${t("Total Cost")}</td><td class="num">${fmt(tC)}</td>
            <td class="num">${fmt(bC)}</td><td class="num">${fmt(round2(bC - tC))}</td><td></td></tr>` : ""}</tbody></table>
        <p class="muted mt" style="font-size:12px">Cost accounts (5100-01 Direct Labor, 5100-04 Fixed / Misc …) come from journal lines tagged to
          this project. <b>Click an account</b> to see the transactions behind it. Set this project&rsquo;s revenue &amp; cost budget in
          <b>Budgets &rarr; Per-project budget</b>.</p>`;
    }
    openModal(invOnProjectCard(linked.investment) + body, { title: name });
    $$("#prjScheme .seg").forEach(b => b.onclick = () => { state.prjScheme = b.dataset.s; render(); });
    $$("#modalRoot #prjWf .seg").forEach(b => b.onclick = () => { state.prjWfView = b.dataset.w; render(); });
    if ($("#prjInvOpen")) $("#prjInvOpen").onclick = () =>
      investmentDetail($("#prjInvOpen").dataset.inv, () => projectDetail(pid, name));
    $$("#modalRoot .prj-acc").forEach(a => a.onclick = e => {
      e.preventDefault(); projectAccountLedger(pid, a.dataset.code, a.dataset.name, name, render);
    });
  };
  await render();
}

async function projectAccountLedger(pid, code, accName, projName, back) {
  try {
    const d = await api(`/api/projects/${pid}/account-ledger?code=${encodeURIComponent(code)}&year=${state.year}`);
    openModal(`
      <div class="muted" style="margin-top:-4px">${esc(projName)} · ${state.year} · ${d.entries.length} transaction(s)</div>
      <div style="max-height:52vh;overflow:auto" class="mt"><table class="tbl">
        <thead><tr><th>${t("Date")}</th><th>${t("Entry")}</th><th>Co.</th><th>${t("Description")}</th>
          <th>${t("Source")}</th><th>${t("Inputter")}</th><th class="num">${t("Debit")}</th><th class="num">${t("Credit")}</th></tr></thead>
        <tbody>${d.entries.map(e => `<tr>
          <td>${esc(fmtDate(e.date))}</td><td><b>${esc(e.entry_no)}</b></td><td>${esc(e.company_code)}</td>
          <td>${esc(e.line_desc || e.description || "")}</td>
          <td><span class="pill ${SOURCE_CLASS[e.source] || "inactive"}">${esc(e.source_label)}</span></td>
          <td>${esc(e.inputter)}</td>
          <td class="num">${e.debit ? fmt(e.debit) : ""}</td>
          <td class="num">${e.credit ? fmt(e.credit) : ""}</td></tr>`).join("")
          || `<tr><td colspan="8" class="empty">No transactions for this account on this project.</td></tr>`}
        <tr class="total"><td colspan="6">${t("TOTAL")}</td><td class="num">${fmt(d.total_debit)}</td>
          <td class="num">${fmt(d.total_credit)}</td></tr></tbody></table></div>
      <div class="form-actions"><button class="btn" id="prjBack">&#8592; ${t("Back to project")}</button></div>`,
      { title: `${code} — ${accName}` });
    $("#prjBack").onclick = () => back();
  } catch (e) { toast(e.message, true); }
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
      <label class="full">${t("Contract value (Rp)")} <input id="pContract" inputmode="numeric" value="${p && p.contract_value ? fmt(p.contract_value) : ""}"
        placeholder="${t("what the project was sold for — leave blank to use its revenue budget")}"></label>
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
      contract_value: parseInt(($("#pContract").value || "0").replace(/[^\d]/g, ""), 10) || 0,
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

// weekly cash flow view: actual vs budget trajectory + inline weekly cash budget
async function renderCfWeekly(host, cid, year) {
  const d = await api(`/api/reports/cash-flow-weekly?company_id=${cid}&year=${year}`);
  $("#rScope").textContent = d.scope;
  const editable = String(cid) !== "all" && canWrite();
  const wk = d.weeks;
  const labels = wk.map(w => (w.week % 4 === 1 || w.week === wk.length) ? "W" + w.week : "");
  const chart = chartBars(labels, [
    { name: "Actual Ending", color: C_REV, values: wk.map(w => w.ending), type: "line" },
    { name: "Budget Ending", color: "#c87a08", values: wk.map(w => w.budget_ending), type: "line" },
  ], { width: 860, height: 300 });
  const rows = wk.map(w => `<tr>
    <td>W${w.week}</td><td class="muted" style="white-space:nowrap">${esc(fmtDate(w.start).slice(0, 5))}–${esc(fmtDate(w.end).slice(0, 5))}</td>
    <td class="num">${fmt(w.cash_in)}</td><td class="num">${fmt(w.cash_out)}</td>
    <td class="num ${w.net >= 0 ? "pos" : "neg"}">${fmt(w.net)}</td><td class="num"><b>${fmt(w.ending)}</b></td>
    ${editable
      ? `<td class="num"><input class="cb-in" data-week="${w.week}" data-f="in" value="${w.budget_in ? fmt(w.budget_in) : ""}" style="width:104px;text-align:right" inputmode="numeric"></td>
         <td class="num"><input class="cb-in" data-week="${w.week}" data-f="out" value="${w.budget_out ? fmt(w.budget_out) : ""}" style="width:104px;text-align:right" inputmode="numeric"></td>`
      : `<td class="num muted">${fmt(w.budget_in)}</td><td class="num muted">${fmt(w.budget_out)}</td>`}
    <td class="num muted">${fmt(w.budget_ending)}</td>
    <td class="num ${w.variance >= 0 ? "pos" : "neg"}">${fmt(w.variance)}</td></tr>`).join("");
  host.innerHTML = `
    <div class="card"><h3>${t("Weekly Cash — Actual vs Budget")} (${year})</h3>${chart}
      <div class="muted mt">Opening <b>${fmtRp(d.opening_balance)}</b> · ${t("Actual closing")} <b>${fmtRp(d.closing)}</b> · ${t("Budget closing")} <b>${fmtRp(d.budget_closing)}</b></div>
    </div>
    <div class="card mt">
      <div class="page-head"><h3 style="margin:0">${t("Weekly Cash Flow")} — ${t("set the cash budget by week")}</h3>
        ${editable ? `<button class="btn btn-sm btn-primary" id="cbSave">${t("Save Cash Budget")}</button>`
                   : `<span class="muted">${t("Pick a single company to set the weekly cash budget")}</span>`}</div>
      <div style="max-height:460px;overflow:auto"><table class="tbl ar-tbl">
        <thead><tr><th>${t("Week")}</th><th>${t("Period")}</th>
          <th class="num">${t("Actual In")}</th><th class="num">${t("Actual Out")}</th><th class="num">${t("Net")}</th><th class="num">${t("Ending")}</th>
          <th class="num">${t("Budget In")}</th><th class="num">${t("Budget Out")}</th><th class="num">${t("Budget Ending")}</th><th class="num">${t("Variance")}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>`;
  if (editable) {
    const sv = $("#cbSave");
    if (sv) sv.onclick = async () => {
      const numv = elx => parseInt((elx.value || "0").replace(/[^\d-]/g, ""), 10) || 0;
      const byWeek = {};
      $$(".cb-in").forEach(inp => {
        const k = inp.dataset.week;
        byWeek[k] = byWeek[k] || { week: parseInt(k, 10), cash_in: 0, cash_out: 0 };
        byWeek[k][inp.dataset.f === "in" ? "cash_in" : "cash_out"] = numv(inp);
      });
      try {
        await api("/api/cash-budget", { json: { company_id: parseInt(cid, 10), year, weeks: Object.values(byWeek) } });
        toast("Cash budget saved — chart updated");
        renderCfWeekly(host, cid, year);
      } catch (e) { toast(e.message, true); }
    };
  }
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
  const periodLabel = d => `Period ${fmtDate(d.date_from)} → ${fmtDate(d.date_to)}`;

  async function show() {
    const body = $("#rBody");
    body.innerHTML = `<div class="empty">Loading…</div>`;
    if (tab === "pnl") {
      if (!state.pnlAttr) state.pnlAttr = "project";
      body.innerHTML = `<div class="filters">${dateRangeFilters()}
        <div class="seg-group" id="pnlAttr" title="${t("Revenue & COGS follow the project's company (management view) or stay with the booking entity (legal view).")}">
          <button class="seg ${state.pnlAttr === "project" ? "active" : ""}" data-attr="project">${t("By project company")}</button>
          <button class="seg ${state.pnlAttr === "entity" ? "active" : ""}" data-attr="entity">${t("By booking entity")}</button>
        </div>
        <span class="muted" id="rPeriod"></span></div><div id="rTable"></div>`;
      const run = async () => {
        const d = await api(`/api/reports/pnl?${scopeQS()}&${rangeQS()}&attribution=${state.pnlAttr}`);
        $("#rScope").textContent = d.scope;
        $("#rPeriod").textContent = periodLabel(d);
        $("#rExp").href = `/api/export/pnl?${scopeQS()}&${rangeQS()}&attribution=${state.pnlAttr}`;
        $("#rExpPdf").href = `/api/export/pdf/pnl?${scopeQS()}&${rangeQS()}&attribution=${state.pnlAttr}`;
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
      $$("#pnlAttr .seg").forEach(b => b.onclick = () => { state.pnlAttr = b.dataset.attr; show(); });
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
        $("#rPeriod").textContent = `As of ${fmtDate(d.as_of)}`;
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
          // grouped by parent account: parent rows are bold subtotals, leaf
          // rows are indented and clickable through to their ledger
          const disp = (d.grouped && d.grouped.length)
            ? d.grouped : d.rows.map(r => Object.assign({ level: 0, is_group: false }, r));
          const body = disp.map(r => {
            const pad = 8 + r.level * 18;
            const nameCell = r.is_group
              ? `<b>${esc(r.name)}</b>`
              : `<a href="#" class="tb-name" data-code="${esc(r.code)}" data-name="${esc(r.name)}">${esc(r.name)}</a>`;
            return `<tr class="${r.is_group ? "tb-group" : ""}">
              <td style="padding-left:${pad}px">${esc(r.code)}</td>
              <td>${nameCell}</td><td class="muted">${r.type}</td>
              <td class="num">${r.debit ? fmt(r.debit) : ""}</td>
              <td class="num">${r.credit ? fmt(r.credit) : ""}</td>
              <td class="num">${fmt(r.balance)}</td></tr>`;
          }).join("");
          $("#rTable").innerHTML = `<table class="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th>
            <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
            <tbody>${body}
            <tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(d.total_debit)}</td>
              <td class="num">${fmt(d.total_credit)}</td><td></td></tr></tbody></table>
            <p class="muted mt">Grouped by parent account — <b>bold</b> rows are roll-up subtotals. Click a child account to see its journal entries and each entry&rsquo;s source.</p>`;
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
      const cfDefault = state.cfCompany || (state.companyId !== "all" ? state.companyId : firstCompanyId());
      if (!state.cfView) state.cfView = "monthly";
      const weekly = state.cfView === "weekly";
      body.innerHTML = `<div class="filters">
          <label>Company <select id="cfCompany">${companyOptions(cfDefault, { includeAll: true })}</select></label>
          <div class="seg-group" id="cfViewSeg">
            <button class="seg ${!weekly ? "active" : ""}" data-v="monthly">${t("Monthly")}</button>
            <button class="seg ${weekly ? "active" : ""}" data-v="weekly">${t("Weekly")}</button>
          </div>
          <a class="btn" id="cfExp" ${weekly ? 'style="display:none"' : ""}>&#x2913; Export Excel</a>
          <a class="btn" id="cfExpPdf" ${weekly ? 'style="display:none"' : ""}>&#x1F4C4; Export PDF</a>
          <span class="muted">Cash &amp; bank accounts (11xx) — year ${state.year}</span></div>
        <div id="cfDetail"></div><div id="cfCompare"></div>`;
      const runCf = async () => {
        const cid = $("#cfCompany").value;
        if (state.cfView === "weekly") { $("#cfCompare").innerHTML = ""; await renderCfWeekly($("#cfDetail"), cid, state.year); return; }
        const d = await api(`/api/reports/cash-flow?company_id=${cid}&year=${state.year}`);
        $("#rScope").textContent = d.scope;
        $("#cfExp").href = `/api/export/cash-flow?company_id=${cid}&year=${state.year}`;
        $("#cfExpPdf").href = `/api/export/pdf/cash-flow?company_id=${cid}&year=${state.year}`;
        renderCfDetail(d);
      };
      $("#cfCompany").onchange = () => { state.cfCompany = $("#cfCompany").value; runCf(); };
      $$("#cfViewSeg .seg").forEach(b => b.onclick = () => { state.cfView = b.dataset.v; show(); });
      await runCf();
      if (!weekly && state.me.companies.length > 1) {
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
      if (!state.bvaKind) state.bvaKind = "revenue";
      body.innerHTML = `<div class="filters">
        <div class="seg-group" id="bvaSeg">
          <button class="seg ${state.bvaKind === "revenue" ? "active" : ""}" data-k="revenue">${t("Revenue")}</button>
          <button class="seg ${state.bvaKind === "expense" ? "active" : ""}" data-k="expense">${t("Expenses")}</button>
        </div>
        <a class="btn" href="/api/export/budget-vs-actual?${scopeQS()}">&#x2913; ${t("Export Excel")}</a>
        <a class="btn" href="/api/export/pdf/budget-vs-actual?${scopeQS()}">&#x1F4C4; ${t("Export PDF")}</a>
        <span class="muted">${t("Realization = posted actuals (Realisasi)")}</span></div>
        <div id="bvaBody"></div>`;
      const renderBva = () => {
        const isRev = state.bvaKind === "revenue";
        const rows = d.rows.filter(r => r.type === state.bvaKind);
        const tBudget = isRev ? d.total_budget_revenue : d.total_budget_expense;
        const tActual = isRev ? d.total_actual_revenue : d.total_actual_expense;
        const tVar = round2(tActual - tBudget);
        const tUsed = tBudget ? Math.round(100 * tActual / tBudget) : null;
        const goodVar = v => isRev ? v >= 0 : v <= 0;        // rev: ≥target good · exp: ≤budget good
        const badUsed = p => p != null && (isRev ? p < 100 : p > 100);
        $("#bvaBody").innerHTML = `
          <p class="muted" style="margin-top:-4px">${isRev
            ? t("Revenue target (budget) vs realization. Green = at or above target.")
            : t("Expense budget vs realization. Green = at or under budget; red = overspent.")}</p>
          <table class="tbl"><thead><tr><th>Code</th><th>Account</th>
            <th class="num">${t("Budget")}</th><th class="num">${t("Realization")}</th>
            <th class="num">${isRev ? t("Variance vs Target") : t("Over / (Under)")}</th>
            <th class="num">${isRev ? t("Achieved") : t("Used")}</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td>
            <td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.actual)}</td>
            <td class="num ${goodVar(r.variance) ? "pos" : "neg"}">${fmt(r.variance)}</td>
            <td class="num ${badUsed(r.used_pct) ? "neg" : ""}">${r.used_pct == null ? "-" : r.used_pct + "%"}</td></tr>`).join("")
            || `<tr><td colspan="6" class="empty">${isRev ? t("No revenue budget") : t("No expense budget")} — ${state.year}</td></tr>`}
            <tr class="total"><td colspan="2">${t("TOTAL")} ${isRev ? t("Revenue") : t("Expenses")}</td>
              <td class="num">${fmt(tBudget)}</td><td class="num">${fmt(tActual)}</td>
              <td class="num ${goodVar(tVar) ? "pos" : "neg"}">${fmt(tVar)}</td>
              <td class="num ${badUsed(tUsed) ? "neg" : ""}">${tUsed == null ? "-" : tUsed + "%"}</td></tr>
          </tbody></table>`;
      };
      $$("#bvaSeg .seg").forEach(b => b.onclick = () => {
        state.bvaKind = b.dataset.k;
        $$("#bvaSeg .seg").forEach(x => x.classList.toggle("active", x === b));
        renderBva();
      });
      renderBva();
    }
  }
  await show();
}

/* ------------------------------------------------------------------ settings */

/* --------------------------------------------------------- shared: plan vocabulary */
// Certainty is the one field that decides whether money is allowed to count. It
// lives on every budget line and every saved-scenario line, and the Oracle's
// three runs are built entirely out of it.
const CERTAINTY_PILL = { committed: "posted", planned: "active", expected: "draft", speculative: "inactive" };
const CERTAINTY_HINT = {
  committed: "signed / contractual — counted in every run",
  planned: "budgeted, not yet signed — counted as an outflow, not as an inflow",
  expected: "likely but unsigned — Base run only",
  speculative: "pipeline — Optimistic run only",
};

// ---- Oracle Step 4: when committed investment money actually leaves --------
async function renderInvestmentCommitments(iid, reload) {
  const box = $("#ivCommit");
  if (!box) return;
  let d;
  try { d = await api(`/api/investments/${iid}/commitments`); }
  catch (e) { box.innerHTML = ""; return; }
  const rows = d.commitments.map(cm => `<tr>
      <td>${cm.year} · ${MONTH_NAMES[cm.month - 1]} <b>W${cm.week}</b>
        <br><span class="muted">${esc(fmtDate(cm.start))} → ${esc(fmtDate(cm.end))}</span></td>
      <td><span class="pill ${CERTAINTY_PILL[cm.certainty] || "inactive"}">${esc(cm.certainty)}</span></td>
      <td class="muted">${esc(fmtDate(cm.settles))}</td>
      <td class="num"><b>${fmt(cm.amount)}</b></td>
      <td>${esc(cm.note || "")}</td>
      ${canWrite() ? `<td><button class="btn btn-sm btn-ghost" data-delcm="${cm.id}">&times;</button></td>` : ""}
    </tr>`).join("") || `<tr><td colspan="${canWrite() ? 6 : 5}" class="empty">${t("Nothing scheduled yet.")}</td></tr>`;
  box.innerHTML = `
    <h3 style="margin-top:16px">${t("Commitment schedule")}
      <span class="muted" style="font-weight:500;font-size:12.5px">· ${t("when the committed money actually leaves")}</span></h3>
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">${t("Committed")}</div><div class="kpi-value" style="font-size:16px">${fmtRp(d.committed_amount)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Scheduled")}</div><div class="kpi-value" style="font-size:16px">${fmtRp(d.scheduled)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Already paid out")}</div><div class="kpi-value" style="font-size:16px">${fmtRp(d.already_out)}</div></div>
      <div class="kpi ${d.unscheduled ? "amber" : "green"}"><div class="kpi-label">${t("Unscheduled")}</div>
        <div class="kpi-value" style="font-size:16px">${fmtRp(d.unscheduled)}</div></div>
    </div>
    ${d.unscheduled ? `<div class="warn watch mt"><span class="warn-ic">›</span>
      <span><b>${fmtRp(d.unscheduled)} ${t("has no date.")}</b> ${esc(d.note)}</span></div>` : ""}
    <table class="tbl mt"><thead><tr><th>${t("Week")}</th><th>${t("Certainty")}</th>
      <th>${t("Settles")}</th><th class="num">${t("Amount")}</th><th>${t("Note")}</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table>
    ${canWrite() ? `<div class="filters mt">
      <label>${t("Year")} <input id="icY" type="number" value="${state.year}" style="width:90px"></label>
      <label>${t("Month")} <select id="icM">${MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></label>
      <label>${t("Week")} <select id="icW">${[1,2,3,4].map(w => `<option value="${w}">W${w}</option>`).join("")}</select></label>
      <label>${t("Amount")} <input id="icA" inputmode="numeric" style="width:150px"></label>
      <label>${t("Certainty")} <select id="icC">${(d.certainties || []).map(x => `<option value="${x}">${x}</option>`).join("")}</select></label>
      <button class="btn btn-sm btn-primary" id="icAdd">+ ${t("Schedule")}</button>
    </div>` : ""}`;
  $$("#ivCommit [data-delcm]").forEach(b => b.onclick = async () => {
    try { await api("/api/investments/commitments/" + b.dataset.delcm, { method: "DELETE" });
      toast("Removed"); reload();
    } catch (e) { toast(e.message, true); }
  });
  if ($("#icAdd")) $("#icAdd").onclick = async () => {
    const amt = parseInt(($("#icA").value || "0").replace(/[^\d-]/g, ""), 10) || 0;
    if (!amt) { toast("Enter an amount", true); return; }
    try {
      await api(`/api/investments/${iid}/commitments`, { json: {
        year: parseInt($("#icY").value, 10), month: parseInt($("#icM").value, 10),
        week: parseInt($("#icW").value, 10), amount: amt, certainty: $("#icC").value } });
      toast("Scheduled"); reload();
    } catch (e) { toast(e.message, true); }
  };
}

// ---- Oracle Step 5: the consult, surfaced on the Cash Plan screen ---------
const VERDICT_CLS = { KRITIS: "bad", TOLAK: "bad", WASPADA: "draft", LULUS: "posted" };

async function oracleConsult(versionId, box) {
  box.innerHTML = `<div class="card mt"><div class="empty">${t("Consulting the Oracle…")}</div></div>`;
  let d;
  try { d = await api("/api/oracle/consult", { json: { version_id: versionId || null, year: state.year } }); }
  catch (e) { box.innerHTML = `<div class="card mt"><p class="neg">${esc(e.message)}</p></div>`; return; }
  const chip = e => `<span class="pill ${VERDICT_CLS[e.verdict] || "inactive"}"
      title="${t("floor")} ${fmtRp(e.floor)} · ${t("worst")} ${esc(fmtDate(e.detail.worst_date) || "-")}">${esc(e.company_code)}: ${esc(e.verdict)}</span>`;
  const worst = d.entities.find(e => e.company_code === d.driven_by) || d.entities[0] || {};
  const wk = worst.weekly || [];
  box.innerHTML = `
    <div class="card mt">
      <div class="page-head"><h3 style="margin:0">${t("The Oracle")} —
        <span class="pill ${VERDICT_CLS[d.verdict] || "inactive"}" style="font-size:13px">${esc(d.verdict)}</span></h3>
        <div class="page-actions"><span class="muted">${esc(d.version_name)} · ${d.year} · ${d.items} ${t("dated items")}</span></div></div>
      <p class="muted" style="margin-top:-4px">${esc(d.verdict_text)}</p>
      <p><b>${t("Group rule")}:</b> <span class="muted">${esc(d.rule)}</span>
        ${d.driven_by ? `<br><b>${t("Driven by")}:</b> ${esc(d.driven_by)}` : ""}
        ${worst.detail && worst.detail.first_below_floor ? `<br><b>${t("First below floor")}:</b> ${esc(fmtDate(worst.detail.first_below_floor))}` : ""}
        ${worst.detail && worst.detail.first_negative_cash ? `<br><b class="neg">${t("Cash goes negative")}:</b> ${esc(fmtDate(worst.detail.first_negative_cash))}` : ""}</p>
      <div class="mt">${d.entities.map(chip).join(" ")}</div>
      ${wk.length ? `<div class="mt">${chartBars(wk.map(w => (w.week === 1 ? w.label.slice(0, 2) : "")), [
          { name: t("Cash (Bound)"), color: C_REV, values: wk.map(w => w.ending), type: "line" },
          { name: t("Buffer floor"), color: "#c87a08", values: wk.map(() => worst.floor), type: "line" },
          { name: t("Zero"), color: "#bd362f", values: wk.map(() => 0), type: "line" },
        ], { height: 250 })}
        <div class="muted" style="font-size:12px">${t("Weekly cash for")} ${esc(worst.company_code)} —
          ${t("Bound run: only committed money in, committed + planned money out.")}</div></div>` : ""}
      <table class="tbl mt"><thead><tr><th>${t("Entity")}</th><th>${t("Verdict")}</th>
        <th class="num">${t("Opening cash")}</th><th class="num">${t("Buffer floor")}</th>
        <th class="num">${t("Worst headroom")}</th><th>${t("Worst day")}</th></tr></thead>
        <tbody>${d.entities.map(e => `<tr>
          <td><b>${esc(e.company_code)}</b></td>
          <td><span class="pill ${VERDICT_CLS[e.verdict] || "inactive"}">${esc(e.verdict)}</span></td>
          <td class="num">${fmt(e.opening_cash)}</td>
          <td class="num muted">${fmt(e.floor)}</td>
          <td class="num ${(e.detail.min_headroom || 0) < 0 ? "neg" : "pos"}">${fmt(e.detail.min_headroom || 0)}</td>
          <td>${esc(fmtDate(e.detail.worst_date) || "—")}</td></tr>`).join("")}</tbody></table>
      ${(d.warnings || []).length ? `<h3 style="margin-top:14px">${t("Assumptions & warnings")}</h3>
        <ul class="muted" style="margin:0 0 0 18px;line-height:1.7;font-size:12.5px">
          ${d.warnings.map(w => `<li>${esc(fmtDatesIn(w))}</li>`).join("")}</ul>` : ""}
      <p class="muted mt" style="font-size:12px">${t("The verdict is always taken from the Bound run. Base and Optimistic are context, never the answer.")}</p>
    </div>`;
}


/* ---- The Oracle: guided documentation ------------------------------------
   Prose alone leaves the reader to work out which step THEY are missing, so the
   guide opens with a checklist read from the live database and only then explains
   the vocabulary. The truth tables below mirror fpa_cash.RUN_FILTERS and
   VERDICT_TEXT exactly — if the engine's rules change, change them here too. */

const GUIDE_STATE_PILL = { pass: "posted", warn: "draft", fail: "bad" };
const GUIDE_STATE_MARK = { pass: "✓", warn: "!", fail: "✕" };

async function oracleGuideView(body) {
  let r = null;
  try { r = await api("/api/oracle/readiness?year=" + state.year); } catch (e) { /* guide still works */ }

  const checklist = !r ? "" : `
    <div class="card">
      <div class="page-head"><h3 style="margin:0">${t("Before the answer means anything")}</h3>
        <span class="muted">${r.ready
          ? `<b class="pos">${t("Everything the Oracle needs is set.")}</b>`
          : `${r.blocking ? `<b class="neg">${r.blocking} ${t("blocking")}</b> · ` : ""}${
              r.checks.filter(c => c.state === "warn").length} ${t("assumptions in play")}`}</span></div>
      <p class="muted" style="margin-top:-6px">${t("A forecast is only as honest as what it was given. These six things decide whether the verdict is a finding or an artefact of missing data — read from your live database, not from a manual.")}</p>
      <table class="tbl"><tbody>
        ${r.checks.map(c => `<tr>
          <td style="width:34px"><span class="pill ${GUIDE_STATE_PILL[c.state] || "inactive"}"
              title="${esc(c.state)}">${GUIDE_STATE_MARK[c.state] || "?"}</span></td>
          <td><b>${esc(t(c.title))}</b><div class="muted" style="font-size:12.5px">${esc(fmtDatesIn(c.detail))}</div></td>
          <td class="num" style="width:190px">${c.state === "pass" ? ""
            : `<button class="btn btn-sm og-go" data-route="${esc(c.route)}">${esc(t(c.cta))} &rarr;</button>`}</td>
        </tr>`).join("")}
      </tbody></table>
    </div>`;

  const steps = [
    ["1", t("Budget the year, by week"),
     t("Budget Center — company level for overheads, per project for revenue and direct cost. A month is always four weeks and W4 runs to month end. Put money in the week it actually moves: rent in W1, payroll in W4, collections mid-month."),
     "budgets", t("Open Budget Center")],
    ["2", t("Say how sure each line is"),
     t("Certainty is the single field that decides the verdict. 'Committed' means signed. Everything starts as 'planned', which is why a freshly typed budget always reads KRITIS — the Bound run counts no planned money coming in."),
     "budgets", t("Set certainty")],
    ["3", t("Say how low cash is allowed to go"),
     t("Cash policy — a minimum cash amount per company, and how many months of fixed cash operating cost to keep. The floor in force is the larger of the two. Leave it at zero and the only question the Oracle can answer is 'did a payment bounce', which is far too late."),
     null, t("Cash policy")],
    ["4", t("Date the money that is already promised"),
     t("Receivables, payables and investment commitments are pulled in automatically. Where a date is missing the Oracle assumes one and says so in its warnings — every assumption it had to make is listed under the verdict."),
     "investments", t("Open Investment Center")],
    ["5", t("Read the verdict, then act on it"),
     t("The verdict tab gives the safe period, the exact day it breaks, and a list of specific moves — which outflow to delay, which receivable to pull forward, and how much short you are. Then use Sensitivity to ask how wrong you can afford to be."),
     null, null],
  ];

  // Mirrors fpa_cash.RUN_FILTERS exactly. Bound: in=committed, out=committed+planned.
  // Base: in=committed+expected+speculative (speculative at half weight),
  // out=all four. Optimistic: in=all four, out=committed+planned.
  const runRows = [
    ["committed", t("Signed, contracted, already owed."), "in + out", "in + out", "in + out"],
    ["planned", t("Budgeted, not yet signed."), t("out only"), t("out only"), "in + out"],
    ["expected", t("Likely, unsigned."), "—", "in + out", t("in only")],
    ["speculative", t("Pipeline, a hope."), "—", t("in at half weight, + out"), t("in only")],
  ];

  const verdicts = [
    ["KRITIS", "bad", t("Cash goes below zero. A payment will not clear.")],
    ["TOLAK", "bad", t("Cash stays positive but breaks the buffer floor.")],
    ["WASPADA", "draft", t("Inside the floor but with little room, or the Base run breaches.")],
    ["LULUS", "posted", t("Headroom stays above 25% of the floor every day.")],
  ];

  const terms = [
    [t("Buffer floor"), t("The lowest cash a company is allowed to hold. The larger of the minimum you set and N months of fixed cash operating cost — depreciation excluded, because it never leaves the bank.")],
    [t("Headroom"), t("Cash minus the floor, on the worst day of the year. Negative headroom is the size of the hole.")],
    [t("Safe period"), t("How long the plan holds before it first touches the floor or zero, and the exact date it breaks.")],
    [t("Bound / Base / Optimistic"), t("Three readings of the same plan. Bound is the one that decides the verdict: it counts only committed money in, and both committed and planned money out. It is deliberately the pessimistic reading.")],
    [t("Pessimistic settlement"), t("Inside a week bucket, money OUT leaves on the first day and money IN arrives on the last. The Oracle never gives itself the benefit of the doubt about timing.")],
    [t("Cash pooling: off"), t("Your setting. The group is safe only if EVERY company is safe — cash trapped in one entity does not pay another's payroll, so the group verdict is the worst entity's verdict, never an average.")],
  ];

  const sens = [
    [t("Tornado"), t("One axis moved at a time, widest bar first. That ordering IS the recommendation of what to manage — the widest bar is where your year is most exposed.")],
    [t("Break-even"), t("The number to remember. 'Revenue can fall to 85% before the buffer breaks' is a sentence you can take into a board meeting.")],
    [t("Crisis"), t("A one-off unbudgeted expense landing at the worst possible moment, priced as a share of the year's planned cash out. This is the 'what if something happens' axis.")],
    [t("The 5 × 5 grid"), t("Revenue shortfall against expense overrun, together. Real years move on both axes at once, and only this grid shows that — a one-way bar cannot.")],
  ];

  const gotchas = [
    [t("It says KRITIS and I think we are fine."),
     t("Almost always certainty. A budget line starts life as 'planned', and the Bound run counts no planned money in — so the forecast is reading a year with income switched off. Mark contracted revenue 'committed'. The Oracle says this in its own warnings whenever it applies.")],
    [t("The verdict changed and I did not touch the budget."),
     t("The Oracle reads the LIVE budget, so it moves the moment anyone edits Budget Center. If you need a number that cannot move — to quote in minutes, or to compare against later — press 'Freeze as scenario' and read that instead.")],
    [t("A number looks doubled."),
     t("Check whether the same account is budgeted at both company level and project level. Both are counted, because a company-level line is normally spending that belongs to no project. If yours is a summary of the projects, it is being counted twice — the Oracle warns when it sees this pattern.")],
    [t("Depreciation is missing from the forecast."),
     t("On purpose. Anything classed 'noncash' never moves cash, so it is excluded here and excluded from the buffer floor. The two halves of the engine agree.")],
  ];

  body.innerHTML = `
    ${checklist}

    <div class="card mt">
      <h3>${t("What the Oracle actually does")}</h3>
      <p style="margin-top:-4px;max-width:64em;line-height:1.65">${t("It takes the budget your finance team already set, turns every line into a dated movement of cash, adds the receivables, payables and investment commitments already on the books, and then runs the year day by day to answer one question: does cash ever fall below the line you said it must never fall below?")}</p>
      <p class="muted" style="max-width:64em;line-height:1.6">${t("It is a forecast, not a record. That is why this section is a different colour from the rest of the console — the books are teal, the Oracle is not, and nothing here has been posted to anything.")}</p>
    </div>

    <div class="card mt"><h3>${t("The five steps")}</h3>
      <div class="og-steps">${steps.map(([n, title, textv, route, cta]) => `
        <div class="og-step">
          <div class="og-n">${n}</div>
          <div><b>${esc(title)}</b>
            <div class="muted" style="font-size:12.5px;line-height:1.6;margin-top:4px">${esc(textv)}</div>
            ${cta ? `<div style="margin-top:8px">${route
              ? `<button class="btn btn-sm og-go" data-route="${esc(route)}">${esc(cta)} &rarr;</button>`
              : `<button class="btn btn-sm" id="og-policy">&#9881; ${esc(cta)}</button>`}</div>` : ""}
          </div>
        </div>`).join("")}</div>
    </div>

    <div class="card mt"><h3>${t("Certainty — which money counts, and where")}</h3>
      <p class="muted" style="margin-top:-4px">${t("This table is the whole engine in six rows. A run only counts a line if its certainty appears in that run's column.")}</p>
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th>${t("Certainty")}</th><th>${t("Means")}</th>
          <th>${t("Bound")} <span class="muted">(${t("the verdict")})</span></th><th>${t("Base")}</th><th>${t("Optimistic")}</th></tr></thead>
        <tbody>${runRows.map(([k, mean, b, ba, o]) => `<tr>
          <td><span class="pill ${CERTAINTY_PILL[k] || "inactive"}">${esc(t(k))}</span></td>
          <td class="muted">${esc(mean)}</td>
          <td><b>${esc(b)}</b></td><td>${esc(ba)}</td><td>${esc(o)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted mt" style="font-size:12px">${t("Read the Bound column twice. 'Planned' is an outflow but never an inflow — money you intend to spend counts against you, money you merely hope to receive does not count for you. That asymmetry is the point of the whole tool.")}</p>
    </div>

    <div class="card mt"><h3>${t("The four verdicts")}</h3>
      <table class="tbl"><tbody>${verdicts.map(([v, cls, txt]) => `<tr>
        <td style="width:110px"><span class="pill ${cls}">${v}</span></td>
        <td>${esc(txt)}</td></tr>`).join("")}</tbody></table>
      <p class="muted mt" style="font-size:12px">${t("The verdict is always taken from the Bound run, and always from the worst entity.")}</p>
    </div>

    <div class="card mt"><h3>${t("The words on the screen")}</h3>
      <table class="tbl"><tbody>${terms.map(([k, v]) => `<tr>
        <td style="width:210px"><b>${esc(k)}</b></td><td class="muted">${esc(v)}</td></tr>`).join("")}</tbody></table>
    </div>

    <div class="card mt"><h3>${t("Reading Sensitivity & crisis")}</h3>
      <table class="tbl"><tbody>${sens.map(([k, v]) => `<tr>
        <td style="width:170px"><b>${esc(k)}</b></td><td class="muted">${esc(v)}</td></tr>`).join("")}</tbody></table>
      <p class="muted mt" style="font-size:12px">${t("If the plan already breaches with no stress applied, sensitivity says so instead of printing a break-even. There is no margin to measure when you are already through the floor.")}</p>
    </div>

    <div class="card mt"><h3>${t("When the answer looks wrong")}</h3>
      <table class="tbl"><tbody>${gotchas.map(([q, a]) => `<tr>
        <td style="width:280px"><b>${esc(q)}</b></td><td class="muted">${esc(a)}</td></tr>`).join("")}</tbody></table>
    </div>`;

  $$("#orBody .og-go").forEach(b => b.onclick = () => { location.hash = "#/" + b.dataset.route; });
  if ($("#og-policy")) $("#og-policy").onclick = () => oraclePolicyModal(() => oracleGuideView(body));
}

/* ------------------------------------------------------------------ THE ORACLE (Ahli Nujum) */
// Its own screen under HV Sections, in its own colour, because it is not the
// books — it is a forecast, and it should never be mistaken for a fact at a
// glance. It reads the live Budget Center (company level AND per project) and
// answers three questions: are we safe, when do we stop being safe, and what
// should we do about it.
//
// A saved plan version is a FROZEN COPY of the budget, kept so a verdict can be
// quoted later against the numbers it was actually given. The live budget is the
// default because that is the one people are editing.
async function pageOracle(el) {
  if (!state.oracleTab) state.oracleTab = "verdict";
  const vs = await api(`/api/plan/versions`).catch(() => ({ versions: [] }));
  // "" is the live budget; only fall back to it if a stored id has gone away
  if (state.planVersion && !vs.versions.some(v => v.id == state.planVersion))
    state.planVersion = null;

  el.innerHTML = `
    <div class="page-head"><h2 id="orTitle">${t("The Oracle")}
      <span class="muted" style="font-size:13px;font-weight:500">· ${t("Ahli Nujum")} · ${t("does the budget survive the year?")}</span></h2>
      <div class="page-actions">
        <label class="muted">${t("Reading")} <select id="orVersion" style="min-width:250px">
          <option value="" ${!state.planVersion ? "selected" : ""}>${t("Live budget (Budget Center)")}</option>
          ${vs.versions.map(v =>
            `<option value="${v.id}" ${v.id == state.planVersion ? "selected" : ""}>${esc(v.name)} · ${v.year} · ${esc(v.status)}</option>`).join("")}
        </select></label>
        ${canWrite() ? `<button class="btn btn-sm" id="orImport" title="${t("Read a weekly cashflow sheet into a scenario")}">&#x2912; ${t("Import cashflow")}</button>` : ""}
        ${canWrite() ? `<button class="btn btn-sm" id="orFreeze" title="${t("Keep a copy of the budget exactly as it is today, so this verdict can be quoted against it later")}">&#10052; ${t("Freeze as scenario")}</button>` : ""}
        <button class="btn btn-sm" id="orPolicy">&#9881; ${t("Cash policy")}</button>
      </div></div>
    <div class="tabs" id="orTabs">
      <button data-t="verdict" class="${state.oracleTab === "verdict" ? "active" : ""}">${t("Verdict & actions")}</button>
      <button data-t="sens" class="${state.oracleTab === "sens" ? "active" : ""}">${t("Sensitivity & crisis")}</button>
      <button data-t="guide" class="${state.oracleTab === "guide" ? "active" : ""}">${t("How to use")}</button>
    </div>
    <div id="orBody"><div class="empty">Loading…</div></div>`;

  const show = async () => {
    const body = $("#orBody");
    // on Verdict & actions the title is written on the picture instead
    $("#orTitle").hidden = state.oracleTab === "verdict";
    body.innerHTML = `<div class="card"><div class="empty">${t("Consulting the Oracle…")}</div></div>`;
    if (state.oracleTab === "guide") await oracleGuideView(body);
    else if (state.oracleTab === "verdict") await oracleVerdictView(body, state.planVersion, vs.versions);
    else await oracleSensitivityView(body, state.planVersion);
  };
  $$("#orTabs button").forEach(b => b.onclick = () => {
    state.oracleTab = b.dataset.t;
    $$("#orTabs button").forEach(x => x.classList.toggle("active", x === b));
    show();
  });
  $("#orVersion").onchange = e => {
    state.planVersion = e.target.value ? parseInt(e.target.value, 10) : null;
    show();
  };
  if ($("#orImport")) $("#orImport").onclick = () => oracleCashImportModal(vid => {
    state.planVersion = vid;          // read the Oracle against what was just imported
    state.oracleTab = "verdict";
    state.oracleAutoConsult = true;   // the import was the question - answer it straight away
    pageOracle(el);
  });
  if ($("#orFreeze")) $("#orFreeze").onclick = async () => {
    const name = prompt(t("Name this frozen scenario"),
                        `${t("Budget snapshot")} ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    try {
      const v = await api("/api/plan/versions", { json: { name, year: state.year } });
      const r = await api(`/api/plan/weeks/seed-from-budget/${v.id}`, { json: { year: state.year } });
      toast(`${t("Frozen")}: ${r.cells} ${t("weekly cells")}`);
      pageOracle(el);
    } catch (e) { toast(e.message, true); }
  };
  $("#orPolicy").onclick = () => oraclePolicyModal(() => { state.oracleAnswers = {}; show(); });
  await show();
}

// The opening of an Oracle session: the Pythia on her tripod, and one button.
// CONSULT WITH ORACLE re-reads whatever "Reading" points at - the live Budget
// Center as it stands this minute, or an imported / frozen scenario - and only
// then shows the verdict. The last answer per reading is kept for the session,
// stamped with when it was given, so coming back does not look like a new one.
async function oracleVerdictView(body, versionId, versions) {
  const key = `${state.year}:${versionId || "live"}`;
  const ver = (versions || []).find(v => v.id == versionId);
  const reading = ver
    ? `${t("Scenario")} <b>${esc(ver.name)}</b> · ${ver.year} · ${esc(t(ver.status || ""))} · ${fmt(ver.rows || 0)} ${t("weekly rows")}${ver.kind ? ` · ${esc(t(ver.kind))}` : ""}`
    : `<b>${t("Live budget (Budget Center)")}</b> · ${t("every budget line as it stands right now")}`;
  body.innerHTML = `
    <div class="card or-opening">
      <div class="or-scene" id="orScene"><div class="or-frame">
        <img src="/static/assets/oracle-delphi.jpg" alt="${t("The Pythia on her tripod at Delphi, answering two petitioners")}">
        <div class="or-title"><span class="or-eyebrow">${t("Ahli Nujum")}</span>
          <h2>${t("The Oracle")}</h2><p>${t("does the budget survive the year?")}</p></div>
        <div class="or-bottom">
          <button class="or-consult-btn" id="orConsult">&#9790; ${t("CONSULT WITH ORACLE")}</button>
          <div class="or-reading">${t("Reading")}: ${reading}</div>
          <div class="or-stamp" id="orStamp"></div>
        </div>
      </div></div>
    </div>
    <div id="orVerdict"></div>`;
  state.oracleAnswers = state.oracleAnswers || {};
  const stamp = a => {
    $("#orStamp").innerHTML = a ? `${t("Consulted at")} ${a.at} · ${t("press again to re-read the budget")}` : "";
  };
  const run = async () => {
    const btn = $("#orConsult"), scene = $("#orScene");
    btn.disabled = true;
    btn.innerHTML = `&#9790; ${t("The Oracle is reading the budget…")}`;
    scene.classList.add("consulting");
    const started = Date.now();
    let d;
    try { d = await api("/api/oracle/consult", { json: { version_id: versionId || null, year: state.year } }); }
    catch (e) {
      $("#orVerdict").innerHTML = `<div class="card mt"><p class="neg">${esc(e.message)}</p></div>`;
      d = null;
    }
    // let the smoke rise for a moment; the answer is already in hand
    await new Promise(r => setTimeout(r, Math.max(0, 900 - (Date.now() - started))));
    if (!document.body.contains(btn)) return;
    scene.classList.remove("consulting");
    btn.disabled = false;
    btn.innerHTML = `&#9790; ${t("CONSULT WITH ORACLE")}`;
    if (!d) return;
    const now = new Date(), p2 = n => String(n).padStart(2, "0");
    state.oracleAnswers[key] = { d, at: `${p2(now.getHours())}.${p2(now.getMinutes())}` };
    stamp(state.oracleAnswers[key]);
    oracleVerdictRender($("#orVerdict"), d);
    $("#orVerdict").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("#orConsult").onclick = run;
  const last = state.oracleAnswers[key];
  if (state.oracleAutoConsult) { state.oracleAutoConsult = false; return run(); }
  if (last) { stamp(last); oracleVerdictRender($("#orVerdict"), last.d); return; }
  $("#orVerdict").innerHTML = `<div class="card mt or-waiting"><p>${t("The Oracle has not been consulted on this reading yet.")}</p>
    <p class="muted">${t("Press CONSULT WITH ORACLE: it reads the budget exactly as it stands now and answers whether cash survives the year.")}</p></div>`;
}

function oracleVerdictRender(body, d) {
  const worst = d.entities.find(e => e.company_code === d.driven_by) || d.entities[0] || {};
  const wk = worst.weekly || [];
  const safe = worst.safe || {};

  const breachLine = safe.kind === "zero"
    ? `${t("After that cash goes BELOW ZERO on")} <b>${esc(fmtDate(safe.breach))}</b> — ${t("a payment will not clear.")}`
    : `${t("After that cash drops through the buffer floor on")} <b>${esc(fmtDate(safe.breach))}</b>.`;
  const safeLine = !safe.breach
    ? `<b class="pos">${t("Safe all year")}</b> — ${t("cash stays above the buffer floor every day on the Bound run.")}`
    : safe.never_safe
      ? `<b class="neg">${t("No safe period at all")}</b> — ${
           safe.kind === "zero"
             ? t("cash is already below zero on the first day of the plan")
             : t("cash is already under the buffer floor on the first day of the plan")
         } (<b>${esc(fmtDate(safe.breach))}</b>). ${t("This starts as an opening-balance problem, not a plan problem.")}`
      : `<b class="neg">${t("Safe until")} ${esc(fmtDate(safe.safe_until))}</b> — ${t("about")} <b>${safe.weeks_safe} ${t("weeks")}</b>. ${breachLine}`;

  body.innerHTML = `
    <div class="card mt">
      <div class="page-head"><h3 style="margin:0">
        <span class="pill ${VERDICT_CLS[d.verdict] || "inactive"}" style="font-size:14px">${esc(d.verdict)}</span>
        <span class="muted" style="font-weight:500;font-size:13px"> ${esc(d.verdict_text)}</span></h3>
        <div class="page-actions"><span class="muted">${esc(d.version_name)} · ${d.year} · ${d.items} ${t("dated items")}</span></div></div>
      <p style="margin-top:6px">${safeLine}</p>
      <div class="mt">${d.entities.map(e => `<span class="pill ${VERDICT_CLS[e.verdict] || "inactive"}"
        title="${t("floor")} ${fmtRp(e.floor)}">${esc(e.company_code)}: ${esc(e.verdict)}</span>`).join(" ")}</div>
      <p class="muted mt" style="font-size:12px"><b>${t("Group rule")}:</b> ${esc(d.rule)}</p>
    </div>

    <div id="orWeekly"></div>

    <div class="card mt"><h3>${t("Per entity")}</h3>
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th>${t("Entity")}</th><th>${t("Verdict")}</th><th>${t("Safe until")}</th>
          <th class="num">${t("Opening cash")}</th><th class="num">${t("Buffer floor")}</th>
          <th class="num">${t("Worst headroom")}</th><th>${t("Worst day")}</th></tr></thead>
        <tbody>${d.entities.map(e => `<tr>
          <td><b>${esc(e.company_code)}</b></td>
          <td><span class="pill ${VERDICT_CLS[e.verdict] || "inactive"}">${esc(e.verdict)}</span></td>
          <td>${!(e.safe && e.safe.breach) ? `<span class="pos">${t("all year")}</span>`
            : e.safe.never_safe ? `<span class="neg">${t("never")}</span>`
            : esc(fmtDate(e.safe.safe_until)) + ` <span class="muted">(${e.safe.weeks_safe}w)</span>`}</td>
          <td class="num">${fmt(e.opening_cash)}</td>
          <td class="num muted">${fmt(e.floor)}</td>
          <td class="num ${(e.detail.min_headroom || 0) < 0 ? "neg" : "pos"}">${fmt(e.detail.min_headroom || 0)}</td>
          <td>${esc(fmtDate(e.detail.worst_date) || "—")}</td></tr>`).join("")}</tbody></table></div>
    </div>

    ${(worst.contributors || []).length ? `<div class="card mt"><h3>${t("Biggest outflows before the worst day")}</h3>
      <table class="tbl"><thead><tr><th>${t("Date")}</th><th>${t("What")}</th><th>${t("Certainty")}</th><th class="num">${t("Amount")}</th></tr></thead>
        <tbody>${worst.contributors.map(cc => `<tr><td>${esc(fmtDate(cc.date))}</td><td>${esc(cc.label)}</td>
          <td><span class="pill ${CERTAINTY_PILL[cc.certainty] || "inactive"}">${esc(cc.certainty)}</span></td>
          <td class="num">${fmt(cc.amount)}</td></tr>`).join("")}</tbody></table></div>` : ""}

    ${(d.warnings || []).length ? `<div class="card mt"><h3>${t("Assumptions & warnings")}</h3>
      <ul class="muted" style="margin:0 0 0 18px;line-height:1.7;font-size:12.5px">
        ${d.warnings.map(w => `<li>${esc(fmtDatesIn(w))}</li>`).join("")}</ul></div>` : ""}`;
  renderOracleWeekly(d);
}

async function oracleSensitivityView(body, versionId) {
  let d;
  const vq = versionId ? `&version_id=${versionId}` : "";   // no version = the live budget
  try { d = await api(`/api/oracle/sensitivity?year=${state.year}${vq}`); }
  catch (e) { body.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
  const fmtLevel = (ax, lv) => {
    if (ax === "revenue_realisation") return Math.round(lv * 100) + "%";
    if (ax === "expense_overrun" || ax === "crisis_shock") return "+" + Math.round(lv * 100) + "%";
    if (ax === "collection_lag") return "+" + lv + "d";
    return lv ? t("yes") : t("no");
  };
  const maxSwing = Math.max(1, ...d.tornado.map(x => x.swing || 0));
  const tor = d.tornado.map(x => {
    if (x.not_applicable)
      return `<tr><td><b>${esc(x.label)}</b><br><span class="muted">${esc(x.help)}</span></td>
        <td colspan="2" class="muted">${t("Not applicable")} — ${esc(x.not_applicable)}</td></tr>`;
    const w = Math.round(100 * (x.swing || 0) / maxSwing);
    return `<tr><td><b>${esc(x.label)}</b><br><span class="muted">${esc(x.help)}</span></td>
      <td style="min-width:170px"><div class="bar"><span style="width:${w}%;background:${w > 66 ? "#bd362f" : w > 33 ? "#c87a08" : "#1f9d57"}"></span></div>
        <span class="muted" style="font-size:11px">${t("swing")} ${x.swing ? fmtShortRp(x.swing) : t("none — this axis changes nothing here")}</span></td>
      <td>${x.levels.map(lv => `<span class="pill ${VERDICT_CLS[lv.verdict] || "inactive"}" style="margin:1px"
        title="${t("min headroom")} ${fmtShortRp(lv.min_headroom || 0)}${lv.first_breach ? " · " + t("breach") + " " + fmtDate(lv.first_breach) : ""}">${fmtLevel(x.axis, lv.level)}</span>`).join(" ")}</td></tr>`;
  }).join("");

  const beBlocked = d.breakevens.filter(b => b.already_breached).length;
  const be = d.breakevens.filter(b => b.value != null).map(b => {
    const v = b.axis === "revenue_realisation" ? Math.round(b.value * 100) + "%"
            : "+" + Math.round(b.value * 100) + "%";
    return `<li><b>${esc(b.label)}</b>: ${b.target === "zero"
      ? t("cash goes below zero at") : t("the buffer floor breaks at")} <b class="neg">${v}</b></li>`;
  }).join("");

  const gridRows = d.grid.rows.map(r => `<tr>
    <td><b>${Math.round(r.revenue * 100)}%</b></td>
    ${r.cells.map(v => `<td class="num"><span class="pill ${VERDICT_CLS[v] || "inactive"}">${esc(v)}</span></td>`).join("")}</tr>`).join("");

  body.innerHTML = `
    <div class="card">
      <h3>${t("How wrong can we be before we are not safe?")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Plan as it stands")}:
        <span class="pill ${VERDICT_CLS[d.base_verdict] || "inactive"}">${esc(d.base_verdict)}</span>
        · ${t("min headroom")} <b>${fmtRp(d.base_min_headroom || 0)}</b></p>
      ${d.base_already_breached ? `<div class="warn danger mt"><span class="warn-ic">&#9888;</span>
        <span>${esc(d.base_note)}</span></div>` : ""}
    </div>

    <div class="card mt"><h3>${t("One-way sensitivity")} <span class="muted" style="font-weight:500;font-size:12.5px">· ${t("widest bar = the thing to manage")}</span></h3>
      <table class="tbl"><thead><tr><th style="width:38%">${t("What could go wrong")}</th>
        <th>${t("Impact")}</th><th>${t("Levels")}</th></tr></thead><tbody>${tor}</tbody></table>
    </div>

    ${be ? `<div class="card mt"><h3>${t("Break-even — the number to remember")}</h3>
      <ul style="margin:6px 0 0 20px;line-height:1.9">${be}</ul></div>`
      : beBlocked ? `<div class="card mt"><h3>${t("Break-even — the number to remember")}</h3>
        <p class="muted">${t("No break-even to report: the plan already breaches with no stress applied.")}</p></div>` : ""}

    <div class="card mt"><h3>${t("Revenue vs expense — the safe region")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Rows: how much planned cash in actually arrives. Columns: how much planned cash out overruns.")}</p>
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th>${t("Revenue \\\\ Expense")}</th>${d.grid.expense_levels.map(e =>
          `<th class="num">+${Math.round(e * 100)}%</th>`).join("")}</tr></thead>
        <tbody>${gridRows}</tbody></table></div>
      <p class="muted mt" style="font-size:12px">${esc(d.honesty)}</p>
    </div>

    ${(d.warnings || []).length ? `<div class="card mt"><h3>${t("Assumptions & warnings")}</h3>
      <ul class="muted" style="margin:0 0 0 18px;line-height:1.7;font-size:12.5px">
        ${d.warnings.map(w => `<li>${esc(fmtDatesIn(w))}</li>`).join("")}</ul></div>` : ""}`;
}

async function oraclePolicyModal(reload) {
  const d = await api("/api/oracle/buffer-policy?year=" + state.year);
  const p = d.policy;
  openModal(`
    <p class="muted" style="margin-top:-4px">${t("How much cash each company must never go below. The floor is the bigger of the absolute amount you set and a number of months of fixed cash operating cost.")}</p>
    <div class="form-grid">
      <label>${t("Months of cover")} <input id="opMonths" type="number" step="0.5" value="${p.months_cover}"></label>
      <label>${t("Collection lag (days) when unknown")} <input id="opLag" type="number" value="${p.default_collection_lag_days}"></label>
      <label class="full" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="opPool" ${p.cash_pooling ? "checked" : ""} style="width:auto">
        ${t("Cash pooling — the group sweeps cash between companies")}</label>
    </div>
    <p class="muted" style="font-size:12px">${t("With pooling OFF (your setting) the group is safe only if EVERY company is safe. Cash trapped in one entity does not pay another's payroll.")}</p>
    <h3 style="margin-top:14px">${t("Minimum cash per company")}</h3>
    <p class="muted" style="margin-top:-6px;font-size:12px">${t("Cash must never fall below this. Leave 0 and the only test is 'not below zero'.")}</p>
    <table class="tbl"><thead><tr><th>${t("Company")}</th><th class="num">${t("Fixed cash opex / month")}</th>
      <th class="num">${t("Minimum cash")}</th><th class="num">${t("Floor in force")}</th></tr></thead>
      <tbody>${d.floors.map(f => `<tr><td><b>${esc(f.company_code)}</b></td>
        <td class="num muted">${fmt(f.monthly_fixed_cash_opex)}</td>
        <td class="num"><input class="op-floor" data-code="${esc(f.company_code)}" inputmode="numeric"
          value="${f.absolute_floor ? fmt(f.absolute_floor) : ""}" style="width:150px;text-align:right"></td>
        <td class="num"><b>${fmt(f.floor)}</b></td></tr>`).join("")}</tbody></table>
    <div class="form-actions"><button class="btn btn-primary" id="opSave">${t("Save cash policy")}</button></div>`,
    { title: t("Cash policy") });
  $("#opSave").onclick = async () => {
    const floors = {};
    $$("#modalRoot .op-floor").forEach(i => {
      floors[i.dataset.code] = parseInt((i.value || "0").replace(/[^\d-]/g, ""), 10) || 0;
    });
    try {
      await api("/api/oracle/buffer-policy", { json: { policy: {
        months_cover: parseFloat($("#opMonths").value) || 2.0,
        default_collection_lag_days: parseInt($("#opLag").value, 10) || 14,
        cash_pooling: $("#opPool").checked,
        absolute_floor: floors } } });
      toast(t("Cash policy saved")); closeModal(); reload && reload();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ product finance analysis */
// One question per product: is it good, and does it make the company REAL profit?
// Months that have happened come from the ledger (the product's linked projects);
// months that have not come from the drivers on the Settings tab. Every table
// marks which is which, because a forecast shown as a fact is how a product
// looks healthy right up until it isn't.

const PF_VERDICT_CLS = { PROFITABLE: "posted", PROFITABLE_NOT_PAID_BACK: "draft", NOT_PROFITABLE: "bad", NO_DATA: "inactive", ERROR: "bad" };
const PF_VERDICT_LABEL = {
  PROFITABLE: "PROFITABLE", PROFITABLE_NOT_PAID_BACK: "RUN-RATE PROFITABLE · NOT PAID BACK",
  NOT_PROFITABLE: "NOT PROFITABLE", NO_DATA: "NO DATA", ERROR: "ERROR",
};
// green grades: the SBU section proves (or disproves) that a business line makes money
const PF_CAT_COLOR = { people: "#10b981", server: "#059669", marketing: "#34d399", tools: "#047857", office: "#6ee7b7", other: "#065f46" };
const SBU_GRADES = ["#10b981", "#059669", "#34d399", "#047857", "#6ee7b7", "#065f46", "#a7f3d0", "#94a3b8"];
const pfPct = (v, dp = 1) => v == null ? "—" : (v * 100).toFixed(dp) + "%";
const pfMonth = m => fmtYM(m);
const pfN = v => v == null ? "—" : fmtShort(v);
const pfRp = v => v == null ? "—" : fmtShortRp(v);
const pfTile = (label, value, sub, cls) => `<div class="kpi ${cls || ""}">
  <div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ""}</div>`;

async function pageProduct(el) {
  if (!state.pfTab) state.pfTab = "dash";
  let list = [];
  try { list = await api("/api/products"); }
  catch (e) { el.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
  // an SBU that was deleted, or lives in another database, is simply not open
  if (state.pfId && !list.some(p => p.id === state.pfId)) state.pfId = null;
  const cur = list.find(p => p.id === state.pfId);
  const num = id => list.findIndex(p => p.id === id) + 1;

  // the finance report (the NX-Sentimind workbook's sheets) first, the forecast model after the divider
  const tabs = [["dash", t("Dashboard")], ["rpnl", t("P&L YTD")], ["rcash", t("Cash Flow")], ["rtrack", t("Project Tracker")],
                ["rhealth", t("Health Indicators")], ["rsaas", t("SaaS Performance")], ["rset", t("Report settings")], "|",
                ["overview", t("Forecast model")], ["pnl", t("P&L by month")], ["saas", t("SaaS model")],
                ["server", t("Server cost")], ["target", t("Target & marketing")], ["settings", t("Model settings & drivers")]];
  el.innerHTML = `
    <div class="page-head"><h2>${cur ? `<button class="btn btn-sm" id="pfBack" title="${t("Back to all SBUs")}">&larr; ${t("All SBUs")}</button> ` : ""}${t("SBU")}${cur ? ` ${num(cur.id)}` : ""}
      <span class="muted" style="font-size:13px;font-weight:500">· ${cur ? esc(cur.name) : t("Strategic Business Unit · is it good, and does it make real profit?")}</span></h2>
      <div class="page-actions">
        ${list.length ? `<select id="pfSwitch" title="${t("Switch SBU")}" style="min-width:240px">
            <option value="">${t("— all SBUs —")}</option>
            ${list.map((p, i) => `<option value="${p.id}" ${p.id === state.pfId ? "selected" : ""}>SBU ${i + 1} · ${esc(p.name)}</option>`).join("")}
          </select>` : ""}
        ${cur ? `<a class="btn" href="/api/products/${cur.id}/report.xlsx?year=${state.year}" title="${t("The six-sheet finance report, like the NX-Sentimind template")}">&#x2913; ${t("Finance report")} ${state.year}</a>
                 <a class="btn" href="/api/products/${cur.id}/workbook" title="${t("Download this SBU's whole model as a workbook")}">&#x2913; ${t("Excel model")}</a>`
              : `<a class="btn" href="/api/products/template">&#x2913; ${t("Blank template")}</a>`}
        ${canWrite() ? `<button class="btn" id="pfImport">&#x2912; ${t("Import Excel")}</button>` : ""}
        ${canWrite() ? `<button class="btn btn-primary" id="pfNew">+ ${t("Launch an SBU")}</button>` : ""}
      </div></div>
    ${cur ? `<div class="tabs" id="pfTabs">${tabs.map(x => x === "|" ? `<span class="pf-tab-div" aria-hidden="true"></span>` :
      `<button data-t="${x[0]}" class="${state.pfTab === x[0] ? "active" : ""}">${x[1]}</button>`).join("")}</div>` : ""}
    <div id="pfBody" class="mt"></div>`;

  // the selector keeps the tab, so P&L of SBU 1 -> P&L of SBU 2 is one change
  const open = (id, keepTab) => { state.pfId = id || null; if (!keepTab) state.pfTab = "dash"; pageProduct(el); };
  const show = async () => {
    const body = $("#pfBody");
    if (!list.length) return pfEmpty(body, () => pageProduct(el));
    if (!cur) return pfPortfolio(body, list, open);
    body.innerHTML = `<div class="card"><div class="empty">${t("Running the numbers…")}</div></div>`;
    if (state.pfTab === "settings") return pfSettings(body, state.pfId, () => pageProduct(el));
    if (SBU_REPORT_TABS.includes(state.pfTab)) {
      let R;
      try { R = await api(`/api/products/${state.pfId}/report?year=${state.year}`); }
      catch (e) { body.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
      if (!document.body.contains(body)) return;
      if (state.pfTab === "rset") return pfRSettings(body, state.pfId, R, () => pageProduct(el));
      return ({ dash: pfRDash, rpnl: pfRPnl, rcash: pfRCash, rtrack: pfRTrack, rhealth: pfRHealth, rsaas: pfRSaas })[state.pfTab](body, R);
    }
    let a;
    try { a = await api(`/api/products/${state.pfId}/analysis`); }
    catch (e) { body.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
    const view = { overview: pfOverview, pnl: pfPnl, saas: pfSaas, server: pfServer, target: pfTarget }[state.pfTab] || pfOverview;
    view(body, a);
  };
  if ($("#pfBack")) $("#pfBack").onclick = () => open(null);
  if ($("#pfSwitch")) $("#pfSwitch").onchange = e => open(e.target.value ? parseInt(e.target.value, 10) : null, true);
  $$("#pfTabs button").forEach(b => b.onclick = () => {
    state.pfTab = b.dataset.t;
    $$("#pfTabs button").forEach(x => x.classList.toggle("active", x === b));
    show();
  });
  if ($("#pfImport")) $("#pfImport").onclick = () => pfImportModal(cur ? cur.id : null, open);
  if ($("#pfNew")) $("#pfNew").onclick = () => pfLaunchModal(open);
  await show();
}

// Every SBU in one table. "Back" lands here, so going from SBU 1 to SBU 2 is one
// click; the selector at the top jumps straight between SBUs from any tab.
function pfPortfolio(body, list, open) {
  body.innerHTML = `<div class="card">
    <h3>${t("All SBUs")} <span class="muted" style="font-weight:500">· ${list.length}</span></h3>
    <p class="muted" style="margin-top:-6px">${t("Click an SBU to open it. The selector at the top switches SBU from any tab.")}</p>
    <div class="pf-scroll"><table class="tbl">
      <thead><tr><th style="width:52px"></th><th>${t("SBU")}</th><th>${t("Company")}</th><th>${t("Stage")}</th><th>${t("Verdict")}</th>
        <th>${t("Break-even month")}</th><th class="num">${t("Funding required")}</th><th></th></tr></thead>
      <tbody>${list.map((p, i) => `<tr class="pf-row" data-id="${p.id}" style="cursor:pointer">
        <td class="ent-cell">${entThumb("product", p.id, p.image_v, p.name)}</td>
        <td><b>${esc(p.name)}</b><br><span class="muted"><b>SBU ${i + 1}</b>${p.code ? " · " + esc(p.code) : ""}</span></td>
        <td>${esc(p.company_code || "")}</td>
        <td><span class="pf-stage">${esc(t(p.stage || ""))}</span></td>
        <td><span class="pill ${PF_VERDICT_CLS[p.verdict] || "inactive"}">${esc(t(PF_VERDICT_LABEL[p.verdict] || p.verdict || ""))}</span></td>
        <td>${p.break_even_month ? pfMonth(p.break_even_month) : "—"}</td>
        <td class="num">${pfRp(p.funding_required)}</td>
        <td class="num"><button class="btn btn-sm">${t("Open")} &rarr;</button></td></tr>`).join("")}</tbody></table></div></div>`;
  $$("#pfBody .pf-row").forEach(tr => tr.onclick = () => open(parseInt(tr.dataset.id, 10)));
}

// Set an SBU up from Excel. Into an open SBU the file REPLACES its model; with no
// SBU open it creates a new one. The server applies nothing when any row is wrong.
function pfImportModal(pid, onDone) {
  const into = !!pid;
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  openModal(`
    <p class="muted" style="margin-top:0">${into
      ? t("Upload an SBU model workbook. It replaces this SBU's drivers, cost lines, one-offs, CAPEX and linked projects with what the file says.")
      : t("Upload a filled-in SBU model workbook to create a new SBU from it.")}
      <a href="${into ? `/api/products/${pid}/workbook` : "/api/products/template"}">${into ? t("Download this SBU as a workbook first") : t("Download the blank template")}</a></p>
    <form id="sbuImp" style="display:flex;flex-direction:column;gap:12px">
      ${into ? "" : `<label>${t("Company, when the file does not name one")} <select name="company_id">${companyOptions(cid)}</select></label>`}
      <label>${t("Excel file")} <input type="file" name="file" accept=".xlsx,.xlsm" required></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${t("Import")}</button></div>
    </form>
    <div id="sbuImpResult"></div>`, { title: into ? t("Import the SBU model from Excel") : t("New SBU from Excel"), small: true });
  $("#sbuImp").addEventListener("submit", async e => {
    e.preventDefault();
    if (into && !confirm(t("This replaces the SBU's whole model with the file's. Continue?"))) return;
    const out = $("#sbuImpResult");
    out.innerHTML = `<p class="muted">${t("Reading the file…")}</p>`;
    try {
      const res = await api(into ? `/api/products/${pid}/import` : "/api/products/import", { method: "POST", body: new FormData(e.target) });
      if (!res.ok) {
        out.innerHTML = `<p class="neg"><b>${t("Nothing was imported — fix these and upload again:")}</b></p>
          <ul>${(res.errors || []).map(x => `<li class="neg">${esc(x)}</li>`).join("")}</ul>`;
        return;
      }
      const sm = res.summary || {};
      toast(`${t("Imported")}: ${sm.cost_lines || 0} ${t("cost lines")}, ${sm.oneoffs || 0} ${t("one-offs")}, ${sm.capex || 0} CAPEX, ${sm.projects || 0} ${t("linked projects")}`);
      closeModal();
      onDone(res.id);
    } catch (err) { out.innerHTML = `<p class="neg">${esc(err.message)}</p>`; }
  });
}

function pfEmpty(body, reload) {
  body.innerHTML = `<div class="pf-two">
    <div class="card"><h3>${t("Start from a blank SBU")}</h3>
      <p class="muted">${t("Name it, link the ledger project it spends from, then set the drivers: team cost, marketing, price per user, churn and server cost.")}</p>
      ${canWrite() ? `<div class="form-actions"><button class="btn" id="pfXl">&#x2912; ${t("From an Excel file")}</button> <button class="btn" id="pfBlank">+ ${t("Launch an SBU")}</button></div>` : ""}</div>
    <div class="card"><h3>${t("Use the NX-01 model from your Excel")}</h3>
      <p class="muted">${t("Loads the drivers from “NX Plan Analysis 2026-2027” — team salary, food per working day, subscriptions, the Sep-26 marketing plan, the Rp 860 jt December termin and the CAPEX register — and links project NX-01 so Jan–Jul come straight from the ledger.")}</p>
      ${canWrite() ? `<div class="form-actions"><button class="btn btn-primary" id="pfTpl">${t("Load the NX-01 model")}</button></div>` : ""}</div>
  </div>`;
  const go = tpl => pfLaunchModal(id => { state.pfId = id; state.pfTab = "dash"; reload(); }, tpl);
  if ($("#pfBlank")) $("#pfBlank").onclick = () => go("");
  if ($("#pfXl")) $("#pfXl").onclick = () => pfImportModal(null, id => { state.pfId = id; state.pfTab = "dash"; reload(); });
  if ($("#pfTpl")) $("#pfTpl").onclick = () => go("nx01");
}

function pfLaunchModal(onDone, template = "") {
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  const nx = template === "nx01";
  openModal(`<div class="form-grid">
      <label>${t("SBU name")} <input id="plName" value="${nx ? "NX-01 Sentimind — Media Monitoring" : ""}" placeholder="Product 1"></label>
      <label>${t("Code")} <input id="plCode" placeholder="SBU-01"></label>
      <label>${t("Company")} <select id="plCo">${companyOptions(cid)}</select></label>
      <label>${t("Stage")} <select id="plStage">${["idea", "build", "launch", "growth", "sunset"].map(x =>
        `<option value="${x}" ${x === (nx ? "launch" : "build") ? "selected" : ""}>${esc(t(x))}</option>`).join("")}</select></label>
      <label>${t("Launch month")} <input type="month" id="plLaunch" value="${nx ? "2026-01" : new Date().toISOString().slice(0, 7)}"></label>
      <label>${t("Must be profitable by (year)")} <input type="number" id="plYear" value="${nx ? 2027 : new Date().getFullYear() + 1}"></label>
      <label class="full">${t("Start from")} <select id="plTpl">
        <option value="" ${nx ? "" : "selected"}>${t("A blank SBU")}</option>
        <option value="nx01" ${nx ? "selected" : ""}>${t("The NX-01 model from “NX Plan Analysis 2026-2027” (links project NX-01 if it exists)")}</option>
      </select></label>
    </div>
    <div class="form-actions"><button class="btn btn-primary" id="plGo">${t("Launch")}</button></div>`,
    { title: t("Launch an SBU") });
  $("#plGo").onclick = async () => {
    try {
      const r = await api("/api/products", { json: {
        name: $("#plName").value, code: $("#plCode").value, company_id: parseInt($("#plCo").value, 10),
        stage: $("#plStage").value, launch_month: $("#plLaunch").value,
        target_year: parseInt($("#plYear").value, 10), template: $("#plTpl").value,
      }});
      toast($("#plTpl").value === "nx01"
        ? (r.linked_project_id ? t("SBU launched from the NX-01 model and linked to project NX-01")
                               : t("SBU launched from the NX-01 model — no NX-01 project found to link"))
        : t("SBU launched"));
      closeModal(); onDone(r.id);
    } catch (e) { toast(e.message, true); }
  };
}

/* ---- pictures beside an SBU or an initiative ------------------------------ */
// The uploaded picture, or the name's initials in the same circle so the list
// stays lined up when some rows have no picture yet.
function entThumb(kind, id, v, name, size = 38) {
  if (v) return `<img class="ent-thumb" style="width:${size}px;height:${size}px" src="/api/images/${kind}/${id}?v=${encodeURIComponent(v)}" alt="" loading="lazy">`;
  const ini = String(name || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  return `<span class="ent-thumb ent-ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .36)}px">${esc(ini)}</span>`;
}
// Shrink in the browser before sending: a phone photo becomes a few dozen KB.
async function entImageBlob(file, max = 480) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(t("That file is not a picture the browser can read"))); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    let blob = await new Promise(r => c.toBlob(r, "image/webp", 0.86));
    if (!blob || blob.type !== "image/webp") blob = await new Promise(r => c.toBlob(r, "image/png"));
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
async function entImageUpload(kind, id, blob) {
  const fd = new FormData();
  fd.append("file", blob, blob.type === "image/png" ? "picture.png" : "picture.webp");
  return api(`/api/images/${kind}/${id}`, { method: "POST", body: fd });
}
// Picture control for a form. With an id the upload is saved at once; without
// one (a new record) the picture waits in field.pending until the record exists.
function entImageField(kind, id, v, name) {
  return `<div class="ent-img-field" data-kind="${kind}" data-id="${id || ""}">
    <span class="ent-img-prev">${entThumb(kind, id, v, name, 64)}</span>
    <div><label class="btn btn-sm" style="cursor:pointer">&#x2912; ${t(v ? "Change picture" : "Add picture")}
        <input type="file" class="ent-img-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      <button type="button" class="btn btn-sm btn-ghost ent-img-del" ${v ? "" : "hidden"}>${t("Remove")}</button>
      <div class="muted" style="font-size:11.5px;margin-top:4px">${t("Shown beside the name in the list. PNG, JPG, WebP or GIF — resized to 480 px.")}${id ? "" : " " + t("It is saved together with the new record.")}</div></div>
  </div>`;
}
function wireEntImageField(root, name, onChange) {
  const box = root.querySelector(".ent-img-field");
  if (!box) return null;
  const kind = box.dataset.kind, id = box.dataset.id;
  const prev = box.querySelector(".ent-img-prev"), del = box.querySelector(".ent-img-del");
  box.querySelector(".ent-img-file").onchange = async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const blob = await entImageBlob(file);
      if (!id) {
        box.pending = blob;
        prev.innerHTML = `<img class="ent-thumb" style="width:64px;height:64px" src="${URL.createObjectURL(blob)}" alt="">`;
        del.hidden = false;
        return;
      }
      const r = await entImageUpload(kind, id, blob);
      prev.innerHTML = entThumb(kind, id, r.v, name, 64);
      del.hidden = false;
      toast(t("Picture saved"));
      if (onChange) onChange(r.v);
    } catch (err) { toast(err.message, true); }
  };
  del.onclick = async () => {
    if (!id) { box.pending = null; prev.innerHTML = entThumb(kind, null, null, name, 64); del.hidden = true; return; }
    if (!confirm(t("Remove this picture?"))) return;
    try {
      await api(`/api/images/${kind}/${id}`, { method: "DELETE" });
      prev.innerHTML = entThumb(kind, id, null, name, 64);
      del.hidden = true;
      toast(t("Picture removed"));
      if (onChange) onChange(null);
    } catch (err) { toast(err.message, true); }
  };
  return box;
}

/* ---- SBU finance report (the NX-Sentimind workbook, from the ledger) -------- */
// Six views in the workbook's order - Dashboard, P&L YTD, Cash Flow, Project
// Tracker, Health Indicators, SaaS Performance - and the settings the ledger
// cannot supply. Every number that is a fact is a posted journal line on the
// SBU's linked projects; anything typed in Report settings is marked as such.
const SBU_STATUS = { safe: ["🟢 AMAN", "sbu-safe"], watch: ["🟡 PERHATIAN", "sbu-watch"], critical: ["🔴 KRITIS", "sbu-crit"] };
const SBU_TILE_CLS = ["t-navy", "t-blue", "t-teal", "t-green", "t-amber", "t-deep", "t-red", "t-cyan"];
const SBU_REPORT_TABS = ["dash", "rpnl", "rcash", "rtrack", "rhealth", "rsaas", "rset"];

function sbuPct(v, d = 2) { return v == null ? "—" : `${(v * 100).toFixed(d).replace(".", ",")}%`; }
function sbuVal(v, unit, status) {
  if (v == null) return unit === "months" && status === "safe" ? t("no net burn") : "—";
  if (unit === "rp") return fmtRp(v);
  if (unit === "pct") return sbuPct(v);
  if (unit === "months") return `~ ${Math.round(v)} ${t("Bulan")}`;
  if (unit === "x") return `${v.toFixed(2).replace(".", ",")}x`;
  if (unit === "days") return `${Math.round(v)} ${t("Hari")}`;
  return fmt(v);
}
function sbuLimit(v, unit, dir) {
  if (v == null) return "—";
  const sign = dir === "high" ? "≥ " : "≤ ";
  return sign + (unit === "rp" ? fmt(v) : unit === "pct" ? sbuPct(v) : unit === "months" ? `${v} ${t("Bulan")}`
    : unit === "days" ? `${v} ${t("Hari")}` : `${v}x`);
}
function sbuStatus(s) { const [l, c] = SBU_STATUS[s] || ["—", ""]; return `<span class="sbu-status ${c}">${l}</span>`; }
function sbuBanner(R, sheet) {
  return `<div class="sbu-banner"><div><b>${esc((R.title || "").toUpperCase())}  |  ${esc(sheet)}</b>
      ${R.subtitle ? `<span>${esc(R.subtitle)}</span>` : ""}</div>
    <div class="sbu-banner-r">${t("Update")}: ${fmtDate(R.generated)}  |  ${esc(R.quarter || "—")}
      <br><span>${R.through ? `${t("closed through")} ${esc(R.through_label)}` : t("no closed month in this year yet")}</span></div></div>`;
}
const sbuSrc = s => s && s !== "computed" && s !== "project" ? `<span class="sbu-src" title="${esc(t("where this number comes from"))}">${esc(t(s))}</span>` : "";

/* ---- DASHBOARD -------------------------------------------------------------- */
function pfRDash(body, R) {
  const tile = (x, i) => `<div class="sbu-tile ${SBU_TILE_CLS[i]}">
    <div class="sbu-tile-l">${esc(x.label)}</div>
    <div class="sbu-tile-v" title="${x.unit === "rp" && x.value != null ? fmtRp(x.value) : ""}">${sbuVal(x.value, x.unit, x.status)}</div>
    <div class="sbu-tile-s">${esc(fmtDatesIn(x.sub || ""))}</div></div>`;
  body.innerHTML = `${sbuBanner(R, "FINANCIAL DASHBOARD EKSEKUTIF")}
    <div class="sbu-tiles">${R.tiles.map(tile).join("")}</div>
    <div class="card mt sbu-card"><div class="sbu-sec">🚦  ${t("INDIKATOR KESEHATAN KEUANGAN")} — ${esc(R.title)} ${esc(R.quarter)}</div>
      ${sbuHealthTable(R.dashboard_indicators, true)}
      ${sbuLegend()}</div>
    ${R.projects.length ? "" : `<div class="card mt"><p class="neg">${t("This SBU has no linked projects, so there is no ledger behind the report. Link its projects on Model settings & drivers.")}</p></div>`}`;
}
function sbuLegend() {
  return `<div class="sbu-legend"><span class="sbu-status sbu-safe">🟢 AMAN = ${t("Dalam target")}</span>
    <span class="sbu-status sbu-watch">🟡 PERHATIAN = ${t("Perlu monitoring")}</span>
    <span class="sbu-status sbu-crit">🔴 KRITIS = ${t("Tindakan segera")}</span>
    <span class="muted">${t("Perbarui setiap tutup bulan")}</span></div>`;
}
function sbuHealthTable(list, compact) {
  return `<div class="pf-scroll"><table class="tbl sbu-health">
    <thead><tr><th>${t("Indikator")}</th><th class="num">${t("Nilai Aktual")}</th><th>${compact ? "Target 🟢" : t("Batas AMAN (🟢)")}</th>
      <th>${compact ? "Batas Min 🟡" : t("Batas PERHATIAN (🟡)")}</th><th>${t("Status")}</th><th style="min-width:280px">${compact ? t("Catatan & Rekomendasi Direksi") : t("Interpretasi & Tindakan")}</th></tr></thead>
    <tbody>${list.map(i => `<tr>
      <td><b>${esc(t(i.label))}</b>${i.source === "entered" ? ` ${sbuSrc("entered")}` : ""}</td>
      <td class="num sbu-v-${i.status}"><b>${sbuVal(i.value, i.unit, i.status)}</b></td>
      <td class="muted">${sbuLimit(i.safe, i.unit, i.direction)}</td><td class="muted">${sbuLimit(i.attention, i.unit, i.direction)}</td>
      <td>${sbuStatus(i.status)}</td><td class="sbu-note">${esc(fmtDatesIn(i.note))}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ---- P&L YTD ---------------------------------------------------------------- */
function pfRPnl(body, R) {
  const T = R.through, L = {}; R.pnl.lines.forEach(l => L[l.key] = l);
  const A = R.pnl.totals.actual, B = R.pnl.totals.budget;
  const months = [...Array(12).keys()];
  const showM = state.sbuPnlMonths !== false;
  const cell = (v, cls) => `<td class="num ${cls || ""}">${v == null ? "" : fmt(v)}</td>`;
  const varCell = (a, b, isRev) => { const v = isRev ? a - b : b - a; return `<td class="num ${v < 0 ? "neg" : v > 0 ? "pos" : ""}">${fmt(v)}</td>`; };
  const ytdSum = arr => arr.slice(0, T).reduce((x, y) => x + y, 0), fySum = arr => arr.reduce((x, y) => x + y, 0);
  const row = (label, a, b, isRev, cls) => `<tr class="${cls || ""}"><td class="sbu-lbl">${label}</td>
    ${showM ? months.map(m => cell(b[m]) + (m < T ? cell(a[m]) + varCell(a[m], b[m], isRev) : `<td></td><td></td>`)).join("") : ""}
    ${cell(ytdSum(b), "sbu-ytd")}${cell(ytdSum(a), "sbu-ytd")}${varCell(ytdSum(a), ytdSum(b), isRev)}${cell(fySum(b), "sbu-fy")}</tr>`;
  const line = (k, isRev) => row(`&nbsp;&nbsp;&nbsp;&nbsp;${esc(L[k].label)}${L[k].accounts.length ? ` <span class="muted" title="${esc(L[k].accounts.map(a => a.join(" ")).join(", "))}">(${L[k].accounts.map(a => esc(a[0])).join(", ")})</span>` : ""}`,
    L[k].actual, L[k].budget, isRev);
  const sec = (text, cls) => `<tr class="sbu-secrow ${cls || ""}"><td colspan="${(showM ? 36 : 0) + 5}">${text}</td></tr>`;
  const sub = text => `<tr><td class="sbu-lbl" colspan="${(showM ? 36 : 0) + 5}"><b>${text}</b></td></tr>`;
  const Y = R.pnl.ytd, F = R.pnl.full;
  const net = (y, f) => `<tr class="sbu-totrow"><td class="sbu-lbl">${t("LABA BERSIH (NET PROFIT)")}</td>
    ${showM ? months.map(m => cell(B.ebit[m]) + (m < T ? cell(A.ebit[m]) + varCell(A.ebit[m], B.ebit[m], true) : "<td></td><td></td>")).join("") : ""}
    ${cell(Y.budget.net, "sbu-ytd")}${cell(Y.actual.net, "sbu-ytd")}${varCell(Y.actual.net, Y.budget.net, true)}${cell(F.budget.net, "sbu-fy")}</tr>`;
  body.innerHTML = `${sbuBanner(R, `LAPORAN LABA RUGI — BUDGET VS AKTUAL ${R.year}`)}
    <div class="pf-kpis mt">
      ${pfTile(t("Revenue YTD"), pfRp(Y.actual.revenue), `${t("budget")} ${pfRp(Y.budget.revenue)}`, Y.actual.revenue >= Y.budget.revenue ? "good" : "warn")}
      ${pfTile(t("HPP / COGS YTD"), pfRp(Y.actual.cogs), `${t("budget")} ${pfRp(Y.budget.cogs)}`, Y.actual.cogs > Y.budget.cogs ? "bad" : "")}
      ${pfTile(t("Gross profit YTD"), pfRp(Y.actual.gross), `${t("margin")} ${sbuPct(Y.actual.revenue ? Y.actual.gross / Y.actual.revenue : null)}`, Y.actual.gross < 0 ? "bad" : "good")}
      ${pfTile(t("OPEX YTD"), pfRp(Y.actual.opex), `${t("budget")} ${pfRp(Y.budget.opex)}`)}
      ${pfTile("EBITDA YTD", pfRp(Y.actual.ebitda), `${t("budget")} ${pfRp(Y.budget.ebitda)}`, Y.actual.ebitda < 0 ? "bad" : "good")}
      ${pfTile(t("Net profit YTD"), pfRp(Y.actual.net), `${t("tax est.")} ${sbuPct(R.pnl.tax_rate, 0)}`, Y.actual.net < 0 ? "bad" : "good")}
    </div>
    <div class="card mt sbu-card">
      <div class="filters" style="margin-bottom:8px"><label class="chk"><input type="checkbox" id="sbuPnlM" ${showM ? "checked" : ""}> ${t("Show every month")}</label>
        <span class="muted">${t("Variance: revenue and profit rows read actual − budget; cost rows read budget − actual, so red is always bad.")}</span></div>
      <div class="pf-scroll sbu-pnl-scroll"><table class="tbl sbu-pnl">
        <thead><tr><th class="sbu-lbl" rowspan="2">${t("KATEGORI")}</th>
          ${showM ? R.months.map(m => `<th colspan="3" class="sbu-mh">${esc(t(m))}</th>`).join("") : ""}
          <th colspan="3" class="sbu-mh">YTD ${esc(R.months[0])}–${esc(R.months[Math.max(0, T - 1)])}</th><th class="sbu-mh">FULL YEAR</th></tr>
          <tr>${showM ? R.months.map(() => `<th class="num">Budget</th><th class="num">Aktual</th><th class="num">Var</th>`).join("") : ""}
          <th class="num">Bud YTD</th><th class="num">Akt YTD</th><th class="num">Var YTD</th><th class="num">Budget</th></tr></thead>
        <tbody>
          ${sec(t("PENDAPATAN (REVENUE)"), "sbu-sec-rev")}
          ${line("rev_saas", true)}${line("rev_project", true)}
          ${row(t("TOTAL PENDAPATAN"), A.revenue, B.revenue, true, "sbu-totrow")}
          ${sec(t("HARGA POKOK PENJUALAN (HPP / COGS)"))}
          ${sub(t("Project Based:"))}
          ${["cogs_p_direct", "cogs_p_nondirect", "cogs_p_material", "cogs_p_other"].map(k => line(k, false)).join("")}
          ${sub(`SaaS — ${esc(R.title)}:`)}
          ${["cogs_s_direct", "cogs_s_cloud", "cogs_s_api", "cogs_s_material", "cogs_s_other"].map(k => line(k, false)).join("")}
          ${row(t("TOTAL HPP"), A.cogs, B.cogs, false, "sbu-totrow")}
          ${row(t("LABA KOTOR (GROSS PROFIT)"), A.gross, B.gross, true, "sbu-totrow")}
          ${sec(t("BIAYA OPERASIONAL (OPEX)"))}
          ${["opex_salary", "opex_software", "opex_rent", "opex_util", "opex_event", "opex_meals", "opex_ent", "opex_medical", "opex_equipment", "opex_other"].map(k => line(k, false)).join("")}
          ${row(t("TOTAL OPEX"), A.opex, B.opex, false, "sbu-totrow")}
          ${row("EBITDA", A.ebitda, B.ebitda, true, "sbu-totrow")}
          ${line("da", false)}
          ${row("EBIT", A.ebit, B.ebit, true, "sbu-totrow")}
          <tr><td class="sbu-lbl">&nbsp;&nbsp;&nbsp;&nbsp;${t("Pajak Penghasilan (est.)")} ${sbuPct(R.pnl.tax_rate, 0)}</td>${showM ? "<td></td>".repeat(36) : ""}
            ${cell(Y.budget.tax, "sbu-ytd")}${cell(Y.actual.tax, "sbu-ytd")}<td></td>${cell(F.budget.tax, "sbu-fy")}</tr>
          ${net()}
        </tbody></table></div>
      <p class="muted" style="font-size:12px">${t("Actual = posted journal lines tagged to the SBU's projects; budget = the Budget Center rows on those projects. Revenue and HPP are split by the kind of project (client project or SaaS product) set in Report settings; the account codes behind each line are in brackets and can be changed there too. Tax is estimated on the year-to-date and full-year profit only.")}</p>
    </div>`;
  $("#sbuPnlM").onchange = e => { state.sbuPnlMonths = e.target.checked; pfRPnl(body, R); };
}

/* ---- CASH FLOW -------------------------------------------------------------- */
function pfRCash(body, R) {
  const C = R.cash, T = R.through;
  const mm = C.months.slice(0, Math.max(T, 1));
  body.innerHTML = `${sbuBanner(R, `LAPORAN ARUS KAS — REAL-TIME TRACKER · YTD ${R.year}`)}
    <div class="sbu-cf-tiles">
      <div class="sbu-cf t-green"><span>${t("Cash In Total")}</span><b>${fmtRp(C.in_ytd)}</b></div>
      <div class="sbu-cf t-red"><span>${t("Cash Out Total")}</span><b>${fmtRp(-C.out_ytd)}</b></div>
      <div class="sbu-cf t-navy"><span>${t("Net Cash")}</span><b>${fmtRp(C.net_ytd)}</b></div>
      <div class="sbu-cf t-teal"><span>${t("Posisi Kas (opening + net)")}</span><b>${fmtRp(C.position)}</b><em>${t("opening")} ${fmt(C.opening)}</em></div>
      <div class="sbu-cf t-amber"><span>${t("Burn rate")}</span><b>${fmtRp(C.burn)}/${t("bln")}</b><em>${t("gross")} ${fmt(C.gross_burn)}/${t("bln")}</em></div>
    </div>
    <div class="pf-two mt">
      <div class="card"><h3>${t("Monthly Summary")}</h3>
        ${chartBars(mm.map((m, i) => t(R.months[i])), [
          { name: t("Cash In"), color: "#1A7A4A", values: mm.map(m => m.in) },
          { name: t("Cash Out"), color: "#B03A2E", values: mm.map(m => -m.out) },
          { name: t("Ending Balance"), color: "#028090", values: mm.map(m => m.ending), type: "line" },
        ], { height: 230 })}</div>
      <div class="card"><h3>&nbsp;</h3><table class="tbl"><thead><tr><th>${t("Month")}</th><th class="num">${t("Cash In Total")}</th>
        <th class="num">${t("Cash Out Total")}</th><th class="num">${t("Net Cash Flow")}</th><th class="num">${t("Ending Balance")}</th></tr></thead>
        <tbody>${mm.map((m, i) => `<tr><td>${esc(t(R.months[i]))} ${R.year}</td><td class="num pos">${fmt(m.in)}</td><td class="num neg">${fmt(-m.out)}</td>
          <td class="num ${m.net < 0 ? "neg" : "pos"}">${fmt(m.net)}</td><td class="num"><b>${fmt(m.ending)}</b></td></tr>`).join("")}</tbody></table></div>
    </div>
    <div class="card mt">
      <div class="filters" style="flex-wrap:wrap;gap:8px">
        <div class="seg-group" id="sbuCfType">${[["", t("All")], ["Cash In", "Cash In"], ["Cash Out", "Cash Out"]].map(([k, l]) =>
          `<button class="seg ${k === "" ? "active" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
        <select id="sbuCfLine"><option value="">${t("Every expense type")}</option>${[...new Set(C.rows.map(r => r.line))].sort().map(l => `<option>${esc(l)}</option>`).join("")}</select>
        <select id="sbuCfCat"><option value="">${t("Every project")}</option>${[...new Set(C.rows.map(r => r.category))].sort().map(l => `<option>${esc(l)}</option>`).join("")}</select>
        <input id="sbuCfQ" placeholder="${t("Search description or reference")}" style="min-width:220px">
        <span class="muted" id="sbuCfN"></span></div>
      <div class="pf-scroll"><table class="tbl ex-tbl"><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Expense</th>
        <th>Category</th><th>Tipe</th><th class="num">Cash In (IDR)</th><th class="num">Cash Out (IDR)</th><th class="num">Running Balance (IDR)</th></tr></thead>
        <tbody id="sbuCfRows"></tbody></table></div>
      <div class="form-actions" style="justify-content:flex-start"><button class="btn btn-sm" id="sbuCfMore" hidden>${t("Show more")}</button></div>
      <p class="muted" style="font-size:12px">${t("Every posted revenue and cost line on the SBU's projects, as the workbook lists them; depreciation is left out because it is not cash. Rows after the closing month are shown faded and are not in the totals.")}</p>
    </div>`;
  let typ = "", shown = 80;
  const draw = () => {
    const q = ($("#sbuCfQ").value || "").toLowerCase(), ln = $("#sbuCfLine").value, cat = $("#sbuCfCat").value;
    const list = C.rows.filter(r => (!typ || r.type === typ) && (!ln || r.line === ln) && (!cat || r.category === cat)
      && (!q || `${r.description} ${r.entry_no} ${r.account}`.toLowerCase().includes(q)));
    $("#sbuCfN").textContent = `${list.length} ${t("rows")}`;
    $("#sbuCfRows").innerHTML = list.slice(0, shown).map(r => `<tr data-id="${r.entry_id}" class="ex-open" style="${r.closed ? "" : "opacity:.5"}">
      <td>${fmtDate(r.date)}</td><td style="font-size:12px">${esc(r.entry_no)}</td><td>${esc(r.description)}<br><span class="muted" style="font-size:11.5px">${esc(r.account)}</span></td>
      <td>${esc(r.line)}</td><td class="muted">${esc(r.category)}</td><td><span class="pill ${r.cash_in ? "posted" : "draft"}">${esc(r.type)}</span></td>
      <td class="num pos">${r.cash_in ? fmt(r.cash_in) : ""}</td><td class="num neg">${r.cash_out ? fmt(r.cash_out) : ""}</td>
      <td class="num">${fmt(r.balance)}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">${t("Nothing matches.")}</td></tr>`;
    $("#sbuCfMore").hidden = list.length <= shown;
    $$("#sbuCfRows .ex-open").forEach(tr => tr.onclick = () => viewJournal(parseInt(tr.dataset.id, 10)));
  };
  $$("#sbuCfType .seg").forEach(b => b.onclick = () => { typ = b.dataset.k; shown = 80;
    $$("#sbuCfType .seg").forEach(x => x.classList.toggle("active", x === b)); draw(); });
  ["#sbuCfLine", "#sbuCfCat"].forEach(s => $(s).onchange = () => { shown = 80; draw(); });
  $("#sbuCfQ").oninput = () => { shown = 80; draw(); };
  $("#sbuCfMore").onclick = () => { shown += 240; draw(); };
  draw();
}

/* ---- PROJECT TRACKER -------------------------------------------------------- */
function pfRTrack(body, R) {
  const K = R.tracker, S = K.summary, bk = ["direct", "nondirect", "material", "misc"];
  body.innerHTML = `${sbuBanner(R, `TRACKER PROYEK — BUDGET VS REALISASI ${R.year}`)}
    <div class="card mt sbu-card"><div class="pf-scroll"><table class="tbl sbu-track">
      <thead><tr class="sbu-grp"><th colspan="2">${t("PROYEK")}</th><th colspan="2">TIMELINE</th><th>${t("NILAI KONTRAK")}</th>
        <th colspan="4">${t("BUDGET BIAYA")}</th><th colspan="4">${t("REALISASI BIAYA")}</th><th>GROSS MARGIN</th>
        <th colspan="2">INVOICING</th><th>STATUS</th><th>${t("RISIKO")}</th><th>NOTE</th></tr>
        <tr><th>${t("Nama Proyek")}</th><th>${t("Klien")}</th><th>${t("Mulai")}</th><th>${t("Selesai")}</th><th class="num">${t("Nilai Kontrak")}</th>
          <th class="num">Bud. Direct</th><th class="num">Bud. Non Direct</th><th class="num">Bud. Materials</th><th class="num">Bud. Fixed/Misc</th>
          <th class="num">Act. Direct</th><th class="num">Act. Non Direct</th><th class="num">Act. Material</th><th class="num">Act. Fixed/Misc</th>
          <th class="num">Gross Margin</th><th class="num">Invoice</th><th class="num">${t("Terbayar")}</th><th>Status</th><th>${t("Risiko")}</th><th style="min-width:260px">Note</th></tr></thead>
      <tbody>${K.rows.map(r => `<tr>
        <td><b>${esc(r.code)}</b> — ${esc(r.name)}${r.kind === "saas" ? ` <span class="sbu-src">SaaS</span>` : ""}</td><td>${esc(r.client || "—")}</td>
        <td>${r.start ? fmtDate(r.start) : "—"}</td><td>${r.end ? fmtDate(r.end) : "—"}</td>
        <td class="num"><b>${fmt(r.contract_value)}</b>${sbuSrc(r.contract_source)}</td>
        ${bk.map(k => `<td class="num sbu-bud">${fmt(r.budget[k])}</td>`).join("")}
        ${bk.map(k => `<td class="num sbu-act">${fmt(r.actual[k])}</td>`).join("")}
        <td class="num ${r.gross_margin != null && r.gross_margin < 0 ? "neg" : "pos"}"><b>${sbuPct(r.gross_margin)}</b></td>
        <td class="num">${fmt(r.invoiced)}${sbuSrc(r.invoiced_source)}</td><td class="num">${fmt(r.paid)}${sbuSrc(r.paid_source)}</td>
        <td>${esc(r.status)}</td><td>${r.risk ? `<span class="sbu-risk sbu-risk-${esc(r.risk.toLowerCase())}">${esc(r.risk)}</span>` : "—"}</td>
        <td class="sbu-note">${esc(r.note)}</td></tr>`).join("") || `<tr><td colspan="19" class="empty">${t("No linked projects.")}</td></tr>`}</tbody></table></div>
      <div class="sbu-sec mt">${t("RINGKASAN PIPELINE & COLLECTION")}</div>
      <div class="sbu-sum">
        <div><span>${t("Total Nilai Pipeline")}</span><b>${fmtRp(S.pipeline)}</b></div>
        <div><span>${t("Total Invoice Terkirim")}</span><b>${fmtRp(S.invoiced)}</b></div>
        <div><span>${t("Total Terbayar")}</span><b>${fmtRp(S.paid)}</b></div>
        <div class="${S.outstanding > 0 ? "neg" : ""}"><span>${t("Total Outstanding")}</span><b>${fmtRp(S.outstanding)}</b></div></div>
      <p class="muted" style="font-size:12px">${t("Budget = Budget Center rows on the project; realisation = posted cost lines up to the closing month (5100-01 Direct, 5100-02 Non Direct, 5100-03 Material, everything else Fixed/Misc). Gross margin = (contract − realised cost) ÷ contract, or on revenue when no contract value is set. Invoice comes from the Money Tracker unless typed in Report settings; paid is the revenue the ledger has received unless typed.")}</p>
    </div>`;
}

/* ---- HEALTH INDICATORS ------------------------------------------------------ */
function pfRHealth(body, R) {
  const acts = R.actions.length ? R.actions : R.suggested_actions;
  const lbl = {}; R.urgencies.forEach(u => lbl[u.key] = u.label);
  body.innerHTML = `${sbuBanner(R, "INDIKATOR KESEHATAN KEUANGAN — SISTEM PERINGATAN")}
    <div class="card mt sbu-card">${sbuLegend()}
      ${R.groups.map(g => `<div class="sbu-sec mt">${esc(t(g.label).toUpperCase())}</div>
        ${sbuHealthTable(R.indicators.filter(i => i.group === g.key), false)}`).join("")}
    </div>
    <div class="card mt sbu-card"><div class="sbu-sec sbu-sec-red">⚡  ${t("PRIORITAS TINDAKAN DIREKSI")} — ${esc(R.quarter)}</div>
      ${acts.length ? `<table class="tbl"><thead><tr><th style="width:150px">${t("Urgensi")}</th><th>${t("Tindakan yang Diperlukan")}</th></tr></thead>
        <tbody>${acts.map(a => `<tr><td><span class="sbu-urg sbu-urg-${a.urgency}">${esc(lbl[a.urgency] || a.urgency)}</span></td><td>${esc(fmtDatesIn(a.text))}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">${t("No actions yet.")}</div>`}
      ${!R.actions.length && acts.length ? `<p class="muted" style="font-size:12px">${t("Suggested from the KRITIS indicators. Write the board's own actions on Report settings and they replace these.")}</p>` : ""}
    </div>`;
}

/* ---- SaaS PERFORMANCE ------------------------------------------------------- */
function pfRSaas(body, R) {
  const S = R.saas, tl = S.tiles, T = R.through;
  const rowsHtml = (label, key, f, closedOnly) => `<tr><td class="sbu-lbl">${label}</td>${S.rows.map(r => {
    const v = r[key]; const hide = v == null || (closedOnly && !r.closed);
    return `<td class="num ${r.closed ? "" : "sbu-open"}">${hide ? "" : f(v)}</td>`; }).join("")}</tr>`;
  const n = v => fmt(v), p = v => sbuPct(v, 1), x = v => `${String(v).replace(".", ",")}x`;
  body.innerHTML = `${sbuBanner(R, `KINERJA SaaS · Subscription Metrics ${R.year}`)}
    <div class="sbu-tiles sbu-tiles-5">
      <div class="sbu-tile t-blue"><div class="sbu-tile-l">ARR (Annualized)</div><div class="sbu-tile-v">${tl.arr == null ? "—" : fmtRp(tl.arr)}</div></div>
      <div class="sbu-tile t-cyan"><div class="sbu-tile-l">MRR ${t("Terkini")} (${esc(T ? t(R.months[T - 1]) : "—")})</div><div class="sbu-tile-v">${tl.mrr == null ? "—" : fmtRp(tl.mrr)}</div></div>
      <div class="sbu-tile t-blue"><div class="sbu-tile-l">Total Customer</div><div class="sbu-tile-v">${fmt(tl.customers)} ${t("Pelanggan")}</div></div>
      <div class="sbu-tile t-cyan"><div class="sbu-tile-l">Churn Rate ${esc(tl.quarter)}</div><div class="sbu-tile-v">${sbuPct(tl.churn_quarter, 1)}</div></div>
      <div class="sbu-tile t-blue"><div class="sbu-tile-l">ARPU ${t("Rata-rata")}</div><div class="sbu-tile-v">${tl.arpu == null ? "—" : fmtRp(tl.arpu)}</div></div>
    </div>
    <div class="card mt"><h3>MRR Budget vs ${t("Aktual")}</h3>
      ${chartBars(R.months.map(m => t(m)), [
        { name: "MRR Budget", color: "#9aa6b1", values: S.rows.map(r => r.mrr_budget || 0) },
        { name: "MRR Aktual", color: "#1A5276", values: S.rows.map(r => r.closed ? (r.mrr_actual || 0) : 0) },
        { name: t("Customers (end)"), color: "#028090", values: S.rows.map(r => r.end), type: "line" },
      ], { height: 220 })}</div>
    <div class="card mt sbu-card"><div class="pf-scroll"><table class="tbl sbu-saas">
      <thead><tr><th class="sbu-lbl">${t("METRIK")}</th>${R.months.map(m => `<th class="num">${esc(t(m))}</th>`).join("")}</tr></thead>
      <tbody>
        <tr class="sbu-secrow"><td colspan="13">CUSTOMER (PELANGGAN)</td></tr>
        ${rowsHtml(t("Customer Awal Bulan"), "start", n)}${rowsHtml(t("Pelanggan Baru (Akuisisi)"), "new", n)}
        ${rowsHtml(t("Churned (Berhenti)"), "churned", n)}${rowsHtml(`<b>${t("Customer Akhir Bulan")}</b>`, "end", n)}
        <tr class="sbu-secrow"><td colspan="13">REVENUE (MRR / ARR)</td></tr>
        ${rowsHtml("MRR Budget (Rp)", "mrr_budget", n)}${rowsHtml("<b>MRR Aktual (Rp)</b>", "mrr_actual", n, true)}
        ${rowsHtml("ARR Annualized (Rp)", "arr", n, true)}${rowsHtml("Variance MRR (Rp)", "variance", n, true)}
        ${rowsHtml("MRR Achievement %", "achievement", p, true)}
        <tr class="sbu-secrow"><td colspan="13">CHURN, GROWTH & UNIT ECONOMICS</td></tr>
        ${rowsHtml("Churn Rate (%)", "churn", p)}${rowsHtml("MRR Growth MoM (%)", "growth", p, true)}
        ${rowsHtml("ARPU (Avg Rev / User, Rp)", "arpu", n, true)}
        ${rowsHtml(`LTV est. (${t("assumes churn")} ${sbuPct(S.ltv_churn, 0)} ${t("when none")}, Rp)`, "ltv", n, true)}
        ${rowsHtml("CAC (Biaya Akuisisi, Rp)", "cac", n)}${rowsHtml("LTV/CAC Ratio", "ltv_cac", x)}
      </tbody></table></div>
      <p class="sbu-bench">💡 ${t("Benchmark SaaS Sehat: Churn < 5%/bln | LTV/CAC > 3x | NRR > 100% | MRR Growth > 15%/bln.")}</p>
      <p class="muted" style="font-size:12px">${t("Customers, CAC spend and any MRR figure you type come from Report settings. A blank MRR actual is the revenue booked on the SBU's SaaS projects that month; a blank MRR budget is their revenue budget.")}</p>
    </div>`;
}

/* ---- REPORT SETTINGS -------------------------------------------------------- */
function pfRSettings(body, pid, R, reload) {
  const S = R.settings, ro = canWrite() ? "" : "disabled";
  const num = v => (v == null || v === "") ? "" : v;
  const pct = v => (v == null || v === "") ? "" : +(v * 100).toFixed(4);
  const tr = {}; R.tracker.rows.forEach(r => tr[r.project_id] = r);
  const risks = ["", "Rendah", "Sedang", "Tinggi"];
  const months = [...Array(12).keys()].map(i => `${R.year}-${String(i + 1).padStart(2, "0")}`);
  const sr = {}; R.saas.rows.forEach(r => sr[r.month] = r);
  body.innerHTML = `
    <div class="card pf-edit"><h3>DASHBOARD — ${t("the report")}</h3>
      <div class="form-grid">
        <label>${t("Report name on the banner")} <input id="rsTitle" value="${esc(S.title)}" placeholder="${esc(R.product.name)}" ${ro}></label>
        <label>${t("Subtitle")} <input id="rsSub" value="${esc(S.subtitle)}" placeholder="Software House" ${ro}></label>
        <label>${t("Closed through (month)")} <input type="month" id="rsThrough" value="${esc(S.through)}" ${ro}>
          <span class="muted" style="font-weight:400">${t("blank = last complete month")}</span></label>
        <label>${t("Opening cash, 1 January (Rp)")} <input type="number" step="any" id="rsOpen" value="${num(S.opening_cash)}" ${ro}></label>
        <label>${t("Headcount (for revenue per employee)")} <input type="number" step="1" id="rsHead" value="${num(S.headcount)}" ${ro}></label>
        <label>${t("Income tax estimate (%)")} <input type="number" step="any" id="rsTax" value="${pct(S.tax_rate)}" ${ro}></label>
        <label>${t("Churn assumed for LTV when nobody churned (%)")} <input type="number" step="any" id="rsLtv" value="${pct(S.ltv_churn)}" ${ro}></label>
        <label>${t("Customers at the start of the year")} <input type="number" step="1" id="rsCust0" value="${num(S.opening_customers)}" ${ro}></label>
      </div></div>

    <div class="card mt pf-edit"><h3>TRACKER PROYEK — ${t("per linked project")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Kind decides where revenue and HPP land on the P&L: a client project or the SaaS product. Blank amounts fall back to what the system knows (shown faded).")}</p>
      <div class="pf-scroll"><table class="tbl sbu-set"><thead><tr><th>${t("Project")}</th><th>${t("Kind")}</th><th>${t("Klien")}</th><th>Status</th><th>${t("Risiko")}</th>
        <th class="num">${t("Nilai Kontrak")}</th><th class="num">Invoice</th><th class="num">${t("Terbayar")}</th><th style="min-width:240px">Note</th></tr></thead>
        <tbody>${R.projects.map(p => { const m = S.projects[String(p.id)] || {}, x = tr[p.id] || {}; return `<tr data-pid="${p.id}">
          <td><b>${esc(p.code)}</b><br><span class="muted">${esc(p.name)}</span></td>
          <td><select class="rs-kind" ${ro}><option value="project" ${m.kind !== "saas" ? "selected" : ""}>${t("Client project")}</option>
            <option value="saas" ${m.kind === "saas" ? "selected" : ""}>${t("SaaS product")}</option></select></td>
          <td><input class="rs-client" value="${esc(m.client || "")}" placeholder="${esc(x.client || "")}" ${ro}></td>
          <td><input class="rs-status" value="${esc(m.status || "")}" placeholder="${esc(x.status || "")}" style="width:120px" ${ro}></td>
          <td><select class="rs-risk" ${ro}>${risks.map(r => `<option value="${r}" ${r === (m.risk || "") ? "selected" : ""}>${r || "—"}</option>`).join("")}</select></td>
          <td><input class="rs-contract num" type="number" step="any" value="${num(m.contract_value)}" placeholder="${fmt(p.contract_value || 0)}" ${ro}></td>
          <td><input class="rs-inv num" type="number" step="any" value="${num(m.invoiced)}" placeholder="${m.invoiced == null ? fmt(x.invoiced || 0) : ""}" ${ro}></td>
          <td><input class="rs-paid num" type="number" step="any" value="${num(m.paid)}" placeholder="${m.paid == null ? fmt(x.paid || 0) : ""}" ${ro}></td>
          <td><textarea class="rs-note" rows="2" style="width:100%" ${ro}>${esc(m.note || "")}</textarea></td></tr>`; }).join("")
          || `<tr><td colspan="9" class="empty">${t("Link projects on Model settings & drivers first.")}</td></tr>`}</tbody></table></div></div>

    <div class="card mt pf-edit"><h3>KINERJA SaaS — ${t("month by month")} ${R.year}</h3>
      <p class="muted" style="margin-top:-4px">${t("What the ledger cannot count. Leave MRR blank to use the SaaS projects' booked revenue and budget.")}</p>
      <div class="pf-scroll"><table class="tbl sbu-set"><thead><tr><th>${t("Month")}</th><th class="num">${t("New customers")}</th><th class="num">${t("Churned")}</th>
        <th class="num">MRR Budget</th><th class="num">MRR Aktual</th><th class="num">${t("CAC spend (Rp)")}</th></tr></thead>
        <tbody>${months.map((mk, i) => { const v = S.saas_months[mk] || {}, x = sr[mk] || {}; return `<tr data-m="${mk}">
          <td><b>${esc(t(R.months[i]))}</b> ${R.year}</td>
          <td><input class="rs-new num" type="number" step="1" min="0" value="${num(v.new)}" ${ro}></td>
          <td><input class="rs-churn num" type="number" step="1" min="0" value="${num(v.churned)}" ${ro}></td>
          <td><input class="rs-mb num" type="number" step="any" value="${num(v.mrr_budget)}" placeholder="${v.mrr_budget == null ? fmt(x.mrr_budget || 0) : ""}" ${ro}></td>
          <td><input class="rs-ma num" type="number" step="any" value="${num(v.mrr_actual)}" placeholder="${v.mrr_actual == null && x.mrr_actual != null ? fmt(x.mrr_actual) : ""}" ${ro}></td>
          <td><input class="rs-cac num" type="number" step="any" value="${num(v.cac)}" ${ro}></td></tr>`; }).join("")}</tbody></table></div></div>

    <div class="card mt pf-edit"><h3>INDIKATOR KESEHATAN — ${t("targets and notes")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Percentages in %. ‘Actual’ overrides the computed value (use it for what the ledger cannot measure, such as NRR). A blank note uses the automatic one.")}</p>
      <div class="pf-scroll"><table class="tbl sbu-set"><thead><tr><th>${t("Indikator")}</th><th>${t("Better when")}</th><th class="num">${t("Batas AMAN (🟢)")}</th>
        <th class="num">${t("Batas PERHATIAN (🟡)")}</th><th class="num">${t("Actual (override)")}</th><th style="min-width:260px">${t("Catatan")}</th></tr></thead>
        <tbody>${R.indicators.map(i => { const o = S.indicators[i.key] || {}, isP = i.unit === "pct", sh = v => isP ? pct(v) : num(v); return `<tr data-k="${i.key}" data-pct="${isP ? 1 : 0}">
          <td><b>${esc(t(i.label))}</b><br><span class="muted">${esc(i.unit === "rp" ? "Rp" : i.unit === "pct" ? "%" : i.unit === "x" ? "x" : t(i.unit))}</span></td>
          <td class="muted">${i.direction === "high" ? t("higher") : t("lower")}</td>
          <td><input class="rs-safe num" type="number" step="any" value="${sh(o.safe)}" placeholder="${sh(i.safe)}" ${ro}></td>
          <td><input class="rs-att num" type="number" step="any" value="${sh(o.attention)}" placeholder="${sh(i.attention)}" ${ro}></td>
          <td><input class="rs-act num" type="number" step="any" value="${sh(o.actual)}" placeholder="${i.source === "entered" || i.value == null ? "" : sh(i.value)}" ${ro}></td>
          <td><textarea class="rs-inote" rows="2" style="width:100%" placeholder="${esc(i.auto_note)}" ${ro}>${esc(o.note || "")}</textarea></td></tr>`; }).join("")}</tbody></table></div>
      <h4 class="ex-h4 mt">⚡ ${t("PRIORITAS TINDAKAN DIREKSI")}</h4>
      <table class="tbl sbu-set"><tbody id="rsActs">${S.actions.map(a => sbuActRow(a, R, ro)).join("")}</tbody></table>
      ${canWrite() ? `<button class="btn btn-sm mt" id="rsAddAct">+ ${t("Add an action")}</button>` : ""}</div>

    <div class="card mt pf-edit"><h3>P&L YTD — ${t("which accounts make each line")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Account code prefixes, comma separated; the longest match wins, so 5 on Others Cost only takes what no other HPP line claimed. Type - to leave a line empty. Anything left over lands on Other Operating Expense, so the P&L always adds up to the ledger.")}</p>
      <div class="pf-scroll"><table class="tbl sbu-set"><thead><tr><th>${t("Section")}</th><th>${t("Line label")}</th><th>${t("Account codes")}</th><th>${t("Accounts found this year")}</th></tr></thead>
        <tbody>${R.pnl.lines.map(l => { const o = S.lines[l.key] || {}; return `<tr data-k="${l.key}">
          <td class="muted">${esc({ revenue: t("Revenue"), cogs: "HPP", opex: "OPEX", da: "D&A" }[l.section])}${l.group ? ` · ${l.group === "saas" ? "SaaS" : t("Project")}` : ""}</td>
          <td><input class="rs-llabel" value="${esc(o.label || "")}" placeholder="${esc(l.default_label)}" ${ro}></td>
          <td><input class="rs-lcodes" value="${esc(o.codes ? o.codes.join(", ") : "")}" placeholder="${esc(l.default_codes.join(", ") || "—")}" ${l.section === "revenue" ? "disabled" : ro}></td>
          <td class="muted" style="font-size:11.5px">${esc(l.accounts.map(a => a.join(" ")).join(" · "))}</td></tr>`; }).join("")}</tbody></table></div></div>

    ${canWrite() ? `<div class="form-actions"><button class="btn btn-primary" id="rsSave">${t("Save report settings")}</button></div>` : ""}`;

  const bindDel = () => $$("#rsActs .rs-adel").forEach(b => b.onclick = () => b.closest("tr").remove());
  bindDel();
  if ($("#rsAddAct")) $("#rsAddAct").onclick = () => { $("#rsActs").insertAdjacentHTML("beforeend", sbuActRow({ urgency: "now", text: "" }, R, ro)); bindDel(); };
  if ($("#rsSave")) $("#rsSave").onclick = async () => {
    const f = v => v === "" || v == null ? null : parseFloat(v);
    const payload = {
      title: $("#rsTitle").value, subtitle: $("#rsSub").value, through: $("#rsThrough").value,
      opening_cash: f($("#rsOpen").value) || 0, headcount: f($("#rsHead").value) || 0,
      tax_rate: (f($("#rsTax").value) ?? 22) / 100, ltv_churn: (f($("#rsLtv").value) ?? 5) / 100,
      opening_customers: f($("#rsCust0").value) || 0,
      projects: Object.fromEntries($$("#pfBody tr[data-pid]").map(tr => [tr.dataset.pid, {
        kind: $(".rs-kind", tr).value, client: $(".rs-client", tr).value, status: $(".rs-status", tr).value,
        risk: $(".rs-risk", tr).value, note: $(".rs-note", tr).value,
        contract_value: f($(".rs-contract", tr).value), invoiced: f($(".rs-inv", tr).value), paid: f($(".rs-paid", tr).value) }])),
      saas_months: Object.fromEntries($$("#pfBody tr[data-m]").map(tr => [tr.dataset.m, {
        new: f($(".rs-new", tr).value), churned: f($(".rs-churn", tr).value), mrr_budget: f($(".rs-mb", tr).value),
        mrr_actual: f($(".rs-ma", tr).value), cac: f($(".rs-cac", tr).value) }])),
      indicators: Object.fromEntries($$("#pfBody tr[data-k][data-pct]").map(tr => {
        const k = tr.dataset.pct === "1" ? 100 : 1, g = s => { const v = f($(s, tr).value); return v == null ? null : v / k; };
        return [tr.dataset.k, { safe: g(".rs-safe"), attention: g(".rs-att"), actual: g(".rs-act"), note: $(".rs-inote", tr).value }]; })),
      actions: $$("#rsActs tr").map(tr => ({ urgency: $(".rs-aurg", tr).value, text: $(".rs-atext", tr).value })),
      lines: Object.fromEntries($$("#pfBody tr[data-k]:not([data-pct])").map(tr => {
        const o = { label: $(".rs-llabel", tr).value };
        const c = $(".rs-lcodes", tr);
        if (!c.disabled && c.value.trim()) o.codes = c.value;
        return [tr.dataset.k, o]; })),
    };
    try {
      await api(`/api/products/${pid}/report`, { method: "PUT", json: payload });
      toast(t("Report settings saved"));
      state.pfTab = "dash"; reload();
    } catch (e) { toast(e.message, true); }
  };
}
function sbuActRow(a, R, ro) {
  return `<tr><td style="width:170px"><select class="rs-aurg" ${ro}>${R.urgencies.map(u => `<option value="${u.key}" ${u.key === a.urgency ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></td>
    <td><textarea class="rs-atext" rows="2" style="width:100%" ${ro}>${esc(a.text || "")}</textarea></td>
    <td style="width:40px">${ro ? "" : `<button class="btn btn-sm btn-ghost rs-adel">&times;</button>`}</td></tr>`;
}

/* ---- overview -------------------------------------------------------------- */
function pfOverview(body, a) {
  const s = a.summary, ty = s.target_month.slice(0, 4), yrs = Object.keys(s.years).sort();
  const cur = String(new Date().getFullYear());
  const yc = s.years[cur] || s.years[yrs[0]] || {};
  const yt = s.years[ty] || {};
  const tr = s.target_row || {};
  const boundary = a.months.findIndex(m => m.phase === "forecast");

  body.innerHTML = `
    <div class="card">
      <div class="pf-verdict">
        <span class="pill ${PF_VERDICT_CLS[s.verdict]}" style="font-size:14px">${esc(t(PF_VERDICT_LABEL[s.verdict]))}</span>
        <span class="muted">${esc(t(s.verdict_text))} · ${t("target")} <b>${pfMonth(s.target_month)}</b></span>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">${t("Actual through")} <b>${pfMonth(s.actual_through)}</b>
        (${esc(t({ ledger: "from the ledger", stated: "set by hand", calendar: "no ledger — all plan" }[s.actual_through_source] || ""))}),
        ${t("forecast after that")}.</p>
    </div>

    <div class="pf-kpis mt">
      ${pfTile(`${cur} ${t("cost")}`, pfRp(yc.opex), `${yc.actual_months || 0} ${t("actual")} · ${yc.forecast_months || 0} ${t("forecast months")}`)}
      ${pfTile(`${ty} ${t("profit / (loss)")}`, pfRp(yt.profit), yt.margin == null ? "" : `${t("margin")} ${pfPct(yt.margin)}`, (yt.profit || 0) < 0 ? "bad" : "good")}
      ${pfTile(t("Break-even month"), pfMonth(s.break_even_month), s.first_profitable_month ? `${t("first profitable month")} ${pfMonth(s.first_profitable_month)}` : t("no profitable month in the horizon"))}
      ${pfTile(t("Cash payback"), s.payback_month ? pfMonth(s.payback_month) : t("not in horizon"), t("when every rupiah spent is back"))}
      ${pfTile(t("Funding required"), pfRp(s.funding_required), s.funding_trough_month ? `${t("deepest point")} ${pfMonth(s.funding_trough_month)}` : t("never below zero"), s.funding_required ? "warn" : "")}
      ${pfTile(t("Burn budget · runway"), s.burn_budget ? pfRp(s.budget_remaining) : t("not set"),
        s.burn_budget ? (s.runway_months != null ? `${s.runway_months} ${t("months at")} ${pfRp(s.avg_net_burn)}/${t("mo")}` : t("no net burn right now"))
                      : t("set it on Settings to measure runway"),
        s.within_burn_budget === false ? "bad" : "")}
      ${pfTile(`${t("ARR in")} ${pfMonth(s.target_month)}`, pfRp(tr.arr), `${pfN(tr.users_end)} ${t("active users")}`)}
    </div>

    <div class="card mt"><h3>${t("Revenue and cost by month, with the cumulative cash position")}</h3>
      ${chartBars(a.months.map((m, i) => (i === boundary ? "▸" : "") + (m.month.endsWith("-01") || i === 0 ? pfMonth(m.month) : "")), [
        { name: t("Revenue"), color: "#059669", values: a.months.map(m => m.revenue) },
        { name: t("Cost (opex)"), color: "#bd362f", values: a.months.map(m => -m.opex) },
        { name: t("Cumulative cash"), color: "#c87a08", values: a.months.map(m => m.cum_cash), type: "line" },
      ], { height: 290 })}
      <p class="muted" style="font-size:12px">${boundary > 0 ? `${t("The ▸ marks the first forecast month")} (${pfMonth(a.months[boundary].month)}). ` : ""}${t("Cash includes CAPEX when it is paid; profit instead spreads it as depreciation.")}</p>
    </div>

    <div class="card mt"><h3>${t("Year by year")}</h3><div class="pf-scroll"><table class="tbl">
      <thead><tr><th>${t("Year")}</th><th class="num">${t("Revenue")}</th><th class="num">${t("Opex")}</th>
        <th class="num">${t("Depreciation")}</th><th class="num">CAPEX</th><th class="num">${t("Profit / (loss)")}</th>
        <th class="num">${t("Margin")}</th><th class="num">${t("Net cash")}</th><th>${t("Basis")}</th></tr></thead>
      <tbody>${yrs.map(y => { const r = s.years[y]; return `<tr>
        <td><b>${y}</b></td><td class="num">${fmt(r.revenue)}</td><td class="num">${fmt(r.opex)}</td>
        <td class="num muted">${fmt(r.depreciation)}</td><td class="num muted">${fmt(r.capex)}</td>
        <td class="num ${r.profit < 0 ? "neg" : "pos"}">${fmt(r.profit)}</td><td class="num">${pfPct(r.margin)}</td>
        <td class="num ${r.net_cash < 0 ? "neg" : "pos"}">${fmt(r.net_cash)}</td>
        <td class="muted">${r.actual_months} ${t("actual")} + ${r.forecast_months} ${t("forecast")}</td></tr>`; }).join("")}</tbody></table></div></div>

    <div class="card mt" id="sbuCost"></div>

    ${a.warnings.length ? `<div class="card mt"><h3>${t("Assumptions & warnings")}</h3>
      <ul class="muted" style="margin:0 0 0 18px;line-height:1.7;font-size:12.5px">${a.warnings.map(w => `<li>${esc(fmtDatesIn(w))}</li>`).join("")}</ul></div>` : ""}`;
  pfCostCard(a);
}

// Cost breakdown, drawn the way the dashboard draws operating expense: a donut,
// its legend with amounts, and a realization box underneath. "By category"
// covers the whole year (actual + forecast); "By account" is only what has
// really been booked in the ledger.
function pfCostCard(a) {
  const box = $("#sbuCost");
  if (!box) return;
  const years = Object.keys(a.summary.years).sort();
  const cur = String(new Date().getFullYear());
  if (!state.sbuCostYear || !years.includes(state.sbuCostYear))
    state.sbuCostYear = years.includes(cur) ? cur : years[years.length - 1];
  if (!state.sbuCostMode) state.sbuCostMode = "category";
  const y = a.summary.years[state.sbuCostYear] || {};
  const share = (v, tot) => tot ? ` · ${(100 * v / tot).toFixed(1).replace(".", ",")}%` : "";
  let items = [];
  if (state.sbuCostMode === "account") {
    const accts = y.actual_accounts || [], tot = y.actual_opex || 0;
    const top = accts.slice(0, 7), rest = accts.slice(7).reduce((sum, x) => sum + x.amount, 0);
    items = top.map((x, i) => ({ label: `${x.code} ${x.name}${share(x.amount, tot)}`, value: x.amount, color: SBU_GRADES[i] }));
    if (rest > 0) items.push({ label: `${t("Other accounts")}${share(rest, tot)}`, value: rest, color: SBU_GRADES[7] });
  } else {
    const tot = y.opex || 0;
    items = a.categories.map(c => ({ label: `${t(c.label)}${share((y.costs || {})[c.key] || 0, tot)}`,
                                      value: (y.costs || {})[c.key] || 0, color: PF_CAT_COLOR[c.key] }))
      .filter(x => x.value > 0).sort((p, q) => q.value - p.value);
  }
  const realized = y.actual_opex || 0, plan = y.opex || 0;
  box.innerHTML = `
    <div class="page-head" style="margin-bottom:10px"><h3 style="margin:0">${t("Cost Breakdown — Realization vs Plan")}
      <span class="muted" style="font-weight:500;font-size:13px">· ${esc(a.product.name)} · ${state.sbuCostYear}</span></h3>
      <div class="page-actions">
        <div class="seg-group" id="sbuMode">
          <button class="seg ${state.sbuCostMode === "category" ? "active" : ""}" data-m="category">${t("By category · full year")}</button>
          <button class="seg ${state.sbuCostMode === "account" ? "active" : ""}" data-m="account">${t("By account · realized")}</button>
        </div>
        <div class="seg-group" id="sbuYear">${years.map(yy =>
          `<button class="seg ${yy === state.sbuCostYear ? "active" : ""}" data-y="${yy}">${yy}</button>`).join("")}</div>
      </div></div>
    ${items.length ? chartDonut(items) : `<div class="empty">${state.sbuCostMode === "account"
      ? t("Nothing is booked in the ledger for this year yet — every month is forecast. Switch to ‘By category’ to see the plan.")
      : t("No cost is planned for this year.")}</div>`}
    <div class="sbu-real">
      <span><b>${t("Operating cost")}</b> <span class="muted">(${y.actual_months || 0} ${t("actual")} + ${y.forecast_months || 0} ${t("forecast months")})</span></span>
      <span>${t("Realization")} <b>${fmtRp(realized)}</b> · ${t("Plan")} <b>${fmtRp(plan)}</b> · ${plan ? Math.round(100 * realized / plan) + "% " + t("realized") : "—"}</span>
    </div>
    ${y.depreciation ? `<p class="muted" style="font-size:12px;margin:8px 0 0">${t("Depreciation")} ${fmtRp(y.depreciation)} ${t("is non-cash and sits outside the donut.")}</p>` : ""}`;
  $$("#sbuMode .seg").forEach(b => b.onclick = () => { state.sbuCostMode = b.dataset.m; pfCostCard(a); });
  $$("#sbuYear .seg").forEach(b => b.onclick = () => { state.sbuCostYear = b.dataset.y; pfCostCard(a); });
}

/* ---- P&L by month ---------------------------------------------------------- */
function pfMonthTable(a, rows) {
  const head = `<tr><th class="pf-lbl"></th>${a.months.map(m =>
    `<th class="num ${m.phase === "actual" ? "pf-act" : ""}">${pfMonth(m.month)}<br><span class="pf-phase">${esc(t(m.phase))}</span></th>`).join("")}</tr>`;
  const body = rows.map(r => `<tr class="${r.cls || ""}"><td class="pf-lbl">${r.label}</td>${a.months.map(m => {
    const v = r.get(m);
    return `<td class="num ${m.phase === "actual" ? "pf-act" : ""} ${r.neg && v < 0 ? "neg" : ""}">${r.fmt ? r.fmt(v) : pfN(v)}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="pf-scroll"><table class="tbl pf-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function pfPnl(body, a) {
  const rows = [
    { label: t("Active users"), get: m => m.users_end },
    { label: `<b>${t("Revenue")}</b>`, get: m => m.revenue, cls: "pf-sub" },
    ...a.categories.map(c => ({ label: `&nbsp;&nbsp;${esc(t(c.label))}`, get: m => m.costs[c.key] })),
    { label: `<b>${t("Opex")}</b>`, get: m => m.opex, cls: "pf-sub" },
    { label: t("Depreciation (non-cash)"), get: m => m.depreciation },
    { label: `<b>${t("Profit / (loss)")}</b>`, get: m => m.profit, cls: "pf-sub", neg: true },
    { label: t("Cumulative profit"), get: m => m.cum_profit, neg: true },
    { label: "CAPEX (" + t("cash") + ")", get: m => m.capex },
    { label: `<b>${t("Net cash")}</b>`, get: m => m.net_cash, cls: "pf-sub", neg: true },
    { label: `<b>${t("Cumulative cash")}</b>`, get: m => m.cum_cash, neg: true },
  ];
  body.innerHTML = `<div class="card"><h3>${t("Profit & loss, month by month")}</h3>
    <p class="muted" style="margin-top:-4px">${t("Shaded columns are actual — posted ledger lines on the linked projects. The rest is forecast from the drivers.")}</p>
    ${pfMonthTable(a, rows)}</div>`;
}

/* ---- SaaS metrics ---------------------------------------------------------- */
function pfSaas(body, a) {
  const s = a.summary, tr = s.target_row || {};
  const churn = parseFloat(a.assumptions.churn_monthly) || 0;
  const fc = a.months.filter(m => m.phase === "forecast");
  body.innerHTML = `
    <div class="pf-kpis">
      ${pfTile(`MRR ${pfMonth(s.target_month)}`, pfRp(tr.mrr), `ARR ${pfRp(tr.arr)}`)}
      ${pfTile(t("Active users"), pfN(tr.users_end), `+${pfN(tr.users_new)} ${t("new")} · −${pfN(tr.users_churned)} ${t("churned")}`)}
      ${pfTile(t("Churn"), pfPct(churn), `${pfPct(1 - Math.pow(1 - churn, 12))} ${t("a year")}`, churn > 0.05 ? "bad" : "")}
      ${pfTile("ARPU", pfRp(tr.arpu), t("per active user per month"))}
      ${pfTile("CAC", pfRp(tr.cac), t("marketing spend ÷ new users"))}
      ${pfTile("LTV", pfRp(tr.ltv), t("ARPU × gross margin ÷ churn"))}
      ${pfTile("LTV : CAC", tr.ltv_cac == null ? "—" : tr.ltv_cac + "×", t("3× or better is healthy"), tr.ltv_cac != null && tr.ltv_cac < 3 ? "warn" : "")}
      ${pfTile(t("CAC payback"), tr.cac_payback_months == null ? "—" : tr.cac_payback_months + " " + t("mo"), t("months of gross margin to earn back one user"))}
      ${pfTile(t("Gross margin"), pfPct(tr.gross_margin), t("after server & infrastructure"))}
      ${pfTile(t("Net burn"), pfRp(s.avg_net_burn), t("average of the last three months, per month"), s.avg_net_burn > 0 ? "warn" : "")}
      ${pfTile(t("Runway"), s.runway_months == null ? (s.burn_budget ? t("no net burn") : t("no budget set")) : s.runway_months + " " + t("mo"), s.burn_budget ? `${t("of")} ${pfRp(s.burn_budget)} ${t("budget")}` : "")}
      ${pfTile(t("Funding required"), pfRp(s.funding_required), t("the deepest the cumulative cash goes"))}
    </div>
    <div class="pf-two mt">
      <div class="card"><h3>${t("Recurring revenue")}</h3>
        ${chartBars(fc.map((m, i) => (i % 3 === 0 ? pfMonth(m.month) : "")), [
          { name: "MRR", color: "#059669", values: fc.map(m => m.mrr) },
          { name: t("Cost"), color: "#bd362f", values: fc.map(m => m.opex), type: "line" },
        ], { height: 230 })}</div>
      <div class="card"><h3>${t("Users")}</h3>
        ${chartBars(fc.map((m, i) => (i % 3 === 0 ? pfMonth(m.month) : "")), [
          { name: t("New"), color: "#34d399", values: fc.map(m => m.users_new) },
          { name: t("Churned"), color: "#bd362f", values: fc.map(m => -m.users_churned) },
          { name: t("Active"), color: "#047857", values: fc.map(m => m.users_end), type: "line" },
        ], { height: 230, valueFmt: v => fmt(v) })}</div>
    </div>
    <div class="card mt"><h3>${t("SaaS metrics by month")}</h3>
      ${pfMonthTable(a, [
        { label: t("New users"), get: m => m.users_new },
        { label: t("Churned users"), get: m => m.users_churned },
        { label: `<b>${t("Active users")}</b>`, get: m => m.users_end, cls: "pf-sub" },
        { label: "ARPU", get: m => m.arpu },
        { label: "MRR", get: m => m.mrr },
        { label: "ARR", get: m => m.arr },
        { label: "CAC", get: m => m.cac },
        { label: "LTV", get: m => m.ltv },
        { label: "LTV : CAC", get: m => m.ltv_cac, fmt: v => v == null ? "—" : v + "×" },
        { label: t("CAC payback (mo)"), get: m => m.cac_payback_months, fmt: v => v == null ? "—" : v },
        { label: t("Gross margin"), get: m => m.gross_margin, fmt: v => pfPct(v) },
        { label: t("Gross burn"), get: m => m.gross_burn },
        { label: `<b>${t("Net burn")}</b>`, get: m => m.net_burn, cls: "pf-sub" },
      ])}
      <p class="muted mt" style="font-size:12px">${t("User counts are a model in every month, including actual ones — the ledger records money, not logins. CAC, LTV and payback are blank where they would divide by zero.")}</p>
    </div>`;
}

/* ---- server cost ----------------------------------------------------------- */
function pfServer(body, a) {
  const sv = a.server;
  const costAt = u => sv.base + sv.per_user * u + (sv.step_users > 0 ? sv.step_cost * Math.floor(u / sv.step_users) : 0);
  const fc = sv.rows.filter(r => r.phase === "forecast");
  const last = fc[fc.length - 1] || {};
  body.innerHTML = `
    <div class="pf-kpis">
      ${pfTile(t("Base infrastructure"), pfRp(sv.base), t("per month, whether anyone logs in or not"))}
      ${pfTile(t("Per active user"), pfRp(sv.per_user), t("variable cost per month"))}
      ${pfTile(t("Capacity step"), sv.step_users ? `+${pfRp(sv.step_cost)}` : "—", sv.step_users ? `${t("every")} ${fmt(sv.step_users)} ${t("users")}` : t("no tiers set"))}
      ${pfTile(t("Cost of the next 1,000 users"), pfRp(sv.marginal_per_1000_users), t("per month"))}
      ${pfTile(`${t("Server cost")} ${pfMonth(last.month)}`, pfRp(last.server_cost), last.share_of_revenue == null ? "" : `${pfPct(last.share_of_revenue)} ${t("of revenue")}`)}
      ${pfTile(t("Cost per user"), pfRp(last.per_user), `${t("at")} ${pfN(last.users)} ${t("users")}`)}
    </div>
    <div class="pf-two mt">
      <div class="card"><h3>${t("Server cost as users grow, month by month")}</h3>
        ${chartBars(sv.rows.map((r, i) => (i % 3 === 0 ? pfMonth(r.month) : "")), [
          { name: t("Server cost"), color: "#059669", values: sv.rows.map(r => r.server_cost) },
        ], { height: 230 })}
        <p class="muted" style="font-size:12px">${t("Actual months show what the server & API accounts cost in the ledger; forecast months use the model on the right.")}</p></div>
      <div class="card"><h3>${t("The cost curve")}</h3>
        <table class="tbl"><thead><tr><th class="num">${t("Active users")}</th><th class="num">${t("Server cost / month")}</th><th class="num">${t("Per user")}</th></tr></thead>
          <tbody>${sv.curve.map(c => `<tr><td class="num">${fmt(c.users)}</td><td class="num">${fmt(c.server_cost)}</td><td class="num muted">${c.per_user == null ? "—" : fmt(c.per_user)}</td></tr>`).join("")}</tbody></table>
        <div class="filters mt" style="align-items:center">
          <label>${t("What if we had")} <input type="number" id="svWhat" min="0" value="${Math.round((last.users || 100) * 2)}" style="width:120px"></label>
          <span id="svWhatOut" class="muted"></span></div></div>
    </div>
    ${sv.thresholds.length ? `<div class="card mt"><h3>${t("Where the next capacity tier kicks in")}</h3>
      <table class="tbl"><thead><tr><th class="num">${t("At")}</th><th class="num">${t("Adds per month")}</th><th class="num">${t("Total server cost after")}</th></tr></thead>
      <tbody>${sv.thresholds.map(x => `<tr><td class="num">${fmt(x.users)} ${t("users")}</td><td class="num">+${fmt(x.adds_monthly)}</td><td class="num">${fmt(x.cost_after)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="card mt"><h3>${t("Server cost by month")}</h3><div class="pf-scroll"><table class="tbl pf-grid">
      <thead><tr><th class="pf-lbl"></th>${sv.rows.map(r => `<th class="num ${r.phase === "actual" ? "pf-act" : ""}">${pfMonth(r.month)}</th>`).join("")}</tr></thead>
      <tbody>
        <tr><td class="pf-lbl">${t("Active users")}</td>${sv.rows.map(r => `<td class="num ${r.phase === "actual" ? "pf-act" : ""}">${pfN(r.users)}</td>`).join("")}</tr>
        <tr class="pf-sub"><td class="pf-lbl">${t("Server cost")}</td>${sv.rows.map(r => `<td class="num ${r.phase === "actual" ? "pf-act" : ""}">${pfN(r.server_cost)}</td>`).join("")}</tr>
        <tr><td class="pf-lbl">${t("Per user")}</td>${sv.rows.map(r => `<td class="num ${r.phase === "actual" ? "pf-act" : ""}">${pfN(r.per_user)}</td>`).join("")}</tr>
        <tr><td class="pf-lbl">${t("Share of revenue")}</td>${sv.rows.map(r => `<td class="num ${r.phase === "actual" ? "pf-act" : ""}">${pfPct(r.share_of_revenue)}</td>`).join("")}</tr>
      </tbody></table></div></div>`;
  const what = () => {
    const u = Math.max(0, parseFloat($("#svWhat").value) || 0), c = costAt(u);
    $("#svWhatOut").innerHTML = `→ <b>${fmtRp(c)}</b> ${t("a month")}${u ? ` · ${fmtRp(c / u)} ${t("per user")}` : ""}`;
  };
  $("#svWhat").oninput = what; what();
}

/* ---- target & marketing ---------------------------------------------------- */
function pfTarget(body, a) {
  const tg = a.targets, s = a.summary;
  body.innerHTML = `
    <div class="card"><h3>${t("What marketing has to deliver for the SBU to be profitable by")} ${pfMonth(tg.target_month)}</h3>
      <p class="muted" style="margin-top:-4px">${t("Profitable means the target month's revenue covers that month's full cost, depreciation included. Paid back means the cash spent getting there has come back too.")}</p>
      ${tg.required_active_users == null ? `<p class="neg">${(tg.notes || []).map(esc).join(" ")}</p>` : `
      <div class="pf-kpis mt">
        ${pfTile(t("Active users needed"), fmt(tg.required_active_users), `${t("the plan reaches")} ${pfN(tg.planned_active_users)}`, tg.active_user_gap > 0 ? "bad" : "good")}
        ${pfTile(t("Gap to close"), tg.active_user_gap > 0 ? `+${fmt(Math.ceil(tg.active_user_gap))}` : t("none"), t("active users"), tg.active_user_gap > 0 ? "bad" : "good")}
        ${pfTile(t("New users per month"), tg.required_new_users_per_month == null ? "—" : fmt(tg.required_new_users_per_month), `${t("constant, for")} ${tg.months_to_target} ${t("months, after churn")}`)}
        ${pfTile(t("CAC ceiling"), pfRp(tg.cac_ceiling), `${t("at")} ${pfRp(tg.avg_forecast_marketing)}/${t("mo marketing")}`)}
        ${pfTile(t("Acquisition growth for payback"), tg.required_growth_for_payback == null ? t("not reachable") : pfPct(tg.required_growth_for_payback), t("month-on-month growth in new users"), tg.required_growth_for_payback == null ? "bad" : "")}
        ${pfTile(t("Unit margin per user"), pfRp(tg.unit_margin_per_user), t("ARPU less the server cost that user drives"))}
      </div>`}
    </div>
    ${tg.ladder ? `<div class="card mt"><h3>${t("Growth ladder")} — ${t("where each acquisition growth rate lands by")} ${pfMonth(tg.target_month)}</h3>
      <table class="tbl"><thead><tr><th class="num">${t("New-user growth / mo")}</th><th class="num">${t("Active users")}</th><th class="num">MRR</th>
        <th class="num">${t("Month profit")}</th><th class="num">${t("Cumulative cash")}</th><th>${t("Profitable?")}</th><th>${t("Paid back?")}</th></tr></thead>
      <tbody>${tg.ladder.map(r => `<tr>
        <td class="num"><b>${pfPct(r.growth, 0)}</b></td><td class="num">${fmt(r.users_end)}</td><td class="num">${fmt(r.mrr)}</td>
        <td class="num ${r.profit < 0 ? "neg" : "pos"}">${fmt(r.profit)}</td><td class="num ${r.cum_cash < 0 ? "neg" : "pos"}">${fmt(r.cum_cash)}</td>
        <td><span class="pill ${r.profitable ? "posted" : "bad"}">${r.profitable ? t("YES") : t("no")}</span></td>
        <td><span class="pill ${r.paid_back ? "posted" : "bad"}">${r.paid_back ? t("YES") : t("no")}</span></td></tr>`).join("")}</tbody></table>
      <p class="muted mt" style="font-size:12px">${t("Every other driver is held at plan. This is the same test as tab 07 of the workbook, run on users instead of a revenue growth rate.")}</p></div>` : ""}
    ${(tg.notes || []).length && tg.required_active_users != null ? `<div class="card mt"><ul class="muted" style="margin:0 0 0 18px">${tg.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    <div class="card mt"><h3>${t("Burn")}</h3>
      <table class="tbl"><tbody>
        <tr><td>${t("Funding required — the deepest point of cumulative cash")}</td><td class="num"><b>${fmtRp(s.funding_required)}</b></td><td class="muted">${pfMonth(s.funding_trough_month)}</td></tr>
        <tr><td>${t("Burnt so far")}</td><td class="num">${fmtRp(s.burnt_so_far)}</td><td class="muted">${t("through")} ${pfMonth(s.actual_through)}</td></tr>
        <tr><td>${t("Burn budget")}</td><td class="num">${s.burn_budget ? fmtRp(s.burn_budget) : "—"}</td>
          <td>${s.within_burn_budget == null ? `<span class="muted">${t("not set")}</span>` : `<span class="pill ${s.within_burn_budget ? "posted" : "bad"}">${s.within_burn_budget ? t("ENOUGH") : t("NOT ENOUGH")}</span>`}</td></tr>
        <tr><td>${t("Runway at the current net burn")}</td><td class="num">${s.runway_months == null ? "—" : s.runway_months + " " + t("months")}</td><td class="muted">${pfRp(s.avg_net_burn)}/${t("mo")}</td></tr>
      </tbody></table>
      <p class="muted mt" style="font-size:12px">${t("Set the burn budget to what the company is prepared to lose on this product before it pays for itself. If the funding required is larger, the plan runs out of money before it works.")}</p></div>`;
}

/* ---- settings & drivers ---------------------------------------------------- */
async function pfSettings(body, pid, reload) {
  let d;
  try { d = await api(`/api/products/${pid}`); }
  catch (e) { body.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; return; }
  const A = d.assumptions, ro = canWrite() ? "" : "disabled";
  const pct = v => v == null || v === "" ? "" : +(parseFloat(v) * 100).toFixed(4);
  const catOpts = sel => d.categories.map(c => `<option value="${c.key}" ${c.key === sel ? "selected" : ""}>${esc(t(c.label))}</option>`).join("");
  const groups = {};
  d.projects.forEach(p => (groups[p.company_code] = groups[p.company_code] || []).push(p));

  const lineRow = l => `<tr>
    <td><input class="pl-label" value="${esc(l.label || "")}" ${ro}></td>
    <td><select class="pl-cat" ${ro}>${catOpts(l.category)}</select></td>
    <td><input class="pl-amt num" type="number" step="any" value="${l.monthly_amount || 0}" ${ro}></td>
    <td><select class="pl-basis" ${ro}><option value="fixed" ${l.basis !== "per_working_day" ? "selected" : ""}>${t("per month")}</option>
      <option value="per_working_day" ${l.basis === "per_working_day" ? "selected" : ""}>${t("per working day")}</option></select></td>
    <td><input class="pl-start" type="month" value="${esc(l.start_month || "")}" ${ro}></td>
    <td><input class="pl-end" type="month" value="${esc(l.end_month || "")}" ${ro}></td>
    <td><input class="pl-esc num" type="number" step="any" value="${pct(l.escalation_annual) || 0}" ${ro}></td>
    <td>${canWrite() ? `<button class="btn btn-sm btn-ghost pl-del">&times;</button>` : ""}</td></tr>`;
  const oneRow = o => `<tr>
    <td><input class="po-month" type="month" value="${esc(o.month || "")}" ${ro}></td>
    <td><select class="po-flow" ${ro}><option value="in" ${o.flow === "in" ? "selected" : ""}>${t("money in")}</option><option value="out" ${o.flow !== "in" ? "selected" : ""}>${t("money out")}</option></select></td>
    <td><input class="po-label" value="${esc(o.label || "")}" ${ro}></td>
    <td><input class="po-amt num" type="number" step="any" value="${o.amount || 0}" ${ro}></td>
    <td>${canWrite() ? `<button class="btn btn-sm btn-ghost pl-del">&times;</button>` : ""}</td></tr>`;
  const capRow = c => `<tr>
    <td><input class="pc-month" type="month" value="${esc(c.month || "")}" ${ro}></td>
    <td><input class="pc-label" value="${esc(c.label || "")}" ${ro}></td>
    <td><input class="pc-amt num" type="number" step="any" value="${c.amount || 0}" ${ro}></td>
    <td><input class="pc-life num" type="number" min="1" value="${c.life_months || 48}" ${ro}></td>
    <td>${canWrite() ? `<button class="btn btn-sm btn-ghost pl-del">&times;</button>` : ""}</td></tr>`;

  body.innerHTML = `
    <div class="card pf-edit"><h3>${t("The SBU")}</h3>
      ${canWrite() ? entImageField("product", pid, d.image_v, d.name) : ""}
      <div class="form-grid">
        <label>${t("Name")} <input id="psName" value="${esc(d.name)}" ${ro}></label>
        <label>${t("Code")} <input id="psCode" value="${esc(d.code)}" ${ro}></label>
        <label>${t("Company")} <select id="psCo" ${ro}>${companyOptions(d.company_id)}</select></label>
        <label>${t("Stage")} <select id="psStage" ${ro}>${d.stages.map(x => `<option value="${x}" ${x === d.stage ? "selected" : ""}>${esc(t(x))}</option>`).join("")}</select></label>
        <label>${t("Launch month")} <input type="month" id="psLaunch" value="${esc(d.launch_month || "")}" ${ro}></label>
        <label>${t("Must be profitable by (year)")} <input type="number" id="psYear" value="${d.target_year || ""}" ${ro}></label>
        <label>${t("Actual through")} <input type="month" id="psThrough" value="${esc(d.actual_through || "")}" ${ro}>
          <span class="muted" style="font-weight:400">${t("blank = the last month the ledger has")}</span></label>
        <label>${t("Model until")} <input type="month" id="psHorizon" value="${esc(d.horizon_end || "")}" ${ro}>
          <span class="muted" style="font-weight:400">${t("blank = December of the target year")}</span></label>
        <label>${t("Burn budget (Rp)")} <input type="number" id="psBudget" step="any" value="${d.burn_budget || 0}" ${ro}>
          <span class="muted" style="font-weight:400">${t("what the company is prepared to lose before it pays back")}</span></label>
        <label class="full">${t("Notes")} <input id="psNotes" value="${esc(d.notes || "")}" ${ro}></label>
      </div></div>

    <div class="card mt"><h3>${t("Ledger projects this SBU spends from")}</h3>
      <p class="muted" style="margin-top:-4px">${t("Actual months come from posted journal lines tagged to these projects — in whichever company's books they were booked.")}</p>
      ${Object.keys(groups).map(co => `<div style="margin:8px 0"><b>${esc(co)}</b><div class="chk-grid">${groups[co].map(p =>
        `<label class="chk"><input type="checkbox" class="ps-prj" value="${p.id}" ${d.project_ids.includes(p.id) ? "checked" : ""} ${ro}> ${esc(p.code)} — ${esc(p.name)}</label>`).join("")}</div></div>`).join("") || `<p class="muted">${t("No projects in the companies you can see.")}</p>`}
    </div>

    <div class="pf-two mt">
      <div class="card pf-edit"><h3>${t("Revenue & users")}</h3><div class="form-grid">
        <label>${t("Price per active user / month (ARPU)")} <input type="number" step="any" id="paArpu" value="${A.arpu || 0}" ${ro}></label>
        <label>${t("Price rise per year (%)")} <input type="number" step="any" id="paArpuG" value="${pct(A.arpu_growth_annual) || 0}" ${ro}></label>
        <label>${t("Subscription revenue starts")} <input type="month" id="paRevStart" value="${esc(A.revenue_start_month || "")}" ${ro}></label>
        <label>${t("Users already on board then")} <input type="number" step="any" id="paStartU" value="${A.start_users || 0}" ${ro}></label>
        <label>${t("New users in the first month")} <input type="number" step="any" id="paNew" value="${A.new_users_first || 0}" ${ro}></label>
        <label>${t("Growth in new users / month (%)")} <input type="number" step="any" id="paNewG" value="${pct(A.new_users_growth) || 0}" ${ro}></label>
        <label>${t("Churn / month (%)")} <input type="number" step="any" id="paChurn" value="${pct(A.churn_monthly) || 0}" ${ro}></label>
      </div></div>
      <div class="card pf-edit"><h3>${t("Server & infrastructure")}</h3><div class="form-grid">
        <label>${t("Base cost / month")} <input type="number" step="any" id="paSvBase" value="${A.server_base || 0}" ${ro}></label>
        <label>${t("Cost per active user / month")} <input type="number" step="any" id="paSvUser" value="${A.server_per_user || 0}" ${ro}></label>
        <label>${t("Add a capacity tier every N users")} <input type="number" step="1" id="paSvStepU" value="${A.server_step_users || 0}" ${ro}></label>
        <label>${t("Each tier costs / month")} <input type="number" step="any" id="paSvStepC" value="${A.server_step_cost || 0}" ${ro}></label>
      </div>
      <p class="muted" style="font-size:12px">${t("In actual months the server figure is whatever the ledger's server & API accounts (5100-02) cost. The model takes over from the first forecast month.")}</p></div>
    </div>

    <div class="card mt pf-edit"><h3>${t("Cost lines (forecast)")}</h3>
      <div class="pf-scroll"><table class="tbl"><thead><tr><th>${t("Line")}</th><th>${t("Category")}</th><th class="num">${t("Amount")}</th>
        <th>${t("Basis")}</th><th>${t("From")}</th><th>${t("Until")}</th><th class="num">${t("Rise / yr %")}</th><th></th></tr></thead>
        <tbody id="psLines">${d.lines.map(lineRow).join("")}</tbody></table></div>
      ${canWrite() ? `<button class="btn btn-sm mt" id="psAddLine">+ ${t("Add cost line")}</button>` : ""}
      <p class="muted" style="font-size:12px">${t("A blank ‘From’ means the line runs from the first forecast month.")}</p></div>

    <div class="pf-two mt">
      <div class="card pf-edit"><h3>${t("One-off items")}</h3>
        <table class="tbl"><thead><tr><th>${t("Month")}</th><th>${t("Direction")}</th><th>${t("What")}</th><th class="num">${t("Amount")}</th><th></th></tr></thead>
          <tbody id="psOne">${d.oneoffs.map(oneRow).join("")}</tbody></table>
        ${canWrite() ? `<button class="btn btn-sm mt" id="psAddOne">+ ${t("Add one-off")}</button>` : ""}</div>
      <div class="card pf-edit"><h3>CAPEX</h3>
        <table class="tbl"><thead><tr><th>${t("Month")}</th><th>${t("Asset")}</th><th class="num">${t("Amount")}</th><th class="num">${t("Life (mo)")}</th><th></th></tr></thead>
          <tbody id="psCap">${d.capex.map(capRow).join("")}</tbody></table>
        ${canWrite() ? `<button class="btn btn-sm mt" id="psAddCap">+ ${t("Add asset")}</button>` : ""}</div>
    </div>

    ${canWrite() ? `<div class="form-actions"><button class="btn btn-danger" id="psDel">${t("Delete SBU")}</button>
      <button class="btn btn-primary" id="psSave">${t("Save & re-run the analysis")}</button></div>` : ""}`;

  wireEntImageField($("#pfBody"), d.name);
  const bindDel = () => $$("#pfBody .pl-del").forEach(b => b.onclick = () => b.closest("tr").remove());
  bindDel();
  const add = (sel, html) => { $(sel).insertAdjacentHTML("beforeend", html); bindDel(); };
  if ($("#psAddLine")) $("#psAddLine").onclick = () => add("#psLines", lineRow({ category: "people", basis: "fixed" }));
  if ($("#psAddOne")) $("#psAddOne").onclick = () => add("#psOne", oneRow({ flow: "in" }));
  if ($("#psAddCap")) $("#psAddCap").onclick = () => add("#psCap", capRow({ life_months: 48 }));

  if ($("#psSave")) $("#psSave").onclick = async () => {
    const n = id => parseFloat($(id).value) || 0, frac = id => (parseFloat($(id).value) || 0) / 100;
    const payload = {
      name: $("#psName").value, code: $("#psCode").value, company_id: parseInt($("#psCo").value, 10),
      stage: $("#psStage").value, launch_month: $("#psLaunch").value,
      target_year: parseInt($("#psYear").value, 10), actual_through: $("#psThrough").value,
      horizon_end: $("#psHorizon").value, burn_budget: n("#psBudget"), notes: $("#psNotes").value,
      project_ids: $$("#pfBody .ps-prj").filter(c => c.checked).map(c => parseInt(c.value, 10)),
      assumptions: {
        arpu: n("#paArpu"), arpu_growth_annual: frac("#paArpuG"), revenue_start_month: $("#paRevStart").value,
        start_users: n("#paStartU"), new_users_first: n("#paNew"), new_users_growth: frac("#paNewG"),
        churn_monthly: frac("#paChurn"), server_base: n("#paSvBase"), server_per_user: n("#paSvUser"),
        server_step_users: n("#paSvStepU"), server_step_cost: n("#paSvStepC"),
      },
      lines: $$("#psLines tr").map(tr => ({
        label: $(".pl-label", tr).value, category: $(".pl-cat", tr).value,
        monthly_amount: parseFloat($(".pl-amt", tr).value) || 0, basis: $(".pl-basis", tr).value,
        start_month: $(".pl-start", tr).value, end_month: $(".pl-end", tr).value,
        escalation_annual: (parseFloat($(".pl-esc", tr).value) || 0) / 100,
      })),
      oneoffs: $$("#psOne tr").map(tr => ({ month: $(".po-month", tr).value, flow: $(".po-flow", tr).value,
        label: $(".po-label", tr).value, amount: parseFloat($(".po-amt", tr).value) || 0 })),
      capex: $$("#psCap tr").map(tr => ({ month: $(".pc-month", tr).value, label: $(".pc-label", tr).value,
        amount: parseFloat($(".pc-amt", tr).value) || 0, life_months: parseInt($(".pc-life", tr).value, 10) || 48 })),
    };
    try {
      await api(`/api/products/${pid}`, { method: "PUT", json: payload });
      toast(t("Saved — analysis re-run"));
      state.pfTab = "overview"; reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#psDel")) $("#psDel").onclick = async () => {
    if (!confirm(t("Delete this SBU and all its drivers? The ledger is not touched."))) return;
    try { await api(`/api/products/${pid}`, { method: "DELETE" }); toast(t("SBU deleted")); state.pfId = null; reload(); }
    catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ money tracker */
// pipeline state -> pill class for the stage history table
const MT_STATE_PILL = { completed: "posted", current: "active", pending: "inactive", skipped: "draft" };
const MT_STATUS_PILL = { prospectus: "prospectus", active: "active", done: "posted", on_hold: "draft", cancelled: "inactive" };

async function pageMoneyTracker(el) {
  el.innerHTML = `
    <div class="page-head"><h2>${t("Money Tracker")} <span class="muted" style="font-size:13px;font-weight:500">· ${t("invoicing process per project")}</span></h2>
      <div class="page-actions">
        ${canWrite() ? `<button class="btn btn-primary" id="mtNew">+ ${t("New invoice track")}</button>` : ""}
      </div></div>
    <div id="mtBody"><div class="empty">Loading…</div></div>`;
  const load = async () => {
    const d = await api(`/api/money-tracker?${scopeQS()}`);
    $("#scopeBadge").textContent = d.scope;
    // ---- filters (client name / amount order / current phase) ----
    const fClient = (state.mtClient || "").toLowerCase();
    const fPhase = state.mtPhase || "";
    const fSort = state.mtSort || "";
    let items = d.items.filter(m =>
      (!fClient || (`${m.client || ""} ${m.project_code || ""} ${m.project_name || ""} ${m.title || ""}`).toLowerCase().includes(fClient))
      && (!fPhase || m.phase_key === fPhase));
    if (fSort === "amount_desc") items = items.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0));
    else if (fSort === "amount_asc") items = items.slice().sort((a, b) => (a.amount || 0) - (b.amount || 0));
    const rows = items.map(m => {
      const name = m.project_code ? `${esc(m.project_code)} — ${esc(m.project_name || "")}` : esc(m.title || "—");
      const hot = m.is_hot ? ` <span class="pill hot" title="HOT prospect">&#128293; HOT</span>` : "";
      return `<tr data-id="${m.id}" style="cursor:pointer">
        <td><b>${name}</b>${hot}${m.title && m.project_code ? `<br><span class="muted">${esc(m.title)}</span>` : ""}</td>
        <td>${esc(m.company_code)}</td>
        <td>${esc(m.client || "")}<br><span class="muted">${esc(m.invoice_no || "")}</span></td>
        <td class="num"><b>${fmtRp(m.amount)}</b></td>
        <td style="min-width:190px">
          <div><span class="pill ${MT_STATE_PILL[m.status === "done" ? "completed" : "current"]}">${esc(m.phase_label)}</span>
            <span class="muted" style="font-size:11.5px"> ${esc(m.phase_name)}</span></div>
          <div class="bar" style="margin-top:5px"><span style="width:${m.progress_pct}%"></span></div>
          <span class="muted" style="font-size:11px">${m.phase_index}/${m.phase_total} · ${m.progress_pct}%</span>
        </td>
        <td><span class="pill ${MT_STATUS_PILL[m.status] || "inactive"}">${esc(m.status.replace("_", " "))}</span></td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">${d.items.length ? "No track matches these filters." : "No invoice tracks yet — add one to follow a project's money from contract to payment."}</td></tr>`;
    $("#mtBody").innerHTML = `
      <div class="grid kpis">
        <div class="kpi"><div class="kpi-label">${t("Total tracked")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(d.total_amount)}</div>
          <div class="kpi-sub">${d.items.length} invoice track(s)</div></div>
        <div class="kpi hl"><div class="kpi-label">${t("Outstanding")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(d.outstanding)}</div>
          <div class="kpi-sub">${d.count_active} still moving</div></div>
        <div class="kpi ${d.on_hold ? "amber" : ""}"><div class="kpi-label">${t("On hold")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(d.on_hold || 0)}</div>
          <div class="kpi-sub">${d.count_on_hold || 0} parked &middot; not in outstanding</div></div>
        <div class="kpi ${d.prospectus ? "orange" : ""}"><div class="kpi-label">${t("Prospectus")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(d.prospectus || 0)}</div>
          <div class="kpi-sub">${d.count_prospectus || 0} prospect(s)${d.count_hot ? ` &middot; ${d.count_hot} HOT` : ""}</div></div>
        <div class="kpi green"><div class="kpi-label">${t("Received")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(d.received)}</div>
          <div class="kpi-sub">clear &amp; clear</div></div>
      </div>
      <div class="card mt">
        <div class="filters" style="margin-bottom:10px">
          <label>${t("Client / project")} <input id="mtfClient" value="${esc(state.mtClient || "")}" placeholder="${t("search…")}" style="min-width:180px"></label>
          <label>${t("Amount")} <select id="mtfSort">
            <option value="">${t("default order")}</option>
            <option value="amount_desc" ${state.mtSort === "amount_desc" ? "selected" : ""}>${t("Big to small")}</option>
            <option value="amount_asc" ${state.mtSort === "amount_asc" ? "selected" : ""}>${t("Small to big")}</option>
          </select></label>
          <label>${t("Current phase")} <select id="mtfPhase">
            <option value="">${t("All phases")}</option>
            ${(d.phases || []).map(p => `<option value="${esc(p.key)}" ${state.mtPhase === p.key ? "selected" : ""}>${esc(p.label)} — ${esc(p.name)}</option>`).join("")}
          </select></label>
          <button class="btn btn-sm" id="mtfClear">${t("Clear")}</button>
          <span class="muted">${items.length} ${t("of")} ${d.items.length}</span>
        </div>
        <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th>${t("Project")}</th><th>Co.</th><th>${t("Client")} / ${t("Invoice")}</th>
          <th class="num">${t("Amount")}</th><th>${t("Current phase")}</th><th>${t("Status")}</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="muted mt">Click a row to open the phase pipeline — Pre-administration → Contract → Ongoing → Reports → SPM → SPP → Approval → KASDA → SP2D → Done.</p>
      </div>`;
    $$("#mtBody tr[data-id]").forEach(tr => tr.onclick = () => moneyTrackerDetail(tr.dataset.id, load));
    const deb = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
    $("#mtfClient").oninput = deb(e => { state.mtClient = e.target.value; load(); }, 250);
    $("#mtfSort").onchange = e => { state.mtSort = e.target.value; load(); };
    $("#mtfPhase").onchange = e => { state.mtPhase = e.target.value; load(); };
    $("#mtfClear").onclick = () => { state.mtClient = ""; state.mtSort = ""; state.mtPhase = ""; load(); };
  };
  if ($("#mtNew")) $("#mtNew").onclick = () => moneyTrackerEditor(null, load);
  await load();
}

function mtStepper(history) {
  // arrow between phases; the arrow is teal once that phase is behind us
  return `<div class="mt-steps">${history.map((h, i) => {
    const cls = h.state === "completed" ? "done" : h.state === "current" ? "cur" : "";
    const mark = h.state === "completed" ? "&#10003;" : h.no;
    const step = `<div class="mt-step ${cls}" title="${esc(h.name)}">
      <div class="mt-dot">${mark}</div>
      <div class="mt-cap"><b>${esc(h.label)}</b><br>${esc(h.name)}</div></div>`;
    const arrow = i < history.length - 1
      ? `<div class="mt-line ${h.state === "completed" ? "passed" : ""}"></div>` : "";
    return step + arrow;
  }).join("")}</div>`;
}

function mtComments(list, opts = {}) {
  if (!list.length) return `<p class="muted" style="font-size:12.5px;margin:6px 0">${opts.empty || "No comments yet."}</p>`;
  return list.map(c => `<div class="mt-cmt">
    <div class="who"><b>${esc(c.author || "—")}</b>
      <span class="when">${esc(fmtInputStamp(c.created_at))}
        ${canWrite() ? `<a href="#" class="mt-cdel" data-cid="${c.id}" style="margin-left:8px">delete</a>` : ""}</span></div>
    <div class="txt">${esc(c.body)}</div></div>`).join("");
}

async function moneyTrackerDetail(tid, reload) {
  const [m, comments] = await Promise.all([
    api("/api/money-tracker/" + tid),
    api(`/api/money-tracker/${tid}/comments`).catch(() => []),
  ]);
  const general = comments.filter(c => !c.phase_key);
  const byPhase = {};
  comments.filter(c => c.phase_key).forEach(c => { (byPhase[c.phase_key] = byPhase[c.phase_key] || []).push(c); });
  const name = m.project_code ? `${m.project_code} — ${m.project_name || ""}` : (m.title || "Invoice track");
  openModal(`
    <div class="muted" style="margin-top:-4px">${esc(m.company_code)}${m.client ? " · " + esc(m.client) : ""}
      ${m.invoice_no ? " · invoice " + esc(m.invoice_no) : ""}${m.started_at ? " · started " + esc(fmtDate(m.started_at)) : ""}</div>
    <div class="grid kpis mt">
      <div class="kpi"><div class="kpi-label">${t("Amount")}</div><div class="kpi-value" style="font-size:17px">${fmtRp(m.amount)}</div></div>
      <div class="kpi hl"><div class="kpi-label">${t("Current phase")}</div><div class="kpi-value" style="font-size:16px">${esc(m.phase_label)}</div>
        <div class="kpi-sub">${esc(m.phase_name)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Progress")}</div><div class="kpi-value">${m.progress_pct}%</div>
        <div class="kpi-sub">${m.phase_index} of ${m.phase_total}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Status")}</div><div class="kpi-value" style="font-size:16px">
        <span class="pill ${MT_STATUS_PILL[m.status] || "inactive"}">${esc(m.status.replace("_", " "))}</span></div></div>
    </div>
    ${m.status !== "active" && m.cancel_reason ? `<div class="warn ${m.status === "cancelled" ? "danger" : "watch"}" style="margin-top:10px">
      <span class="warn-ic">${m.status === "cancelled" ? "⚠" : "›"}</span>
      <span><b>${m.status === "cancelled" ? t("Project cancelled") : t("On hold")}</b> — ${esc(m.cancel_reason)}</span></div>` : ""}
    ${canWrite() ? `<div class="filters" style="margin-top:10px">
      <label class="muted">${t("Project status")}</label>
      <div class="seg-group" id="mtStatusSeg">
        <button class="seg ${m.status === "prospectus" ? "active" : ""}" data-st="prospectus">${t("Prospectus")}</button>
        <button class="seg ${m.status === "active" ? "active" : ""}" data-st="active">${t("Active")}</button>
        <button class="seg ${m.status === "on_hold" ? "active" : ""}" data-st="on_hold">${t("On hold")}</button>
        <button class="seg ${m.status === "cancelled" ? "active" : ""}" data-st="cancelled">${t("Cancelled")}</button>
        <button class="seg ${m.status === "done" ? "active" : ""}" data-st="done">${t("Done")}</button>
      </div>
      ${m.status === "prospectus" ? `<button class="btn btn-sm ${m.is_hot ? "btn-hot" : ""}" id="mtHot">${m.is_hot ? "&#128293; " + t("HOT — click to cool") : t("Mark as HOT")}</button>` : ""}
      </div>` : ""}
    ${mtStepper(m.history)}
    ${canWrite() && !m.is_final && !["on_hold", "cancelled", "prospectus"].includes(m.status) ? `<div class="filters" style="margin-top:12px">
      <button class="btn btn-primary" id="mtAdvance">${t("Mark done / advance phase")}</button>
      <label class="muted">${t("or jump to")} <select id="mtJump">
        ${m.history.map(h => `<option value="${esc(h.key)}" ${h.key === m.phase_key ? "selected" : ""}>${esc(h.label)} — ${esc(h.name)}</option>`).join("")}
      </select></label>
      <button class="btn btn-sm" id="mtGo">${t("Move")}</button>
    </div>` : ""}
    <h3 style="margin-top:16px">${t("Phase history")}</h3>
    <div style="max-height:340px;overflow:auto"><table class="tbl">
      <thead><tr><th>#</th><th>${t("Phase")}</th><th class="num">${t("Plan")}</th><th>${t("Entered")}</th>
        <th>${t("Est. end")}</th><th>${t("Completed")}</th><th>${t("Status")}</th><th>${t("Notes")}</th></tr></thead>
      <tbody>${m.history.map(h => `<tr ${h.state === "current" ? 'style="background:rgba(0,162,182,.06)"' : ""}>
        <td>${h.no}</td>
        <td><b>${esc(h.label)}</b><br><span class="muted">${esc(h.name)}</span></td>
        <td class="num">${h.plan_days ? h.plan_days + " days" : "—"}</td>
        <td>${esc(fmtDate(h.entered_at) || "—")}</td>
        <td class="muted">${esc(fmtDate(h.est_end) || "—")}</td>
        <td>${esc(fmtDate(h.completed_at) || "—")}</td>
        <td><span class="pill ${MT_STATE_PILL[h.state] || "inactive"}">${h.state}</span></td>
        <td><button class="mt-badge ${h.comment_count ? "has" : ""}" data-phase="${esc(h.key)}"
              title="${t("Notes & context for this phase")}">&#128172; ${h.comment_count || 0}</button></td></tr>
        <tr class="mt-phase-cmt" data-pc="${esc(h.key)}" hidden><td colspan="8">
          <div class="muted" style="font-size:11.5px;margin-bottom:4px"><b>${esc(h.label)}</b> — ${esc(h.name)}</div>
          <div class="pc-list">${mtComments(byPhase[h.key] || [], { empty: t("No notes for this phase yet.") })}</div>
          ${canWrite() ? `<div class="filters" style="margin-top:6px">
            <input class="pc-in" data-phase="${esc(h.key)}" placeholder="${t("Add context for this phase…")}" style="flex:1;min-width:200px">
            <button class="btn btn-sm btn-primary pc-add" data-phase="${esc(h.key)}">${t("Add")}</button></div>` : ""}
        </td></tr>`).join("")}
      </tbody></table></div>
    ${m.notes ? `<p class="muted mt">${esc(m.notes)}</p>` : ""}
    <h3 style="margin-top:16px">${t("Comments")}</h3>
    <div id="mtGeneral" style="max-height:220px;overflow:auto">${mtComments(general)}</div>
    <div class="filters" style="margin-top:8px">
      <input id="mtNewComment" placeholder="${t("Write a message…")}" style="flex:1;min-width:220px">
      <button class="btn btn-primary" id="mtPost">${t("Add comment")}</button>
    </div>
    <div class="form-actions">
      ${canWrite() ? `<button class="btn" id="mtEdit">Edit</button>
      <button class="btn btn-danger" id="mtDel">Delete</button>` : ""}
    </div>`, { title: name });
  const advance = async (body) => {
    try { await api(`/api/money-tracker/${tid}/advance`, { json: body || {} });
      toast("Phase updated"); moneyTrackerDetail(tid, reload); reload && reload();
    } catch (e) { toast(e.message, true); }
  };
  if ($("#mtAdvance")) $("#mtAdvance").onclick = () => advance({});
  if ($("#mtGo")) $("#mtGo").onclick = () => advance({ phase_key: $("#mtJump").value });
  // project status toggle — on hold / cancelled ask for the reason
  $$("#mtStatusSeg .seg").forEach(b => b.onclick = async () => {
    const st = b.dataset.st;
    let reason = m.cancel_reason || "";
    if (st === "cancelled" || st === "on_hold") {
      reason = prompt(st === "cancelled"
        ? "Why is this project cancelled?" : "Why is this project on hold?", reason) || "";
      if (!reason.trim()) { toast("A reason is required", true); return; }
    } else { reason = ""; }
    try {
      await api(`/api/money-tracker/${tid}/status`, { json: { status: st, cancel_reason: reason } });
      toast("Project status updated"); moneyTrackerDetail(tid, reload); reload && reload();
    } catch (e) { toast(e.message, true); }
  });
  if ($("#mtHot")) $("#mtHot").onclick = async () => {
    try { await api(`/api/money-tracker/${tid}/hot`, { json: { is_hot: !m.is_hot } });
      toast(m.is_hot ? "Cooled down" : "Marked HOT"); moneyTrackerDetail(tid, reload); reload && reload();
    } catch (e) { toast(e.message, true); }
  };
  // per-phase notes: toggle the sub-row, add a note
  $$("#modalRoot [data-phase].mt-badge").forEach(b => b.onclick = () => {
    const row = $(`#modalRoot tr[data-pc="${cssEsc(b.dataset.phase)}"]`);
    if (row) row.hidden = !row.hidden;
  });
  const addPhaseComment = async key => {
    const inp = $(`#modalRoot .pc-in[data-phase="${cssEsc(key)}"]`);
    const body = (inp && inp.value || "").trim();
    if (!body) return;
    try {
      await api(`/api/money-tracker/${tid}/comments`, { json: { body, phase_key: key } });
      toast("Note added"); moneyTrackerDetail(tid, reload);
    } catch (e) { toast(e.message, true); }
  };
  $$("#modalRoot .pc-add").forEach(b => b.onclick = () => addPhaseComment(b.dataset.phase));
  $$("#modalRoot .pc-in").forEach(i => i.onkeydown = e => { if (e.key === "Enter") addPhaseComment(i.dataset.phase); });
  // general comments
  const postGeneral = async () => {
    const body = $("#mtNewComment").value.trim();
    if (!body) return;
    try { await api(`/api/money-tracker/${tid}/comments`, { json: { body } });
      $("#mtNewComment").value = ""; moneyTrackerDetail(tid, reload);
    } catch (e) { toast(e.message, true); }
  };
  $("#mtPost").onclick = postGeneral;
  $("#mtNewComment").onkeydown = e => { if (e.key === "Enter") postGeneral(); };
  $$("#modalRoot .mt-cdel").forEach(a => a.onclick = async e => {
    e.preventDefault();
    if (!confirm("Delete this comment?")) return;
    try { await api("/api/money-tracker-comments/" + a.dataset.cid, { method: "DELETE" });
      moneyTrackerDetail(tid, reload);
    } catch (err) { toast(err.message, true); }
  });
  if ($("#mtEdit")) $("#mtEdit").onclick = () => moneyTrackerEditor(m, reload);
  if ($("#mtDel")) $("#mtDel").onclick = async () => {
    if (!confirm("Delete this invoice track and its phase history?")) return;
    try { await api("/api/money-tracker/" + tid, { method: "DELETE" });
      toast("Deleted"); closeModal(); reload && reload();
    } catch (e) { toast(e.message, true); }
  };
}

async function moneyTrackerEditor(m, reload) {
  const projects = await api("/api/projects?company_id=all").catch(() => []);
  const cid = m ? m.company_id : (state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10));
  const phases = await api("/api/money-tracker/phases");
  const byCo = {};
  projects.forEach(p => { (byCo[p.company_code] = byCo[p.company_code] || []).push(p); });
  const projOpts = `<option value="">— no project (free-text title) —</option>` +
    Object.keys(byCo).sort().map(co => `<optgroup label="${esc(co)}">` + byCo[co].map(p =>
      `<option value="${p.id}" ${m && String(m.project_id) === String(p.id) ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("") + "</optgroup>").join("");
  openModal(`<div class="form-grid">
    ${m ? "" : `<label class="full">Company <select id="mtCompany">${companyOptions(cid)}</select></label>`}
    <label class="full">Project <select id="mtProject">${projOpts}</select></label>
    <label class="full">Title / package <input id="mtTitle" value="${esc(m ? m.title : "")}" placeholder="e.g. Termin 1 — Consulting fee"></label>
    <label>Client <input id="mtClient" value="${esc(m ? m.client : "")}" placeholder="e.g. Dinas PU Provinsi"></label>
    <label>Invoice No <input id="mtInv" value="${esc(m ? m.invoice_no : "")}" placeholder="INV-2026-001"></label>
    <label>Amount (Rp) <input id="mtAmount" inputmode="numeric" value="${m ? fmt(m.amount) : ""}"></label>
    <label>Started <input type="date" id="mtStart" value="${esc(m ? (m.started_at || "") : new Date().toISOString().slice(0, 10))}"></label>
    <label>Phase <select id="mtPhase">${phases.map(p =>
      `<option value="${esc(p.key)}" ${m && m.phase_key === p.key ? "selected" : ""}>${esc(p.label)} — ${esc(p.name)}</option>`).join("")}</select></label>
    <label>Status <select id="mtStatus">${["prospectus", "active", "done", "on_hold", "cancelled"].map(s =>
      `<option value="${s}" ${m && m.status === s ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}</select></label>
    <label class="full">Notes <input id="mtNotes" value="${esc(m ? m.notes : "")}"></label>
    <label class="full" style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="mtHotChk" ${m && m.is_hot ? "checked" : ""} style="width:auto"> &#128293; HOT prospect</label>
    </div><div class="form-actions"><button class="btn btn-primary" id="mtSave">Save</button></div>`,
    { title: m ? "Edit invoice track" : "New invoice track" });
  $("#mtSave").onclick = async () => {
    const body = {
      project_id: $("#mtProject").value || null,
      title: $("#mtTitle").value, client: $("#mtClient").value,
      invoice_no: $("#mtInv").value,
      amount: parseInt(($("#mtAmount").value || "0").replace(/[^\d-]/g, ""), 10) || 0,
      started_at: $("#mtStart").value || null,
      phase_key: $("#mtPhase").value, status: $("#mtStatus").value,
      notes: $("#mtNotes").value, is_hot: $("#mtHotChk").checked,
    };
    try {
      if (m) await api("/api/money-tracker/" + m.id, { method: "PUT", json: body });
      else await api("/api/money-tracker", { json: Object.assign(body, { company_id: parseInt($("#mtCompany").value, 10) }) });
      toast("Invoice track saved"); closeModal(); reload && reload();
    } catch (e) { toast(e.message, true); }
  };
}

/* ------------------------------------------------------------------ accountant section (audit) */
async function pageAccountant(el) {
  if (!state.acctTab) state.acctTab = "tb";
  if (!state.acctFrom) state.acctFrom = `${state.year}-01-01`;
  if (!state.acctTo) state.acctTo = `${state.year}-12-31`;
  const meta = await api("/api/accountant/meta").catch(() => ({ users: [], accounts: [], sources: [] }));
  const tabs = [["tb", "Trial Balance — per account"], ["ledger", "Audit Ledger — by date / account / user"]];
  el.innerHTML = `
    <div class="page-head"><h2>${t("Accountant Section")} <span class="muted" style="font-size:13px;font-weight:500">· ${t("audit view · all companies")}</span></h2></div>
    <div class="tabs" id="acTabs">${tabs.map(([k, l]) =>
      `<button data-tab="${k}" class="${state.acctTab === k ? "active" : ""}">${l}</button>`).join("")}</div>
    <div class="filters mt">
      <label>From <input type="date" id="acFrom" value="${state.acctFrom}"></label>
      <label>To <input type="date" id="acTo" value="${state.acctTo}"></label>
      <label id="acCodeWrap">Account
        <select id="acCode"><option value="">All accounts</option>${meta.accounts.map(a =>
          `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join("")}</select></label>
      <label id="acUserWrap">Inputter
        <select id="acUser"><option value="">All users</option>${meta.users.map(u =>
          `<option value="${esc(u)}">${esc(u)}</option>`).join("")}</select></label>
      <label id="acSrcWrap">Source
        <select id="acSrc"><option value="">All sources</option>${(meta.sources || []).map(s =>
          `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join("")}</select></label>
      <a class="btn btn-sm" id="acExp">&#x2913; ${t("Export Excel")}</a>
    </div>
    <div id="acBody"><div class="empty">Loading…</div></div>`;
  const syncFilterVisibility = () => {
    const isLedger = state.acctTab === "ledger";
    $("#acUserWrap").style.display = isLedger ? "" : "none";
    $("#acSrcWrap").style.display = isLedger ? "" : "none";
  };
  const run = async () => {
    state.acctFrom = $("#acFrom").value; state.acctTo = $("#acTo").value;
    const qs = `date_from=${state.acctFrom}&date_to=${state.acctTo}`;
    if (state.acctTab === "tb") {
      const code = $("#acCode").value;
      $("#acExp").href = `/api/export/trial-balance?company_id=all&${qs}`;
      const d = await api(`/api/accountant/trial-balance?${qs}`);
      renderAcctTB($("#acBody"), d, code);
    } else {
      const code = $("#acCode").value, user = $("#acUser").value, src = $("#acSrc").value;
      $("#acExp").href = "#";
      const d = await api(`/api/accountant/ledger?${qs}&code=${encodeURIComponent(code)}&user=${encodeURIComponent(user)}&source=${encodeURIComponent(src)}`);
      renderAcctLedger($("#acBody"), d);
    }
  };
  $$("#acTabs button").forEach(b => b.onclick = () => {
    state.acctTab = b.dataset.tab;
    $$("#acTabs button").forEach(x => x.classList.toggle("active", x === b));
    syncFilterVisibility(); run();
  });
  ["acFrom", "acTo", "acCode", "acUser", "acSrc"].forEach(id => $("#" + id).onchange = run);
  syncFilterVisibility();
  await run();
}

function renderAcctTB(body, d, focusCode) {
  const disp = (d.grouped && d.grouped.length)
    ? d.grouped : d.rows.map(r => Object.assign({ level: 0, is_group: false }, r));
  const rows = disp.filter(r => !focusCode || r.code === focusCode).map(r => {
    const pad = 8 + r.level * 18;
    const nameCell = r.is_group ? `<b>${esc(r.name)}</b>`
      : `<a href="#" class="ac-code" data-code="${esc(r.code)}">${esc(r.name)}</a>`;
    return `<tr class="${r.is_group ? "tb-group" : ""}">
      <td style="padding-left:${pad}px">${esc(r.code)}</td><td>${nameCell}</td><td class="muted">${r.type}</td>
      <td class="num">${r.debit ? fmt(r.debit) : ""}</td><td class="num">${r.credit ? fmt(r.credit) : ""}</td>
      <td class="num">${fmt(r.balance)}</td></tr>`;
  }).join("");
  body.innerHTML = `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody>${rows}<tr class="total"><td colspan="3">TOTAL</td><td class="num">${fmt(d.total_debit)}</td>
      <td class="num">${fmt(d.total_credit)}</td><td></td></tr></tbody></table></div>
    <p class="muted mt">Consolidated across all companies, ${esc(fmtDate(d.date_from))} → ${esc(fmtDate(d.date_to))}. Grouped by parent account (bold = subtotal).
      <b>Click an account</b> to see its full audit trail — every entry, its source and who input it.</p></div>`;
  $$("#acBody .ac-code").forEach(a => a.onclick = e => {
    e.preventDefault();
    $("#acCode").value = a.dataset.code;
    // jump to the ledger for this account
    state.acctTab = "ledger";
    $$("#acTabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === "ledger"));
    $("#acUserWrap").style.display = ""; $("#acSrcWrap").style.display = "";
    $("#acCode").dispatchEvent(new Event("change"));
  });
}

function renderAcctLedger(body, d) {
  const rows = d.lines.map(l => `<tr>
    <td>${esc(fmtDate(l.date))}</td>
    <td class="ac-open" data-jid="${l.entry_id}" title="Open this entry — view, edit or move it"><b>${esc(l.entry_no)}</b> &#9998;<br><span class="muted">${esc(l.company_code)}</span></td>
    <td>${esc(l.acc_code)}<br><span class="muted">${esc(l.acc_name)}</span></td>
    <td>${esc(l.line_desc || l.entry_desc || "")}${l.project_code ? `<br><span class="muted">proj ${esc(l.project_code)}</span>` : ""}</td>
    <td><span class="pill ${SOURCE_CLASS[l.source] || "inactive"}">${esc(l.source_label)}</span></td>
    <td><b>${esc(l.inputter)}</b>${l.inputter_name ? `<br><span class="muted">${esc(l.inputter_name)}</span>` : ""}</td>
    <td class="num">${l.debit ? fmt(l.debit) : ""}</td>
    <td class="num">${l.credit ? fmt(l.credit) : ""}</td></tr>`).join("")
    || `<tr><td colspan="8" class="empty">No journal lines match these filters.</td></tr>`;
  body.innerHTML = `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Date</th><th>Entry / Co.</th><th>Account</th><th>Description</th><th>Source</th><th>Inputter</th>
      <th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${rows}<tr class="total"><td colspan="6">TOTAL — ${d.count} line(s)</td>
      <td class="num">${fmt(d.total_debit)}</td><td class="num">${fmt(d.total_credit)}</td></tr></tbody></table></div>
    <p class="muted mt">Every posted journal line, ${esc(fmtDate(d.date_from))} → ${esc(fmtDate(d.date_to))}, across all companies — with its
      <b>source</b> (manual / bank / credit card / …) and the <b>user who input it</b>. Filter by account, inputter or source above for review.
      <b>Click an entry number</b> to open it, edit it, or move it to another company or project.</p></div>`;
  // re-running the current filter is how this tab reloads; an edit may have
  // moved a line to another account, company or project
  const refresh = () => $("#acCode").dispatchEvent(new Event("change"));
  $$("#acBody .ac-open").forEach(td => td.onclick = () =>
    viewJournal(parseInt(td.dataset.jid, 10), refresh));
}

async function pageSettings(el) {
  const tabs = [["display", "Display"], ["coa", "Chart of Accounts"], ["fields", "Custom Fields"],
                ["companies", "Companies"]];
  if (isAdmin()) tabs.push(["users", "Users"], ["thresholds", "Thresholds"], ["cash", "Cash & Bank"],
                           ["dashboard", "Dashboard"], ["cashplan", "Budget & Oracle"]);
  el.innerHTML = `
    <div class="page-head"><h2>${t("Settings")}</h2></div>
    <div class="tabs" id="sTabs">${tabs.map(([k, l], i) =>
      `<button data-tab="${k}" class="${i === 0 ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="sBody"></div>`;
  let tab = "display";
  $$("#sTabs button").forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    $$("#sTabs button").forEach(x => x.classList.toggle("active", x === b));
    show();
  });
  async function show() {
    const body = $("#sBody");
    body.innerHTML = `<div class="card"><div class="empty">Loading…</div></div>`;
    if (tab === "display") await settingsDisplay(body);
    else if (tab === "coa") await settingsCoa(body);
    else if (tab === "fields") await settingsFields(body);
    else if (tab === "companies") await settingsCompanies(body);
    else if (tab === "users") await settingsUsers(body);
    else if (tab === "thresholds") await settingsThresholds(body);
    else if (tab === "cash") await settingsCash(body);
    else if (tab === "dashboard") await settingsDashboard(body);
    else if (tab === "cashplan") await settingsCashPlan(body);
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
  const asOf = state.me.data_as_of || "";
  // the cut-off belongs next to the database name: a figure from a ledger that
  // stops in July must never be read as a figure that is current
  badge.textContent = active ? "LIVE · " + active + (asOf ? " · " + t("data to") + " " + fmtDate(asOf) : "") : "";
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
        <button class="btn btn-sm" id="cAudit" title="Scan this company's accounts for self-referencing / looping / orphan parents">&#x26A0; Integrity check</button>
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
    // parent-chain walks are cycle-guarded: a self-referencing or cyclic
    // parent_code (e.g. a bad 6600→6600) must never hang the page.
    const levelOf = a => { let lvl = 0, p = a.parent_code; const seen = new Set([a.code]);
      while (p && byCode[p] && !seen.has(p) && lvl < 8) { seen.add(p); lvl++; p = byCode[p].parent_code; } return lvl; };
    const sortKey = a => { const chain = []; const seen = new Set(); let x = a;
      while (x && !seen.has(x.code)) { seen.add(x.code); chain.unshift(x.code); x = x.parent_code ? byCode[x.parent_code] : null; }
      return chain.join("/"); };
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
  $("#cAudit").onclick = async () => {
    try {
      const d = await api("/api/accounts/integrity?company_id=" + company());
      const KIND = { self_parent: "Self-referencing", cycle: "Loop / cycle", orphan_parent: "Missing parent", duplicate_code: "Duplicate code" };
      openModal(`
        <div class="muted" style="margin-top:-4px">${d.accounts} accounts scanned</div>
        ${d.ok
          ? `<p class="pos" style="margin-top:12px">&#10003; <b>No integrity problems.</b> The account tree is clean — no self-referencing, looping, orphaned or duplicate accounts.</p>`
          : `<p class="neg" style="margin-top:12px"><b>${d.issues.length} problem account(s) found.</b> These break the tree view; fix each account's Parent below (edit it and clear/correct the Parent).</p>
             <table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Problem</th><th>Detail</th></tr></thead>
             <tbody>${d.issues.map(i => `<tr><td><b>${esc(i.code)}</b></td><td>${esc(i.name || "")}</td>
               <td><span class="pill bad">${esc(KIND[i.kind] || i.kind)}</span></td>
               <td class="muted">${esc(i.detail)}</td></tr>`).join("")}</tbody></table>
             <p class="muted mt">The app now blocks creating these, and the list still renders safely — but fixing them restores the correct hierarchy &amp; grouped reports.</p>`}`,
        { title: "Chart of Accounts — Integrity check" });
    } catch (e) { toast(e.message, true); }
  };
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

async function settingsCash(body) {
  const load = async () => {
    const d = await api("/api/settings/cash-accounts");
    const sel = new Set(d.selected || []);
    const allOn = sel.size === 0;
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Dashboard “Cash &amp; Bank” accounts</h3>
        <button class="btn btn-sm btn-primary" id="csSave">Save</button></div>
      <p class="muted" style="margin-top:-6px">Choose which cash/bank (11xx) accounts are added up for the dashboard
        <b>Cash &amp; Bank</b> figure (and the cash-buffer / free-cash metrics derived from it). Leave <b>all</b> ticked to count every
        cash/bank account.</p>
      <label class="seg-check" style="margin-bottom:8px"><input type="checkbox" id="csAll" ${allOn ? "checked" : ""}> Count all cash/bank accounts</label>
      <table class="tbl"><thead><tr><th style="width:40px"></th><th>Code</th><th>Account</th></tr></thead>
        <tbody>${d.accounts.map(a => `<tr>
          <td><input type="checkbox" class="cs-in" value="${esc(a.code)}" ${allOn || sel.has(a.code) ? "checked" : ""}></td>
          <td><b>${esc(a.code)}</b></td><td>${esc(a.name)}</td></tr>`).join("")
          || `<tr><td colspan="3" class="empty">No 11xx cash/bank accounts</td></tr>`}
        </tbody></table></div>`;
    const rows = () => $$("#sBody .cs-in");
    $("#csAll").onchange = () => rows().forEach(c => { c.checked = $("#csAll").checked; c.disabled = $("#csAll").checked; });
    if (allOn) rows().forEach(c => c.disabled = true);
    $("#csSave").onclick = async () => {
      // "count all" -> save empty list (= default all); otherwise the ticked codes
      const codes = $("#csAll").checked ? [] : rows().filter(c => c.checked).map(c => c.value);
      try { await api("/api/settings/cash-accounts", { json: { codes } }); toast("Cash & Bank accounts saved — dashboard updated"); load(); }
      catch (e) { toast(e.message, true); }
    };
  };
  await load();
}

async function settingsDashboard(body) {
  const load = async () => {
    const d = await api("/api/settings/dashboard-kpis");
    const sel = new Set(d.selected || []);
    const allOn = sel.size === 0;
    body.innerHTML = `<div class="card">
      <div class="page-head"><h3 style="margin:0">Dashboard company-information resume</h3>
        <button class="btn btn-sm btn-primary" id="dkSave">Save</button></div>
      <p class="muted" style="margin-top:-6px">Pick which summary tiles appear at the top of the dashboard. Leave <b>all</b> ticked to show every tile.</p>
      <label class="seg-check" style="margin-bottom:8px"><input type="checkbox" id="dkAll" ${allOn ? "checked" : ""}> Show all tiles</label>
      <div class="chk-grid">${d.all.map(a =>
        `<label class="chk"><input type="checkbox" class="dk-in" value="${esc(a.key)}" ${allOn || sel.has(a.key) ? "checked" : ""}> ${esc(a.label)}</label>`).join("")}</div>
      </div>`;
    const rows = () => $$("#sBody .dk-in");
    $("#dkAll").onchange = () => rows().forEach(c => { if ($("#dkAll").checked) c.checked = true; c.disabled = $("#dkAll").checked; });
    if (allOn) rows().forEach(c => c.disabled = true);
    $("#dkSave").onclick = async () => {
      const keys = $("#dkAll").checked ? [] : rows().filter(c => c.checked).map(c => c.value);
      try { await api("/api/settings/dashboard-kpis", { json: { keys } }); toast("Dashboard resume saved"); load(); }
      catch (e) { toast(e.message, true); }
    };
  };
  await load();
}

async function settingsCashPlan(body) {
  // The budget is week-grain everywhere now, so the only conversion left is the
  // bulk one: fold each month back into its first week. It is here rather than
  // on the grid because it rewrites a whole year across every company at once.
  const load = async () => {
    body.innerHTML = `<div class="card">
      <h3>${t("Convert the monthly budget into Week 1")}</h3>
      <p class="muted" style="margin-top:-6px">${t("Folds every month of the")} <b>${state.year}</b>
        ${t("budget into its first week, for company-level and project-level lines alike. Weeks 2-4 are ADDED into week 1, never dropped — the month total is identical before and after, and the result says so.")}</p>
      <p class="muted" style="font-size:12px">${t("A monthly budget tells you the month, not the week. Week 1 is its honest reading and the safest for cash: money out as early as it could go. This is what the Oracle then reads.")}</p>
      <div class="form-grid">
        <label>${t("Company")} <select id="scCompany">
          <option value="">${t("All companies I can access")}</option>
          ${companyOptions(null)}</select></label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" id="scRun">${t("Fold every month into Week 1")}</button></div>
      <div id="scResult"></div>
    </div>

    <div class="card mt">
      <div class="page-head"><h3 style="margin:0">${t("How each account moves cash")}</h3>
        <button class="btn btn-sm btn-primary" id="cfSave">${t("Save")}</button></div>
      <p class="muted" style="margin-top:-6px">${t("Only 'operating' expenses count towards the buffer floor. Depreciation and other non-cash lines must be marked 'noncash' or the Oracle will demand a cash buffer for money that never leaves the bank.")}</p>
      <div id="cfBox" class="empty">${t("Loading")}\u2026</div>
    </div>`;

    $("#scRun").onclick = async () => {
      const cid = $("#scCompany").value;
      if (!confirm(t("Fold every month of") + " " + state.year + " " + t("into Week 1?"))) return;
      try {
        const r = await api("/api/budgets/collapse-to-week1", {
          json: { year: state.year, company_id: cid ? parseInt(cid, 10) : null } });
        $("#scResult").innerHTML = `<p class="${r.unchanged ? "pos" : "neg"}" style="margin-top:10px">
          ${r.months_folded} ${t("account-months folded into Week 1.")}
          ${t("Total budget before")} <b>${fmtRp(r.total_before)}</b>,
          ${t("after")} <b>${fmtRp(r.total_after)}</b> —
          ${r.unchanged ? t("unchanged, as it must be.") : t("THESE DO NOT MATCH. Do not trust this result.")}</p>`;
        toast(`${r.months_folded} ${t("account-months folded into Week 1.")}`);
      } catch (e) { toast(e.message, true); }
    };

    // cash-flow class table loads on its own so a big COA never blocks the page
    try {
      const cf = await api("/api/settings/cash-flow-classes");
      $("#cfBox").className = "";
      $("#cfBox").innerHTML = `<div style="max-height:420px;overflow:auto"><table class="tbl">
        <thead><tr><th>${t("Code")}</th><th>${t("Account")}</th><th>${t("Type")}</th><th>${t("Cash-flow class")}</th></tr></thead>
        <tbody>${cf.accounts.map(a => `<tr><td><code>${esc(a.code)}</code></td><td>${esc(a.name)}</td>
          <td class="muted">${esc(a.type)}</td>
          <td><select class="cf-in" data-code="${esc(a.code)}">
            <option value="">${t("\u2014 unset \u2014")}</option>
            ${cf.classes.map(c => `<option value="${esc(c)}" ${a.cash_flow_class === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
          </select></td></tr>`).join("")}</tbody></table></div>`;
      $("#cfSave").onclick = async () => {
        const classes = {};
        $$("#sBody .cf-in").forEach(i => { classes[i.dataset.code] = i.value; });
        try {
          const r = await api("/api/settings/cash-flow-classes", { json: { classes } });
          toast(r.updated + " " + t("accounts updated"));
        } catch (e) { toast(e.message, true); }
      };
    } catch (e) { $("#cfBox").innerHTML = `<p class="neg">${esc(e.message)}</p>`; }
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
  const companies = state.me.companies.filter(c => !c.is_holding);
  const coAll = !u || u.company_access === "all";
  const coSet = new Set(coAll ? [] : String(u.company_access || "").split(",").map(s => s.trim()));
  const menuAll = !u || (u.menu_access || "all") === "all";
  const menuSet = new Set(menuAll ? [] : String(u.menu_access || "").split(",").map(s => s.trim()));
  const menuItems = NAV_ITEMS.filter(n => n[0] !== "settings");  // settings stays admin-gated
  openModal(`<div class="form-grid">
    <label>Username <input id="uName" value="${esc(u ? u.username : "")}" ${u ? "disabled" : ""}></label>
    <label>Full name <input id="uFull" value="${esc(u ? u.full_name : "")}"></label>
    <label>Role <select id="uRole">${["admin", "finance", "viewer"].map(r =>
      `<option value="${r}" ${u && u.role === r ? "selected" : ""}>${ROLE_LABELS[r]} — ${ROLE_DESC[r]}</option>`).join("")}</select></label>
    <label class="full">${u ? "New password (leave blank to keep)" : "Password"} <input id="uPass" type="password"></label>
    ${u ? `<label style="flex-direction:row;align-items:center;gap:8px">
      <input type="checkbox" id="uActive" ${u.is_active ? "checked" : ""} style="width:auto"> Active</label>` : ""}
    </div>
    <div class="fld-label" style="margin-top:12px">Company access <span class="muted">(which companies this user can see)</span></div>
    <label class="seg-check"><input type="checkbox" id="uCoAll" ${coAll ? "checked" : ""}> All companies</label>
    <div class="chk-grid" id="uCoGrid">${companies.map(c =>
      `<label class="chk"><input type="checkbox" class="uco" value="${c.id}" ${coAll || coSet.has(String(c.id)) ? "checked" : ""}> ${esc(c.code)} — ${esc(c.name)}</label>`).join("")}</div>
    <div class="fld-label" style="margin-top:12px">Menu access <span class="muted">(which left-menu items this user can see — admins always see all)</span></div>
    <label class="seg-check"><input type="checkbox" id="uMenuAll" ${menuAll ? "checked" : ""}> All menus</label>
    <div class="chk-grid" id="uMenuGrid">${menuItems.map(n =>
      `<label class="chk"><input type="checkbox" class="umenu" value="${n[0]}" ${menuAll || menuSet.has(n[0]) ? "checked" : ""}> ${n[1]} ${esc(t(n[2]))}</label>`).join("")}</div>
    <div class="form-actions"><button class="btn btn-primary" id="uSave">Save User</button></div>`,
    { title: u ? "Edit User" : "New User" });
  const wire = (allId, cls, gridId) => {
    const sync = () => $$("#" + gridId + " ." + cls).forEach(c => { if ($("#" + allId).checked) c.checked = true; c.disabled = $("#" + allId).checked; });
    $("#" + allId).onchange = sync; sync();
  };
  wire("uCoAll", "uco", "uCoGrid");
  wire("uMenuAll", "umenu", "uMenuGrid");
  $("#uSave").onclick = async () => {
    const coAllOn = $("#uCoAll").checked;
    const menuAllOn = $("#uMenuAll").checked;
    const coSel = $$("#uCoGrid .uco").filter(c => c.checked).map(c => c.value);
    const menuSel = $$("#uMenuGrid .umenu").filter(c => c.checked).map(c => c.value);
    const body = {
      full_name: $("#uFull").value, role: $("#uRole").value,
      company_access: (coAllOn || !coSel.length) ? "all" : coSel.join(","),
      menu_access: (menuAllOn || !menuSel.length) ? "all" : menuSel.join(","),
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
      const where = res.by_project && Object.keys(res.by_project).length
        ? `<p class="muted">${Object.entries(res.by_project).map(([k, v]) =>
            `${esc(k)}: ${v} ${v === 1 ? t("row") : t("rows")}`).join(" · ")}</p>` : "";
      $("#impResult").innerHTML = `<p class="${errs.length ? "neg" : "pos"}"><b>${msg.join(", ") || "Done"}</b></p>` + where +
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

/* ------------------------------------------------------------ v1.09 additions */

// A waterfall: start at a total, take each step out of it, land on the closing
// total. Costs are read one account at a time, which is what a project manager
// argues with - two totals side by side never show where the money went.
function chartWaterfall(steps, opts = {}) {
  const W = opts.width || 720, H = opts.height || 300;
  const padL = 92, padR = 10, padT = 18, padB = 44;
  let run = 0, min = 0, max = 0;
  const bars = steps.map(s => {
    const start = s.kind === "total" ? 0 : run;
    const end = s.kind === "total" ? s.value : run + s.value;
    run = end;
    min = Math.min(min, start, end);
    max = Math.max(max, start, end);
    return { ...s, start, end };
  });
  if (max === min) max = min + 1;
  const pad = (max - min) * 0.12;
  max += pad; min -= pad;
  const y = v => padT + (max - v) / (max - min) * (H - padT - padB);
  const gw = (W - padL - padR) / bars.length;
  const bw = Math.min(gw * 0.62, 54);
  let out = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    out += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" style="stroke:var(--border)" stroke-width="1"/>`;
    out += `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" style="fill:var(--muted)">${esc(fmtShortRp(v))}</text>`;
  }
  if (min < 0) out += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" style="stroke:var(--muted)" stroke-width="1.2"/>`;
  bars.forEach((b, i) => {
    const cx = padL + i * gw + gw / 2, x = cx - bw / 2;
    const top = Math.min(y(b.start), y(b.end));
    const h = Math.max(Math.abs(y(b.end) - y(b.start)), 1.5);
    const color = b.kind === "total" ? (b.value >= 0 ? C_PROFIT : C_EXP) : (b.value >= 0 ? C_REV : C_EXP);
    out += `<rect class="ch-bar" style="animation-delay:${(i * 0.04).toFixed(2)}s" x="${x}" y="${top}" width="${bw}" height="${h}" rx="2" fill="${color}"><title>${esc(b.title || b.label)}: ${esc(fmtRp(b.value))}</title></rect>`;
    out += `<text x="${cx}" y="${top - 5}" text-anchor="middle" font-size="10" font-weight="600" style="fill:var(--text)">${esc(fmtShort(b.value))}</text>`;
    if (i < bars.length - 1 && bars[i + 1].kind !== "total") {
      const nx = padL + (i + 1) * gw + gw / 2 - bw / 2;
      out += `<line x1="${x + bw}" y1="${y(b.end)}" x2="${nx}" y2="${y(b.end)}" style="stroke:var(--muted)" stroke-dasharray="3 3" stroke-width="1"/>`;
    }
    const lb = String(b.label);
    out += `<text x="${cx}" y="${H - 24}" text-anchor="middle" font-size="10" style="fill:var(--muted)">${esc(lb.length > 15 ? lb.slice(0, 14) + "…" : lb)}</text>`;
  });
  out += "</svg>";
  return `<div class="chart-wrap">${out}</div>`;
}

// Revenue, then every cost account taken out of it, ending at gross profit.
// Realization is what happened; Budget is what was promised - the same shape,
// so the two can be read against each other.
function pfWaterfall(perf, view) {
  const val = r => ((view === "budget" ? r.budget : r.actual) || 0);
  const rev = round2(perf.rows.filter(r => r.type === "revenue").reduce((s, r) => s + val(r), 0));
  const costs = perf.rows.filter(r => r.type === "expense" && val(r) > 0)
    .map(r => ({ code: r.code, name: r.name, amount: val(r) }))
    .sort((a, b) => b.amount - a.amount);
  const head = costs.slice(0, 8), rest = costs.slice(8);
  const restSum = round2(rest.reduce((s, r) => s + r.amount, 0));
  const profit = round2(rev - costs.reduce((s, r) => s + r.amount, 0));
  const steps = [{ label: t("Revenue"), title: t("Revenue"), value: rev, kind: "total" }]
    .concat(head.map(r => ({ label: r.code, title: `${r.code} ${r.name}`, value: -r.amount, kind: "down" })))
    .concat(restSum ? [{ label: t("Other costs"), title: `${rest.length} ${t("more cost accounts")}`,
                        value: -restSum, kind: "down" }] : [])
    .concat([{ label: t("Gross profit"), title: t("Gross profit"), value: profit, kind: "total" }]);
  return { steps, rev, profit, costs, margin: rev ? Math.round(1000 * profit / rev) / 10 : 0 };
}

function pfWaterfallCard(perf) {
  const view = state.prjWfView === "budget" ? "budget" : "actual";
  const w = pfWaterfall(perf, view);
  return `<div class="page-head" style="margin-top:16px;align-items:center">
      <h3 style="margin:0">${t("Where the revenue goes")}
        <span class="muted" style="font-weight:500;font-size:13px">· ${view === "budget"
          ? t("budget: the gross profit this project was promised to make")
          : t("realization: revenue less every cost account booked to this project")}</span></h3>
      <div class="page-actions"><div class="seg-group" id="prjWf">
        <button class="seg ${view === "actual" ? "active" : ""}" data-w="actual">${t("Realization")}</button>
        <button class="seg ${view === "budget" ? "active" : ""}" data-w="budget">${t("Budget")}</button>
      </div></div></div>
    ${w.costs.length || w.rev ? chartWaterfall(w.steps, { height: 300 }) : `<p class="empty">${
      view === "budget" ? t("Nothing budgeted on this project yet.") : t("Nothing posted to this project yet.")}</p>`}
    <p class="muted" style="font-size:12px">${t("Gross profit")}: <b class="${w.profit >= 0 ? "pos" : "neg"}">${fmtRp(w.profit)}</b>
      · ${t("margin")} ${w.margin}% · ${w.costs.length} ${t("cost accounts")}</p>`;
}

// Weekly cash the way the planning sheet reads it: consolidated by default,
// weeks along the bottom under their month, money down the side in rupiah.
function renderOracleWeekly(d) {
  const host = $("#orWeekly");
  if (!host) return;
  const ents = (d.entities || []).filter(e => (e.weekly || []).length);
  if (!ents.length) { host.innerHTML = ""; return; }
  const sel = state.oracleCashCo === "all" || ents.some(e => String(e.company_id) === state.oracleCashCo)
    ? state.oracleCashCo : "all";
  const one = ents.find(e => String(e.company_id) === sel);
  const wk = ents[0].weekly.map((w, i) => ({
    ...w,
    ending: one ? ((one.weekly[i] || {}).ending || 0)
                : ents.reduce((s, e) => s + ((e.weekly[i] || {}).ending || 0), 0),
  }));
  const floor = one ? (one.floor || 0) : ents.reduce((s, e) => s + (e.floor || 0), 0);
  const groups = [];
  wk.forEach((w, i) => {
    const g = groups[groups.length - 1];
    if (g && g.month === w.month) g.to = i;
    else groups.push({ month: w.month, text: MONTH_NAMES[w.month - 1], from: i, to: i });
  });
  const worstWeek = wk.reduce((lo, w) => (w.ending < lo.ending ? w : lo), wk[0]);
  host.innerHTML = `<div class="card mt">
    <div class="page-head"><h3 style="margin:0">${t("Weekly cash")} — ${esc(one ? one.company_code : t("All companies (consolidated)"))}
      <span class="muted" style="font-weight:500;font-size:13px">(${t("Bound run")})</span></h3>
      <div class="page-actions"><label class="muted">${t("Show")} <select id="orCashCo">
        <option value="all" ${!one ? "selected" : ""}>${t("All companies (consolidated)")}</option>
        ${ents.map(e => `<option value="${e.company_id}" ${one && one.company_id === e.company_id ? "selected" : ""}>${esc(e.company_code)}</option>`).join("")}
      </select></label></div></div>
    ${chartBars(wk.map(w => "W" + w.week), [
      { name: t("Cash"), color: C_REV, values: wk.map(w => w.ending), type: "line" },
      { name: t("Buffer floor"), color: "#c87a08", values: wk.map(() => floor), type: "line" },
      { name: t("Zero"), color: "#bd362f", values: wk.map(() => 0), type: "line" },
    ], { height: 340, width: 900, axisFmt: fmtShortRp, padL: 96, groupLabels: groups })}
    <p class="muted" style="font-size:12px">${t("Four weeks a month, W4 runs to month end. Bound counts only committed money in, and committed + planned money out.")}
      ${!one ? t("Consolidated adds every company together; the group verdict still follows the weakest company, because cash in one entity does not pay another's bills.") : ""}
      <br>${t("Lowest point")}: <b class="${worstWeek.ending < floor ? "neg" : "pos"}">${fmtRp(worstWeek.ending)}</b>
      ${t("at")} <b>W${worstWeek.week} ${MONTH_NAMES[worstWeek.month - 1]}</b> · ${t("buffer floor")} ${fmtRp(floor)}</p></div>`;
  if ($("#orCashCo")) $("#orCashCo").onchange = e => {
    state.oracleCashCo = e.target.value;
    renderOracleWeekly(d);
  };
}

// Read a hand-kept weekly cashflow sheet into a scenario. It is checked first
// and written only on the second click: an import that silently half-lands is
// worse than one that never ran.
function oracleCashImportModal(onDone) {
  const cid = state.companyId === "all" ? firstCompanyId() : parseInt(state.companyId, 10);
  const certs = ["committed", "planned", "expected", "speculative"];
  const certOpts = pick => certs.map(c =>
    `<option value="${c}" ${c === pick ? "selected" : ""}>${esc(t(c))}</option>`).join("");
  openModal(`
    <p class="muted" style="margin-top:0">${t("Two shapes are read here. The PLAN TEMPLATE is written from your own database: every account and project is a drop-down and this year's budget is already in it, so a row reads \"5100-01 Direct Labor / Consultant Fees · project NX-01 · 25.000.000 · out · W2 December\". A HAND-KEPT CASH SHEET also works: the month over each block, W1..W4 under it, and a label with its amount in the next column (negative = money out).")}</p>
    <p class="muted" style="margin-top:-6px">${t("Either way it becomes a new Oracle scenario; your Budget Center is not touched.")}
      <button class="btn btn-sm" id="cfTpl" type="button" style="margin-left:6px">&#x2913; ${t("Plan template")}</button></p>
    <form id="cfImp" class="form-grid">
      <label>${t("Company")} <select name="company_id">${companyOptions(cid)}</select></label>
      <label>${t("Year, if the sheet does not say")} <input name="year" type="number" value="${state.year}"></label>
      <label class="full">${t("Scenario name")} <input name="name" placeholder="${t("e.g. Q4 cash drive")}"></label>
      <label>${t("Count money in as")} <select name="certainty_in">${certOpts("planned")}</select></label>
      <label>${t("Count money out as")} <select name="certainty_out">${certOpts("committed")}</select></label>
      <span class="muted full" style="font-size:12px">${t("Used for a hand-kept sheet, and for any template row that leaves Certainty blank.")}</span>
      <label class="full">${t("Excel file")} <input type="file" name="file" accept=".xlsx,.xlsm" required></label>
    </form>
    <div class="form-actions">
      <button class="btn" id="cfCheck">${t("Check the file")}</button>
      <button class="btn btn-primary" id="cfGo" disabled>${t("Create the scenario")}</button></div>
    <div id="cfOut"></div>`, { title: t("Import a cashflow projection") });
  $("#cfTpl").onclick = () => {
    const f = $("#cfImp").elements;
    window.location = `/api/templates/oracle-plan?company_id=${f.company_id.value}&year=${f.year.value || state.year}`;
  };
  const send = preview => {
    const fd = new FormData($("#cfImp"));
    if (preview) fd.append("preview", "1");
    return api("/api/plan/import-cashflow", { method: "POST", body: fd });
  };
  const errs = list => `<p class="neg"><b>${t("Nothing was imported — fix these and try again:")}</b></p>
    <ul>${(list || []).map(x => `<li class="neg">${esc(x)}</li>`).join("")}</ul>`;
  $("#cfCheck").onclick = async () => {
    const out = $("#cfOut");
    out.innerHTML = `<p class="muted">${t("Reading the file…")}</p>`;
    try {
      const r = await send(true);
      if (!r.ok) { out.innerHTML = errs(r.errors); $("#cfGo").disabled = true; return; }
      out.innerHTML = cfPreviewHtml(r);
      $("#cfGo").disabled = false;
    } catch (e) { out.innerHTML = `<p class="neg">${esc(e.message)}</p>`; $("#cfGo").disabled = true; }
  };
  $("#cfGo").onclick = async () => {
    try {
      const r = await send(false);
      if (!r.ok) { $("#cfOut").innerHTML = errs(r.errors); return; }
      toast(`${t("Scenario created")}: ${r.name} · ${r.count} ${t("cash items")}`);
      closeModal();
      onDone(r.version_id);
    } catch (e) { toast(e.message, true); }
  };
}

function cfPreviewHtml(r) {
  const net = r.total_in - r.total_out;
  const acc = (r.by_account || []).slice(0, 12);
  return `<div class="mt"><b>${esc(r.sheet)}</b> · ${r.count} ${t("cash items")} · ${r.months.length} ${t("months")}
      (${esc(r.months.map(fmtYM).join(", "))})<br>
      ${t("Money in")} <b class="pos">${fmtRp(r.total_in)}</b> · ${t("Money out")} <b class="neg">${fmtRp(r.total_out)}</b>
      · ${t("Net")} <b class="${net >= 0 ? "pos" : "neg"}">${fmtRp(net)}</b>
      ${r.accounts ? `<br><span class="muted">${t("Money in books to")} ${esc(r.accounts.in)} · ${t("money out to")} ${esc(r.accounts.out)}</span>`
        : `<br><span class="muted">${t("Every row carries its own account and project.")}</span>`}</div>
    ${r.reconciled ? `<p class="pos" style="margin:6px 0 0">&#10003; ${t("The sheet's own weekly balances add up: every week's opening plus its rows equals the next week's opening.")}</p>`
      : (r.checks || []).length ? `<div class="warn mt"><span class="warn-ic">&#9888;</span><span>${t("The sheet does not add up week to week — it still imports, but check these:")}
        <ul style="margin:4px 0 0 16px">${r.checks.map(c => `<li>${esc(c)}</li>`).join("")}</ul></span></div>` : ""}
    ${acc.length ? `<h4 style="margin:12px 0 4px">${t("By account")}</h4>
      <div class="pf-scroll" style="max-height:24vh"><table class="tbl">
        <thead><tr><th>${t("Account")}</th><th>${t("Project")}</th><th class="num">${t("Rows")}</th>
          <th class="num">${t("Money in")}</th><th class="num">${t("Money out")}</th></tr></thead>
        <tbody>${acc.map(x => `<tr><td>${esc(x.code)} <span class="muted">${esc(x.name)}</span></td>
          <td>${x.project ? esc(x.project) : `<span class="muted">${t("company level")}</span>`}</td>
          <td class="num muted">${x.rows}</td>
          <td class="num ${x.in ? "pos" : "muted"}">${x.in ? fmt(x.in) : "—"}</td>
          <td class="num ${x.out ? "neg" : "muted"}">${x.out ? fmt(x.out) : "—"}</td></tr>`).join("")}</tbody></table></div>
      ${(r.by_account || []).length > acc.length ? `<p class="muted" style="font-size:12px">${t("and")} ${(r.by_account || []).length - acc.length} ${t("more accounts")}</p>` : ""}` : ""}
    <h4 style="margin:12px 0 4px">${t("By week")}</h4>
    <div class="pf-scroll" style="max-height:32vh"><table class="tbl">
      <thead><tr><th>${t("Week")}</th><th class="num">${t("Items")}</th><th class="num">${t("Money in")}</th>
        <th class="num">${t("Money out")}</th><th class="num">${t("Net")}</th></tr></thead>
      <tbody>${r.weeks.map(w => `<tr><td>${esc(w.label)}</td><td class="num muted">${w.items.length}</td>
        <td class="num ${w.in ? "pos" : "muted"}">${w.in ? fmt(w.in) : "—"}</td>
        <td class="num ${w.out ? "neg" : "muted"}">${w.out ? fmt(w.out) : "—"}</td>
        <td class="num">${fmt(w.in - w.out)}</td></tr>`).join("")}</tbody></table></div>
    ${(r.warnings || []).length ? `<ul class="muted mt" style="margin-left:18px;font-size:12.5px;line-height:1.6">
      ${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
}

// Progress: what the investment promised, what is ticked off, and the money
// beside it. Weighted, because "pilot signed off" is not half of a rollout.
function invProgressCard(inv) {
  const p = inv.progress || {};
  const committed = inv.committed_amount || 0, paid = inv.invested || 0, outcome = inv.benefit || 0;
  const pct = p.pct == null ? 0 : p.pct;
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="card" style="margin-top:14px;background:var(--panel)">
    <div class="page-head"><h3 style="margin:0">${t("Progress & outcome")}</h3>
      <div class="page-actions muted">${p.milestones
        ? `${p.done}/${p.milestones} ${t("milestones done")}` : t("no milestones yet")}</div></div>
    <div class="bar" style="height:12px"><span style="width:${Math.min(100, pct)}%;background:${pct >= 100 ? "#1f9d57" : "var(--accent)"}"></span></div>
    <div class="muted" style="font-size:12px;margin-top:6px">${p.pct == null
      ? t("Add the milestones this investment must hit — progress is measured against them, not against how much money has left.")
      : `<b>${pct}%</b> ${t("of the weighted plan is done")}`}</div>
    <div class="grid kpis mt">
      <div class="kpi"><div class="kpi-label">${t("Committed")}</div><div class="kpi-value">${fmtShortRp(committed)}</div>
        <div class="kpi-sub">${t("scheduled")} ${fmtShortRp(inv.commitments_total || 0)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Paid so far")}</div><div class="kpi-value">${fmtShortRp(paid)}</div>
        <div class="kpi-sub">${committed ? Math.round(100 * paid / committed) + "% " + t("of committed") : "—"}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Still to pay")}</div>
        <div class="kpi-value">${fmtShortRp(Math.max(0, committed - paid))}</div></div>
      <div class="kpi ${outcome >= paid && paid ? "green" : ""}"><div class="kpi-label">${t("Outcome")}</div>
        <div class="kpi-value">${fmtShortRp(outcome)}</div>
        <div class="kpi-sub">${paid ? Math.round(100 * outcome / paid) + "% " + t("of money spent") : t("nothing spent yet")}</div></div>
    </div>
    <table class="tbl mt"><thead><tr><th style="width:28px"></th><th>${t("Milestone")}</th><th>${t("Due")}</th>
      <th class="num">${t("Weight")}</th>${canWrite() ? "<th></th>" : ""}</tr></thead>
      <tbody>${(inv.milestones || []).map(m => `<tr>
        <td><input type="checkbox" data-ms="${m.id}" ${m.done_at ? "checked" : ""} ${canWrite() ? "" : "disabled"}></td>
        <td>${m.done_at ? `<s class="muted">${esc(m.title)}</s>` : esc(m.title)}</td>
        <td class="${!m.done_at && m.due_date && m.due_date < today ? "neg" : "muted"}">${m.due_date ? esc(fmtDate(m.due_date)) : "—"}${
          !m.done_at && m.due_date && m.due_date < today ? " · " + t("overdue")
          : m.done_at ? " · " + t("done") + " " + esc(fmtDate(m.done_at)) : ""}</td>
        <td class="num muted">${m.weight}</td>
        ${canWrite() ? `<td><button class="btn btn-sm btn-ghost" data-ms-del="${m.id}">&times;</button></td>` : ""}</tr>`).join("")
        || `<tr><td colspan="5" class="empty">${t("No milestones yet")}</td></tr>`}</tbody></table>
    ${canWrite() ? `<div class="filters mt">
      <input id="msTitle" placeholder="${t("Milestone — e.g. pilot signed off")}" style="flex:1;min-width:190px">
      <input id="msDue" type="date" title="${t("Due date")}">
      <input id="msWeight" type="number" min="0" step="0.5" value="1" style="width:84px" title="${t("Weight")}">
      <button class="btn btn-primary" id="msAdd">+ ${t("Add milestone")}</button></div>` : ""}</div>`;
}

function invWireMilestones(iid, reload) {
  $$("#modalRoot [data-ms]").forEach(cb => cb.onchange = async () => {
    try {
      await api(`/api/investments/${iid}/milestones/${cb.dataset.ms}`, {
        method: "PUT", json: { done: cb.checked } });
      reload();
    } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  });
  $$("#modalRoot [data-ms-del]").forEach(b => b.onclick = async () => {
    if (!confirm(t("Remove this milestone?"))) return;
    try {
      await api(`/api/investments/${iid}/milestones/${b.dataset.msDel}`, { method: "DELETE" });
      reload();
    } catch (e) { toast(e.message, true); }
  });
  if ($("#msAdd")) $("#msAdd").onclick = async () => {
    const title = $("#msTitle").value.trim();
    if (!title) { toast(t("Give the milestone a name"), true); return; }
    try {
      await api(`/api/investments/${iid}/milestones`, { json: {
        title, due_date: $("#msDue").value, weight: parseFloat($("#msWeight").value) || 1 } });
      reload();
    } catch (e) { toast(e.message, true); }
  };
}

// A project funded as an investment is not ordinary project work: its payments
// are a commitment the Oracle already counts, so the project shows that same
// schedule instead of inviting a second, disagreeing one.
function invOnProjectCard(inv) {
  if (!inv) return "";
  const p = inv.progress || {};
  const rows = (inv.commitments || []).map(c => `<tr>
    <td>W${c.week} ${MONTH_NAMES[c.month - 1]} ${c.year}</td><td>${esc(c.note || "—")}</td>
    <td><span class="pill ${CERTAINTY_PILL[c.certainty] || "inactive"}">${esc(c.certainty)}</span></td>
    <td class="num">${fmt(c.amount)}</td></tr>`).join("");
  return `<div class="card" style="margin-bottom:12px;border-color:var(--accent)">
    <div class="page-head"><h3 style="margin:0"><span class="pill posted">${t("INVESTMENT")}</span> ${esc(inv.name)}</h3>
      <div class="page-actions"><button class="btn btn-sm" id="prjInvOpen" data-inv="${inv.id}">${t("Open in Investment Center")} &rarr;</button></div></div>
    <p class="muted" style="margin-top:-4px">${t("This project is funded as an investment. Its payments are planned in the Investment Center, and the Oracle already counts them as cash leaving on those weeks.")}</p>
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">${t("Committed")}</div><div class="kpi-value">${fmtShortRp(inv.committed_amount || 0)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Paid so far")}</div><div class="kpi-value">${fmtShortRp(inv.invested || 0)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Outcome")}</div><div class="kpi-value">${fmtShortRp(inv.benefit || 0)}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Progress")}</div>
        <div class="kpi-value">${p.pct == null ? "—" : p.pct + "%"}</div>
        <div class="kpi-sub">${p.milestones ? `${p.done}/${p.milestones} ${t("milestones done")}` : t("no milestones yet")}</div></div>
    </div>
    <h4 style="margin:12px 0 4px">${t("Cashflow payments")}</h4>
    <table class="tbl"><thead><tr><th>${t("Week")}</th><th>${t("What")}</th><th>${t("Certainty")}</th>
      <th class="num">${t("Amount")}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">${t("No payment schedule yet — set one in the Investment Center so the Oracle knows when this money leaves.")}</td></tr>`}
      ${inv.unscheduled ? `<tr class="total"><td colspan="3">${t("Committed but not scheduled")}</td>
        <td class="num neg">${fmt(inv.unscheduled)}</td></tr>` : ""}</tbody></table></div>`;
}

/* ------------------------------------------------------------ v1.10 additions */

const FONT_SIZES = [["small", "Small"], ["normal", "Normal"], ["large", "Large"], ["xlarge", "Extra large"]];

function currentFontSize() {
  try { return localStorage.getItem("erp.fontsize") || "normal"; } catch (e) { return "normal"; }
}

function applyFontSize(v) {
  document.documentElement.dataset.fontsize = v;
  try { localStorage.setItem("erp.fontsize", v); } catch (e) { /* private window */ }
}

async function settingsDisplay(body) {
  const draw = () => {
    const cur = currentFontSize();
    body.innerHTML = `<div class="card"><h3>${t("Reading size")}</h3>
      <p class="muted" style="margin-top:-6px">${t("Everything scales together — text, tables and charts — so columns keep lining up. Saved on this device, for every database you open.")}</p>
      <div class="seg-group" id="fsPick">${FONT_SIZES.map(([k, l]) =>
        `<button class="seg ${cur === k ? "active" : ""}" data-fs="${k}">${t(l)}</button>`).join("")}</div>
      <div class="card mt" style="background:var(--panel)">
        <div class="kpi-label">${t("Sample")}</div>
        <div style="font-size:20px;font-weight:700">Rp 1.234.567.890</div>
        <p class="muted" style="margin:4px 0 0">${t("This is how the app reads at this size.")}</p>
      </div></div>`;
    $$("#fsPick .seg").forEach(btn => btn.onclick = () => { applyFontSize(btn.dataset.fs); draw(); });
  };
  draw();
}

// Contract value, what it cost to deliver, and what is left - the shape finance
// already keeps by hand. COGS here is EVERY cost account tagged to the project
// (5000 and 6000 alike), which is the same figure the project screen shows:
// counting only the 5000 family reported no cost at all on a real ledger.
function phContractTable(rows) {
  const val = r => (r.contract_value || 0) || (r.budget_revenue || 0);
  const list = rows.filter(r => val(r) || r.revenue || r.expense).sort((x, y) => val(y) - val(x));
  const totals = {};
  list.forEach(r => Object.values(r.cost_by || {}).forEach(a => {
    totals[a.code] = { code: a.code, name: a.name, amount: (totals[a.code] || { amount: 0 }).amount + a.amount };
  }));
  const cols = Object.values(totals).sort((x, y) => y.amount - x.amount).slice(0, 5);
  const cogsOf = (r, code) => ((r.cost_by || {})[code] || {}).amount || 0;
  const other = r => round2((r.expense || 0) - cols.reduce((a, c) => a + cogsOf(r, c.code), 0));
  const anyOther = list.some(r => Math.abs(other(r)) > 0.5);
  const sum = f => round2(list.reduce((a, r) => a + (f(r) || 0), 0));
  const tContract = sum(val), tRev = sum(r => r.revenue), tCogs = sum(r => r.expense);
  const tGp = round2(tRev - tCogs);
  const cell = (v, cls) => `<td class="num ${cls || ""}">${v ? fmt(v) : "—"}</td>`;
  const colTitle = c => `${c.code} ${c.name}`;
  return `<div class="card"><h3>${t("Contract value · COGS · Gross profit")}
      <span class="muted" style="font-weight:500;font-size:13px">· ${t("per project")} · IDR ${state.year}</span></h3>
    <p class="muted" style="margin-top:-6px">${t("Contract value is what the project was sold for (set it on the project; blank falls back to its revenue budget). COGS is every cost account tagged to the project — the 5000 and 6000 families alike — so it matches the project's own expense figure. Gross profit is realized revenue less that cost.")}</p>
    <div class="ph-gp-scroll"><table class="tbl">
      <thead><tr><th style="width:34px">#</th><th>${t("Project")}</th><th>${t("Company")}</th>
        <th class="num contract">${t("Contract value")}</th><th class="num">${t("Revenue realized")}</th>
        ${cols.map(c => `<th class="num cogs" title="${esc(colTitle(c))}">${esc(c.code)}</th>`).join("")}
        ${anyOther ? `<th class="num cogs">${t("Other COGS")}</th>` : ""}
        <th class="num cogs">${t("COGS total")}</th><th class="num">${t("Gross profit")}</th>
        <th class="num">${t("Margin")}</th></tr></thead>
      <tbody>${list.map((r, i) => {
        const contract = val(r), gp = round2((r.revenue || 0) - (r.expense || 0));
        const margin = r.revenue ? Math.round(1000 * gp / r.revenue) / 10 : null;
        return `<tr><td class="muted">${i + 1}</td>
          <td><b>${esc(r.code)}</b> ${esc(r.name)}${r.contract_value ? "" : contract ? ` <span class="muted" title="${t("no contract value set — showing the revenue budget")}">*</span>` : ""}</td>
          <td>${esc(r.company || "")}</td>
          ${cell(contract, "contract")}${cell(r.revenue)}
          ${cols.map(c => cell(cogsOf(r, c.code), "cogs")).join("")}
          ${anyOther ? cell(other(r), "cogs") : ""}
          ${cell(r.expense, "cogs")}
          <td class="num ${gp >= 0 ? "pos" : "neg"}"><b>${fmt(gp)}</b></td>
          <td class="num ${margin != null && margin < 0 ? "neg" : ""}">${margin == null ? "—" : margin + "%"}</td></tr>`;
      }).join("") || `<tr><td colspan="${7 + cols.length + (anyOther ? 1 : 0)}" class="empty">${t("No contract value, revenue or COGS on any project yet.")}</td></tr>`}
      ${list.length ? `<tr class="total"><td></td><td>${t("TOTAL")}</td><td></td>
        <td class="num contract">${fmt(tContract)}</td><td class="num">${fmt(tRev)}</td>
        ${cols.map(c => `<td class="num cogs">${fmt(sum(r => cogsOf(r, c.code)))}</td>`).join("")}
        ${anyOther ? `<td class="num cogs">${fmt(sum(other))}</td>` : ""}
        <td class="num cogs">${fmt(tCogs)}</td>
        <td class="num ${tGp >= 0 ? "pos" : "neg"}"><b>${fmt(tGp)}</b></td>
        <td class="num">${tRev ? Math.round(1000 * tGp / tRev) / 10 + "%" : "—"}</td></tr>` : ""}</tbody></table></div>
    ${list.some(r => !r.contract_value && val(r)) ? `<p class="muted" style="font-size:12px">* ${t("no contract value set on the project — its revenue budget is shown instead")}</p>` : ""}</div>`;
}
