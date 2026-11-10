/* MORES RAB ROT - single-page app (the look and parts of MORES HV, standalone).
   Pages: Cost plans (the RAB ROT form), People & grades, Scheme. Every figure
   is worked out by the local server (rab_rot.py); the page shows it. */
"use strict";
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const t = s => s;                       // English UI; kept so the HV parts read the same
const state = { rabEdit: null };
const canWrite = () => true;            // one person, one computer
const isAdmin = () => true;

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


function fmtDate(v) {
  if (v == null || v === "") return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}

async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
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

const REMU_TYPES = [["t1", "Type 1 — partner deal"], ["t2", "Type 2 — Finance sets PM"], ["t3", "Type 3"], ["stp", "STP — BOD-defined"]];
const REMU_ROLES = { pm: "Project Manager", team: "Team member", bringer: "Bringer", partner: "Partner", bod: "BOD" };
const REMU_KIND = { pool: "Team pool", partner: "Partner share", bod: "BOD share", bringer: "Bringer fee" };
const remuPct = v => v == null ? "—" : `${String(Math.round(v * 1000) / 10).replace(".", ",")}%`;
const remuGrade = (cfg, g) => { const x = cfg.grades.find(y => y.grade === g) || {}; return `${x.code || "G" + g} · ${t(x.title || "")}`; };

/* ---- RAB ROT: the project cost plan behind the remuneration (v1.13) ---------- */
// The "PROJECT RAB ROT ACTUAL" Excel sheet as a form. Every figure is worked
// out by the server (rab_rot.py) - the form sends what was typed and shows
// what comes back, so the screen, the PDF and the tests share one formula.
const RAB_STATUS = { draft: "Draft", review: "In review", approved: "Approved" };
const RAB_SIGNAL = { green: ["GREEN", "posted"], amber: ["AMBER", "draft"], red: ["RED", "bad"], none: ["—", ""] };
const rabNum = s => {
  if (typeof s === "number") return s;
  let v = String(s || "").replace(/Rp|\s/g, "");
  if (!v) return 0;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v) || /,\d{1,2}$/.test(v)) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const rabPct = v => v == null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`;
const rabSignal = s => { const [l, c] = RAB_SIGNAL[s] || RAB_SIGNAL.none; return `<span class="pill ${c} rab-sig">${l}</span>`; };

async function remuRab(body, reload) {
  if (state.rabEdit != null) return rabEditor(body, reload);
  const rows = await api("/api/plans");
  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const cnt = s => rows.filter(r => r.signal === s).length;
  body.innerHTML = `
    <div class="grid kpis">
      <div class="kpi"><div class="kpi-label">${t("Cost plans")}</div><div class="kpi-value">${rows.length}</div>
        <div class="kpi-sub">${rows.filter(r => r.status === "approved").length} ${t("approved")}</div></div>
      <div class="kpi hl"><div class="kpi-label">${t("Project value")}</div><div class="kpi-value">${fmtShortRp(sum("value"))}</div>
        <div class="kpi-sub">${t("incl. tax, every plan")}</div></div>
      <div class="kpi"><div class="kpi-label">${t("Net project value")}</div><div class="kpi-value">${fmtShortRp(sum("net"))}</div></div>
      <div class="kpi orange"><div class="kpi-label">${t("Reviewed COGS")}</div><div class="kpi-value">${fmtShortRp(sum("review_cogs"))}</div></div>
      <div class="kpi green"><div class="kpi-label">${t("Nilai cuan (NCT)")}</div><div class="kpi-value">${fmtShortRp(sum("net") - sum("review_cogs"))}</div>
        <div class="kpi-sub">${cnt("green")} ${t("green")} · ${cnt("amber")} ${t("amber")} · ${cnt("red")} ${t("red")}</div></div>
    </div>
    <div class="card"><div class="page-head" style="margin-bottom:10px"><h3 style="margin:0">${t("RAB ROT — project cost plans")}
        <span class="muted" style="font-weight:500">· ${t("fill it like the Excel sheet — the margin it leaves feeds the remuneration")}</span></h3>
      ${canWrite() ? `<div class="page-actions"><label class="btn btn-sm" title="${t("A sheet laid out like PROJECT RAB ROT ACTUAL")}">&#x2912; ${t("Import Excel")}
          <input type="file" id="rabFile" accept=".xlsx,.xlsm" hidden></label>
        <button class="btn btn-sm btn-primary" id="rabNew">+ ${t("New plan")}</button></div>` : ""}</div>
      <div class="pf-scroll"><table class="tbl rab-list"><thead><tr><th>${t("Project")}</th><th>${t("Company")}</th><th>${t("Status")}</th>
        <th class="num">${t("Project value")}</th><th class="num">${t("Net value")}</th><th class="num">${t("COGS (reviewed)")}</th>
        <th class="num">${t("NCT")}</th><th>${t("Signal")}</th><th>${t("Updated")}</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr class="clickable" data-id="${r.id}">
          <td><b>${esc(r.name)}</b>${r.year ? ` <span class="muted" style="font-size:11.5px">${r.year}</span>` : ""}</td>
          <td>${esc(r.company || "—")}${r.client ? `<br><span class="muted" style="font-size:11.5px">${esc(r.client)}</span>` : ""}</td>
          <td><span class="pill ${r.status === "approved" ? "posted" : "draft"}">${t(RAB_STATUS[r.status] || r.status)}</span></td>
          <td class="num">${fmtShortRp(r.value)}</td><td class="num">${fmtShortRp(r.net)}</td>
          <td class="num">${fmtShortRp(r.review_cogs)}</td>
          <td class="num"><b>${fmtShortRp(r.nct)}</b><br><span class="muted" style="font-size:11px">${rabPct(r.review_margin)}</span></td>
          <td>${rabSignal(r.signal)}</td>
          <td class="muted" style="font-size:12px">${esc(fmtDate(r.updated_at))}${r.prepared_by ? `<br>${esc(r.prepared_by)}` : ""}</td>
          <td style="white-space:nowrap"><a class="btn btn-sm" href="/api/plans/${r.id}/pdf" target="_blank" data-stop>&#128196; PDF</a>
            <button class="btn btn-sm" data-copy="${r.id}" data-stop title="${t("New draft from this plan")}">${t("Copy")}</button></td></tr>`).join("")
          || `<tr><td colspan="10" class="empty">${t("No cost plan yet — start a new one or import the Excel sheet.")}</td></tr>`}</tbody></table></div></div>`;
  $$("#rmBody tr[data-id]").forEach(tr => tr.onclick = e => {
    if (e.target.closest("[data-stop]")) return;
    state.rabEdit = parseInt(tr.dataset.id, 10); reload();
  });
  $$("#rmBody [data-copy]").forEach(b => b.onclick = async () => {
    try { const r = await api(`/api/plans/${b.dataset.copy}/copy`, { method: "POST" }); toast(t("Copied — a new draft")); state.rabEdit = r.id; reload(); }
    catch (e) { toast(e.message, true); }
  });
  if ($("#rabNew")) $("#rabNew").onclick = () => { state.rabEdit = "new"; reload(); };
  if ($("#rabFile")) $("#rabFile").onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Import failed");
      toast(`${t("Imported")}: ${d.lines} ${t("cost lines")}, ${d.entities} PT`);
      state.rabEdit = d.id; reload();
    } catch (err) { toast(err.message, true); }
  };
}

async function rabEditor(body, reload) {
  const isNew = state.rabEdit === "new";
  const [res, people, cfg] = await Promise.all([
    isNew ? api("/api/blank") : api(`/api/plans/${state.rabEdit}`),
    api("/api/people").catch(() => []),
    api("/api/config"),
  ]);
  const meta = res.plan || { status: "draft", company: "", prepared_by: localStorage.getItem("rr.preparedBy") || "" };
  const D = res.data;
  let calc = res.calc, remu = res.remu, dirty = false, timer = null;
  const ro = !canWrite();
  const back = () => { state.rabEdit = null; reload(); };

  const moneyIn = (val, attrs) => `<input class="rab-money" ${attrs} value="${val == null || val === "" ? "" : fmt(val)}" ${ro ? "disabled" : ""} inputmode="decimal">`;
  const numIn = (val, attrs, w = 40) => `<input class="rab-num" type="number" step="any" min="0" ${attrs} value="${val}" style="width:${w}px" ${ro ? "disabled" : ""}>`;
  const txtIn = (val, attrs, ph = "") => `<input class="rab-txt" ${attrs} value="${esc(val || "")}" placeholder="${esc(ph)}" ${ro ? "disabled" : ""}>`;

  // the lines as the sheet shows them: sections, then groups, then lines
  function linesHtml() {
    let h = "";
    [["A", "BIAYA LANGSUNG PERSONIL"], ["B", "BIAYA LANGSUNG NON PERSONIL"]].forEach(([sec, title]) => {
      const S = (calc.sections || []).find(x => x.key === sec) || { total: 0, reviewed: 0 };
      h += `<tr class="section"><td>${sec}.</td><td colspan="6">${t(title)}</td>
        <td class="num" data-c="sec${sec}">${fmt(S.total)}</td><td></td><td class="num" data-c="secr${sec}">${fmt(S.reviewed)}</td><td colspan="2">
        ${ro ? "" : `<button class="btn btn-sm rab-addgrp" data-sec="${sec}" title="${t("Add a group, e.g. Biaya Tenaga Ahli")}">+ ${t("group")}</button>`}</td></tr>`;
      const idx = D.lines.map((l, i) => [l, i]).filter(([l]) => l.section === sec);
      const groups = [];
      idx.forEach(([l, i]) => { if (!groups.length || groups[groups.length - 1].name !== l.group) groups.push({ name: l.group, items: [] }); groups[groups.length - 1].items.push([l, i]); });
      if (!groups.length) groups.push({ name: "", items: [] });
      let n = 0;
      groups.forEach((g, gi) => {
        const first = g.items.length ? g.items[0][1] : -1;
        h += `<tr class="rab-grp"><td class="muted">${g.name ? gi + 1 : ""}</td><td colspan="9">${ro ? `<b>${esc(g.name)}</b>`
          : `<input class="rab-gname" data-sec="${sec}" data-g="${esc(g.name)}" value="${esc(g.name)}" placeholder="${t("Group (optional)")}">`}</td>
          <td colspan="2">${ro ? "" : `<button class="btn btn-sm rab-addline" data-sec="${sec}" data-g="${esc(g.name)}" data-after="${g.items.length ? g.items[g.items.length - 1][1] : ""}">+ ${t("line")}</button>`}</td></tr>`;
        g.items.forEach(([l, i]) => {
          const c = (calc.lines || [])[i] || {};
          const no = g.name ? "abcdefghijklmnopqrstuvwxyz"[n % 26] : n + 1; n++;
          const diff = l.review == null ? 0 : l.review - (c.total || 0);
          h += `<tr data-i="${i}"><td class="muted">${no}</td>
            <td>${txtIn(l.label, `data-k="label"`, t("Jenis biaya"))}</td>
            <td>${txtIn(l.name, `data-k="name"`, t("Nama"))}</td>
            <td>${numIn(l.qty, `data-k="qty"`)}</td><td>${numIn(l.sat, `data-k="sat"`)}</td><td>${numIn(l.vol, `data-k="vol"`)}</td>
            <td>${moneyIn(l.unit_price, `data-k="unit_price"`)}</td>
            <td class="num" data-c="t${i}"><b>${fmt(c.total)}</b></td>
            <td class="num muted" data-c="p${i}">${rabPct(c.pct_cogs)}</td>
            <td>${moneyIn(l.review, `data-k="review" placeholder="${t("as plan")}" data-diff="${diff > 0.5 ? "up" : diff < -0.5 ? "down" : ""}"`)}</td>
            <td>${txtIn(l.review_note, `data-k="review_note"`, t("Finance note"))}</td>
            <td>${ro ? "" : `<button class="btn btn-sm btn-danger rab-del" title="${t("Remove line")}">&times;</button>`}</td></tr>`;
        });
      });
    });
    return h;
  }

  function sideHtml() {
    const R = calc.review, sig = RAB_SIGNAL[R.status] || RAB_SIGNAL.none;
    const row = (l, v, p, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="num">${fmt(v)}</td><td class="num muted">${p == null ? "" : rabPct(p)}</td></tr>`;
    const S = remu.scheme;
    const nm = id => (people.find(p => p.id === id) || {}).name || "?";
    return `
      <div class="rab-signal ${R.status}"><div><div class="kpi-label">${t("Finance review")}</div>
          <div class="rab-sig-big">${sig[0]}</div></div>
        <div style="text-align:right"><div class="kpi-label">${t("NCT on review")}</div><div class="rab-sig-val">${fmtShortRp(R.nct)}</div>
          <div class="kpi-sub">${rabPct(R.margin)} · ${t("green from")} ${rabPct(R.green_at)}${R.scheme ? ` (${esc(t(R.scheme))} ${t("min GP")})` : ""}</div></div></div>
      <div class="card rab-card"><h3>${t("Cost & margin")} <span class="muted" style="font-weight:500">· ${t("% of net value")}</span></h3>
        <table class="tbl rab-sum"><tbody>
          ${row(t("Total cost awal"), calc.cost_awal)}
          ${row(t("Maksimal (belum tax)"), calc.contingency)}
          ${row(t("Total cost COGS"), calc.cogs, calc.pct.cogs, "total")}
          ${row(`${t("Service fee")} (${rabPct(D.rates.service_fee)})`, calc.service_fee, calc.pct.service_fee)}
          ${row(`${t("Project saving fee PSC")} (${rabPct(D.rates.psc)})`, calc.psc, calc.pct.psc)}
          ${row(t("Profit element"), calc.profit, calc.pct.profit, calc.profit < 0 ? "neg-row" : "")}
          ${row(t("Total project cost"), calc.total_project_cost, calc.pct.total, "total")}
          <tr class="rab-nct"><td>${t("Nilai cuan terprediksi")}</td><td class="num">${fmt(calc.nct)}</td><td class="num">${rabPct(calc.nct_pct)}</td></tr>
        </tbody></table></div>
      <div class="card rab-card"><h3>${t("Project value")} <span class="muted" style="font-weight:500">· ${t("net of tax")}</span></h3>
        <table class="tbl rab-sum"><tbody>
          ${row(t("Project value (incl. tax)"), calc.value, null, "total")}
          ${row(`PPN ${rabPct(D.rates.ppn)}`, -calc.ppn)}
          ${row(`PPh 23 ${rabPct(D.rates.pph23)} ${calc.tax_method === "dpp" ? t("of DPP") : t("(sheet formula)")}`, -calc.pph23)}
          ${row(t("Net project value"), calc.net, null, "total")}
          ${calc.entities.map(e => `<tr><td class="muted">&nbsp;&nbsp;${esc(e.name || "PT")} <span style="font-size:11px">${rabPct(e.share)}</span></td>
            <td class="num">${fmt(e.net)}</td><td></td></tr>`).join("")}
        </tbody></table>
        ${calc.tax_method === "dpp" && Math.abs(calc.net - calc.excel_net) > 1 ? `<p class="muted rab-hint">${t("The old sheet formula (PPh 23 = value × 2/102) would give")} ${fmtRp(calc.excel_net)} —
          ${fmtRp(calc.net - calc.excel_net)} ${t("less. PPh 23 is withheld on DPP, so this form uses")} ${(calc.net_factor * 100).toFixed(2).replace(".", ",")}%.</p>` : ""}</div>
      <div class="card rab-card"><h3>${t("Remuneration preview")} <span class="muted" style="font-weight:500">· ${S ? esc(t(S.label)) : t("no scheme")}</span></h3>
        <div class="rab-remu">
          <div><span>${t("GP")}</span><b>${fmtShortRp(remu.gp)}</b></div>
          <div><span>${t("Office")}</span><b>${fmtShortRp(remu.office_net)}</b></div>
          <div><span>${t("Team pool")}</span><b>${fmtShortRp(remu.pool)}</b></div>
          <div><span>${t("Partner / BOD")}</span><b>${fmtShortRp((remu.partner || 0) + (remu.bod || 0))}</b></div>
          <div><span>${t("Bringer")}</span><b>${fmtShortRp(remu.bringer)}</b></div></div>
        ${remu.payouts.length ? `<table class="tbl rs-tbl"><tbody>${remu.payouts.map(po => `<tr><td>${esc(nm(po.person_id))}</td>
          <td class="muted">${esc(t(REMU_KIND[po.kind] || po.kind))}</td><td class="num"><b>${fmtShortRp(po.amount)}</b></td></tr>`).join("")}</tbody></table>`
          : `<p class="muted rab-hint">${t("Add the team below to see each person's share.")}</p>`}
        ${remu.notes.map(n => `<p class="muted rab-hint">${esc(t(n))}</p>`).join("")}
        <p class="muted rab-hint">${t("GP here = net project value − reviewed COGS. The payout itself is made on the project's actual ledger GP.")}</p></div>`;
  }

  function render() {
    body.innerHTML = `
      <div class="page-head rab-head">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" id="rabBack">&larr; ${t("All plans")}</button>
          <h3 style="margin:0">${esc(D.project_name || t("New cost plan"))}</h3>
          <span class="pill ${meta.status === "approved" ? "posted" : "draft"}">${t(RAB_STATUS[meta.status] || meta.status)}</span>
          <span class="muted" id="rabDirty" style="font-size:12px"></span></div>
        <div class="page-actions">
          ${!isNew ? `<a class="btn btn-sm" href="/api/plans/${state.rabEdit}/pdf" target="_blank" id="rabPdf">&#128196; ${t("Download PDF")}</a>` : ""}
          ${!ro && !isNew ? `<button class="btn btn-sm btn-danger" id="rabDelete">${t("Delete")}</button>` : ""}
          ${ro ? "" : `<button class="btn btn-sm btn-primary" id="rabSave">${isNew ? t("Create plan") : t("Save")}</button>`}</div></div>
      <div class="rab-layout">
        <div class="rab-form">
          <div class="card"><h3>${t("Project")}</h3>
            <div class="rab-fields">
              <label class="w2">${t("Project name")} ${txtIn(D.project_name, `id="rfName"`, "OUTLOOK PAREKRAF JAKARTA 2027")}</label>
              <label>${t("Year")} <input id="rfYear" type="number" value="${D.year}" ${ro ? "disabled" : ""}></label>
              <label>${t("Status")} <select id="rfStatus" ${ro ? "disabled" : ""}>${Object.entries(RAB_STATUS).map(([k, l]) =>
                `<option value="${k}" ${meta.status === k ? "selected" : ""}>${t(l)}</option>`).join("")}</select></label>
              <label class="w2">${t("Client / owner")} ${txtIn(D.client, `id="rfClient"`, "Dinas Pariwisata")}</label>
              <label>${t("Company / PT")} ${txtIn(meta.company, `id="rfCompany"`, "PT Mores")}</label>
              <label>${t("Remuneration scheme")} <select id="rfType" ${ro ? "disabled" : ""}><option value="">—</option>${REMU_TYPES.map(([k, l]) =>
                `<option value="${k}" ${D.remu_type === k ? "selected" : ""}>${esc(t(l))}</option>`).join("")}</select></label>
              <label class="w2">${t("Prepared by")} ${txtIn(meta.prepared_by, `id="rfBy"`, t("Your name — printed on the PDF"))}</label>
            </div></div>

          <div class="card mt"><h3>${t("Cost lines")} <span class="muted" style="font-weight:500">· ${t("Harga Satuan (+tax) × JMLH × SAT × VOL")}</span></h3>
            <div class="pf-scroll"><table class="tbl rab-lines"><thead><tr><th>${t("No")}</th><th>${t("Jenis biaya")}</th><th>${t("Nama")}</th>
              <th class="num">JMLH</th><th class="num">SAT</th><th class="num">VOL</th><th class="num">${t("Harga satuan (+tax)")}</th>
              <th class="num">${t("Total transfer")}</th><th class="num">% COGS</th><th class="num">${t("Finance review")}</th><th>${t("Note")}</th><th></th></tr></thead>
              <tbody id="rabLines">${linesHtml()}</tbody>
              <tfoot><tr class="total"><td></td><td colspan="6">${t("TOTAL COST AWAL")}</td><td class="num" data-c="awal">${fmt(calc.cost_awal)}</td><td></td>
                <td class="num" data-c="rcogs">${fmt(calc.review.cogs - calc.contingency)}</td><td colspan="2"></td></tr></tfoot></table></div>
            <p class="muted rab-hint">${t("Finance review: Finance's own figure for a line (e.g. with PPh 21 on top). Blank = the line counts as planned; 0 = it is inside another line's review.")}</p></div>

          <div class="card mt"><h3>${t("Project value & rates")}</h3>
            <table class="tbl rab-ent"><thead><tr><th>${t("PT (Total Nilai Anggaran)")}</th><th class="num">${t("Value incl. tax")}</th><th class="num">${t("Net")}</th><th></th></tr></thead>
              <tbody>${D.entities.map((e, i) => `<tr data-e="${i}"><td>${txtIn(e.name, `data-ek="name"`, "PT 1 : Mores")}</td>
                <td>${moneyIn(e.amount, `data-ek="amount"`)}</td><td class="num" data-c="en${i}">${fmt((calc.entities[i] || {}).net)}</td>
                <td>${ro ? "" : `<button class="btn btn-sm btn-danger rab-edel">&times;</button>`}</td></tr>`).join("")}</tbody>
              <tfoot><tr class="total"><td>${t("Project value")} ${ro ? "" : `<button class="btn btn-sm" id="rabAddEnt" style="margin-left:8px">+ PT</button>`}</td>
                <td class="num" data-c="val">${fmt(calc.value)}</td><td class="num" data-c="net">${fmt(calc.net)}</td><td></td></tr></tfoot></table>
            <div class="rab-fields mt">
              <label>${t("Maksimal (belum tax)")} ${moneyIn(D.contingency, `id="rfCont"`)}</label>
              <label>${t("Service fee %")} <input class="rab-rate" data-r="service_fee" type="number" step="0.5" value="${+(D.rates.service_fee * 100).toFixed(4)}" ${ro ? "disabled" : ""}></label>
              <label>${t("PSC %")} <input class="rab-rate" data-r="psc" type="number" step="0.5" value="${+(D.rates.psc * 100).toFixed(4)}" ${ro ? "disabled" : ""}></label>
              <label>PPN % <input class="rab-rate" data-r="ppn" type="number" step="0.5" value="${+(D.rates.ppn * 100).toFixed(4)}" ${ro ? "disabled" : ""}></label>
              <label>PPh 23 % <input class="rab-rate" data-r="pph23" type="number" step="0.5" value="${+(D.rates.pph23 * 100).toFixed(4)}" ${ro ? "disabled" : ""}></label>
              <label class="w2">${t("PPh 23 basis")} <select id="rfTax" ${ro ? "disabled" : ""}>
                <option value="dpp" ${D.tax_method === "dpp" ? "selected" : ""}>${t("DPP — value before PPN (correct)")}</option>
                <option value="excel" ${D.tax_method === "excel" ? "selected" : ""}>${t("Old sheet formula — value × 2/102")}</option></select></label>
            </div></div>

          <div class="card mt"><h3>${t("Team")} <span class="muted" style="font-weight:500">· ${t("who shares the remuneration — people come from People & grades")}</span></h3>
            <table class="tbl"><thead><tr><th>${t("Person")}</th><th>${t("Role")}</th><th class="num">${t("Involvement %")}</th><th></th></tr></thead>
              <tbody>${D.team.map((m, i) => `<tr data-m="${i}"><td><select class="rab-mk" data-mk="person_id" ${ro ? "disabled" : ""}>${people.map(p =>
                `<option value="${p.id}" ${p.id === m.person_id ? "selected" : ""}>${esc(p.name)} · ${esc(remuGrade(cfg, p.grade))}</option>`).join("")}</select></td>
                <td><select class="rab-mk" data-mk="role" ${ro ? "disabled" : ""}>${Object.entries(REMU_ROLES).map(([k, l]) =>
                  `<option value="${k}" ${m.role === k ? "selected" : ""}>${esc(t(l))}</option>`).join("")}</select></td>
                <td class="num"><input class="rab-mk" data-mk="involvement" type="number" min="1" max="100" value="${m.involvement}" style="width:70px" ${ro ? "disabled" : ""}></td>
                <td>${ro ? "" : `<button class="btn btn-sm btn-danger rab-mdel">&times;</button>`}</td></tr>`).join("")
                || `<tr><td colspan="4" class="empty">${people.length ? t("Nobody on the plan yet.") : t("Add people on the People & grades page first.")}</td></tr>`}</tbody></table>
            ${!ro && people.length ? `<button class="btn btn-sm mt" id="rabAddM">+ ${t("Team member")}</button>` : ""}</div>

          <div class="card mt"><h3>${t("Notes")}</h3>
            <textarea id="rfNotes" rows="3" style="width:100%" ${ro ? "disabled" : ""} placeholder="${t("Anything the approver should know")}">${esc(D.notes || "")}</textarea></div>
        </div>
        <div class="rab-side" id="rabSide">${sideHtml()}</div>
      </div>`;
    bind();
  }

  // only the worked-out figures change while typing; the inputs keep focus
  function paint() {
    const set = (k, v) => { const c = $(`#rmBody [data-c="${k}"]`); if (c) c.innerHTML = v; };
    (calc.lines || []).forEach((c, i) => { set(`t${i}`, `<b>${fmt(c.total)}</b>`); set(`p${i}`, rabPct(c.pct_cogs)); });
    (calc.sections || []).forEach(s => { set(`sec${s.key}`, fmt(s.total)); set(`secr${s.key}`, fmt(s.reviewed)); });
    calc.entities.forEach((e, i) => set(`en${i}`, fmt(e.net)));
    set("awal", fmt(calc.cost_awal)); set("rcogs", fmt(calc.review.cogs - calc.contingency));
    set("val", fmt(calc.value)); set("net", fmt(calc.net));
    $("#rabSide").innerHTML = sideHtml();
  }
  const touch = (full) => {
    dirty = true;
    if ($("#rabDirty")) $("#rabDirty").textContent = t("unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { const r = await api("/api/calc", { json: { data: D } }); calc = r.calc; remu = r.remu; full ? render() : paint(); }
      catch (e) { toast(e.message, true); }
    }, full ? 0 : 220);
  };

  function bind() {
    $("#rabBack").onclick = () => { if (!dirty || confirm(t("Leave without saving?"))) back(); };
    const on = (sel, ev, fn) => $$(sel, body).forEach(x => x.addEventListener(ev, fn));
    on("#rabLines tr[data-i] input", "input", e => {
      const i = +e.target.closest("tr").dataset.i, k = e.target.dataset.k;
      if (k === "review") D.lines[i].review = e.target.value.trim() === "" ? null : rabNum(e.target.value);
      else if (k === "unit_price") D.lines[i][k] = rabNum(e.target.value);
      else if (["qty", "sat", "vol"].includes(k)) D.lines[i][k] = parseFloat(e.target.value) || 0;
      else D.lines[i][k] = e.target.value;
      touch();
    });
    on(".rab-money", "focus", e => { const v = e.target.value; if (v) e.target.value = String(rabNum(v)); });
    on(".rab-money", "blur", e => { const v = e.target.value.trim(); if (v) e.target.value = fmt(rabNum(v)); });
    on(".rab-gname", "change", e => {
      const sec = e.target.dataset.sec, old = e.target.dataset.g;
      D.lines.forEach(l => { if (l.section === sec && l.group === old) l.group = e.target.value.trim(); });
      touch(true);
    });
    on(".rab-addline", "click", e => {
      const b = e.target, after = b.dataset.after === "" ? D.lines.length - 1 : +b.dataset.after;
      D.lines.splice(after + 1, 0, { section: b.dataset.sec, group: b.dataset.g, label: "", name: b.dataset.sec === "B" ? "LS" : "",
        qty: 1, sat: 1, vol: 1, unit_price: 0, review: null, review_note: "" });
      touch(true);
    });
    on(".rab-addgrp", "click", e => {
      const sec = e.target.dataset.sec, name = prompt(t("Group name, e.g. Biaya Tenaga Ahli")) || "";
      const lastIdx = D.lines.map(l => l.section).lastIndexOf(sec);
      const at = lastIdx >= 0 ? lastIdx + 1 : (sec === "A" ? 0 : D.lines.length);
      D.lines.splice(at, 0, { section: sec, group: name.trim(), label: "", name: "", qty: 1, sat: 1, vol: 1, unit_price: 0, review: null, review_note: "" });
      touch(true);
    });
    on(".rab-del", "click", e => { D.lines.splice(+e.target.closest("tr").dataset.i, 1); touch(true); });
    on(".rab-ent tr[data-e] input", "input", e => {
      const i = +e.target.closest("tr").dataset.e, k = e.target.dataset.ek;
      D.entities[i][k] = k === "amount" ? rabNum(e.target.value) : e.target.value; touch();
    });
    on(".rab-edel", "click", e => { D.entities.splice(+e.target.closest("tr").dataset.e, 1); touch(true); });
    if ($("#rabAddEnt")) $("#rabAddEnt").onclick = () => { D.entities.push({ name: `PT ${D.entities.length + 1} : `, amount: 0 }); touch(true); };
    on(".rab-rate", "input", e => { D.rates[e.target.dataset.r] = (parseFloat(e.target.value) || 0) / 100; touch(); });
    if ($("#rfCont")) $("#rfCont").addEventListener("input", e => { D.contingency = rabNum(e.target.value); touch(); });
    if ($("#rfTax")) $("#rfTax").onchange = e => { D.tax_method = e.target.value; touch(); };
    if ($("#rfType")) $("#rfType").onchange = e => { D.remu_type = e.target.value || null; touch(); };
    const meta1 = (id, fn) => { if ($(id)) $(id).addEventListener("input", e => { fn(e.target.value); dirty = true; $("#rabDirty").textContent = t("unsaved changes"); }); };
    meta1("#rfName", v => D.project_name = v);
    meta1("#rfClient", v => D.client = v);
    meta1("#rfYear", v => D.year = parseInt(v, 10) || D.year);
    meta1("#rfNotes", v => D.notes = v);
    if ($("#rfStatus")) $("#rfStatus").onchange = e => { meta.status = e.target.value; dirty = true; };
    meta1("#rfCompany", v => meta.company = v);
    meta1("#rfBy", v => { meta.prepared_by = v; localStorage.setItem("rr.preparedBy", v); });
    on(".rab-mk", "change", e => {
      const i = +e.target.closest("tr").dataset.m, k = e.target.dataset.mk;
      D.team[i][k] = k === "role" ? e.target.value : parseFloat(e.target.value); touch();
    });
    on(".rab-mdel", "click", e => { D.team.splice(+e.target.closest("tr").dataset.m, 1); touch(true); });
    if ($("#rabAddM")) $("#rabAddM").onclick = () => { D.team.push({ person_id: people[0].id, role: D.team.length ? "team" : "pm", involvement: 100 }); touch(true); };
    if ($("#rabSave")) $("#rabSave").onclick = async () => {
      const payload = { name: D.project_name, company: meta.company, prepared_by: meta.prepared_by, status: meta.status, data: D };
      try {
        if (isNew) { const r = await api("/api/plans", { json: payload }); state.rabEdit = r.id; }
        else await api(`/api/plans/${state.rabEdit}`, { method: "PUT", json: payload });
        dirty = false; toast(t("Plan saved")); reload();
      } catch (e) { toast(e.message, true); }
    };
    if ($("#rabPdf")) $("#rabPdf").onclick = e => { if (dirty) { e.preventDefault(); toast(t("Save first — the PDF is made from the saved plan."), true); } };
    if ($("#rabDelete")) $("#rabDelete").onclick = async () => {
      if (!confirm(t("Delete this cost plan?"))) return;
      try { await api(`/api/plans/${state.rabEdit}`, { method: "DELETE" }); toast(t("Deleted")); back(); }
      catch (e) { toast(e.message, true); }
    };
  }
  render();
}


async function remuPeople(body, reload) {
  const [people, cfg] = await Promise.all([api("/api/people"), api("/api/config")]);
  body.innerHTML = `<div class="grid two-col">
    <div class="card"><div class="page-head"><h3 style="margin:0">${t("People")} <span class="muted" style="font-weight:500">· ${people.length}</span></h3>
</div>
      ${canWrite() ? `<div class="filters" style="margin:6px 0 10px"><input id="rmNewName" placeholder="${t("Full name")}" style="min-width:200px">
        <select id="rmNewGrade">${cfg.grades.map(g => `<option value="${g.grade}">${esc(g.code)} — ${esc(t(g.title))}</option>`).join("")}</select>
        <button class="btn btn-primary" id="rmNewAdd">+ ${t("Add person")}</button></div>` : ""}
      <div class="pf-scroll"><table class="tbl"><thead><tr><th>${t("Name")}</th><th>${t("Grade")}</th><th></th></tr></thead>
        <tbody>${people.map(p => { return `<tr class="${p.is_active ? "" : "muted"}">
          <td><b>${esc(p.name)}</b>${p.is_active ? "" : ` <span class="pill inactive">${t("inactive")}</span>`}
            ${p.notes ? `<br><span class="muted" style="font-size:11.5px">${esc(p.notes)}</span>` : ""}</td>
          <td>${esc(remuGrade(cfg, p.grade))}</td>
          <td>${canWrite() ? `<button class="btn btn-sm" data-edit="${p.id}">${t("Edit")}</button>` : ""}</td></tr>`; }).join("")
          || `<tr><td colspan="3" class="empty">${t("No one yet — add the consultants who work on projects.")}</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="page-head"><h3 style="margin:0">${t("Grades")}</h3>
        ${isAdmin() ? `<button class="btn btn-sm btn-primary" id="rmGradeSave">${t("Save")}</button>` : ""}</div>
      <p class="muted" style="margin-top:-6px">${t("A person's points on a project = their grade's weight × their involvement. The team pool is split by points.")}</p>
      <table class="tbl"><thead><tr><th>${t("Grade")}</th><th>${t("Title")}</th><th class="num">${t("Weight")}</th><th class="num">${t("People")}</th></tr></thead>
        <tbody>${cfg.grades.map(g => `<tr><td><b>${esc(g.code)}</b></td>
          <td>${isAdmin() ? `<input class="rm-gt" data-g="${g.grade}" value="${esc(g.title)}">` : esc(t(g.title))}</td>
          <td class="num">${isAdmin() ? `<input class="rm-gw" data-g="${g.grade}" type="number" min="0.1" step="0.1" value="${g.weight}" style="width:80px;text-align:right">` : g.weight}</td>
          <td class="num">${people.filter(p => p.grade === g.grade && p.is_active).length}</td></tr>`).join("")}</tbody></table></div></div>`;
  if ($("#rmNewAdd")) $("#rmNewAdd").onclick = async () => {
    try { await api("/api/people", { json: { name: $("#rmNewName").value, grade: parseInt($("#rmNewGrade").value, 10) } }); toast(t("Person added")); reload(); }
    catch (e) { toast(e.message, true); }
  };
  $$("#rmBody [data-edit]").forEach(b => b.onclick = () => remuPersonModal(people.find(p => p.id == b.dataset.edit), cfg, reload));
  if ($("#rmGradeSave")) $("#rmGradeSave").onclick = async () => {
    const grades = cfg.grades.map(g => ({ grade: g.grade, title: $(`#rmBody .rm-gt[data-g="${g.grade}"]`).value,
      weight: parseFloat($(`#rmBody .rm-gw[data-g="${g.grade}"]`).value) }));
    try { await api("/api/config", { method: "PUT", json: { grades } }); toast(t("Grades saved")); reload(); }
    catch (e) { toast(e.message, true); }
  };
}
function remuPersonModal(p, cfg, reload) {
  openModal(`<div class="form-grid">
      <label class="full">${t("Name")} <input id="rpName" value="${esc(p.name)}"></label>
      <label>${t("Grade")} <select id="rpGrade">${cfg.grades.map(g => `<option value="${g.grade}" ${g.grade === p.grade ? "selected" : ""}>${esc(g.code)} — ${esc(t(g.title))}</option>`).join("")}</select></label>
      <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="rpActive" ${p.is_active ? "checked" : ""} style="width:auto"> ${t("Active")}</label>
      <label class="full">${t("Notes")} <input id="rpNotes" value="${esc(p.notes || "")}"></label></div>
    <div class="form-actions"><button class="btn btn-danger" id="rpDel">${t("Delete")}</button><button class="btn btn-primary" id="rpSave">${t("Save")}</button></div>`,
    { title: t("Edit person"), small: true });
  $("#rpSave").onclick = async () => {
    try { await api(`/api/people/${p.id}`, { method: "PUT", json: { name: $("#rpName").value, grade: parseInt($("#rpGrade").value, 10),
      notes: $("#rpNotes").value, is_active: $("#rpActive").checked } }); toast(t("Saved")); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
  $("#rpDel").onclick = async () => {
    if (!confirm(t("Delete this person? Plans that name them no longer pay them."))) return;
    try { await api(`/api/people/${p.id}`, { method: "DELETE" }); toast(t("Deleted")); closeModal(); reload(); }
    catch (e) { toast(e.message, true); }
  };
}


async function remuScheme(body, reload) {
  const cfg = await api("/api/config");
  const ed = isAdmin();
  const cell = (s, k, txt) => ed && s[k] != null ? `<input class="rm-sc" data-s="${s.key}" data-k="${k}" type="number" step="0.5" min="0" max="100"
      value="${Math.round(s[k] * 1000) / 10}" style="width:70px;text-align:right">%` : (txt != null ? txt : (s[k] == null ? "—" : remuPct(s[k])));
  const poolTxt = s => s.key === "stp" ? `${remuPct(cfg.stp_range[0])}–${remuPct(cfg.stp_range[1])} ${t("of GP")}` : null;
  body.innerHTML = `<div class="card"><div class="page-head"><h3 style="margin:0">${t("Remuneration scheme")} <span class="muted" style="font-weight:500">· ${t("per project")}</span></h3>
      ${ed ? `<button class="btn btn-sm btn-primary" id="rmScSave">${t("Save")}</button>` : ""}</div>
    <p class="muted" style="margin-top:-6px">${t("Shares use GP. Bringer fees use project value.")}</p>
    <div class="pf-scroll"><table class="tbl remu-scheme"><thead><tr><th>${t("Scheme")}</th><th>${t("Project value")}</th><th class="num">${t("Min. GP")}</th>
      <th class="num">${t("Office")}</th><th class="num">${t("Team BONUS pool")}</th><th class="num">${t("Bringer")}</th><th class="num">${t("Partner / BOD")}</th></tr></thead>
      <tbody>${cfg.schemes.map(s => `<tr><td><b>${esc(t(s.label))}</b></td><td>${esc(s.value_label)}</td>
        <td class="num">${cell(s, "min_gp")}</td>
        <td class="num">${cell(s, "office", s.key === "stp" ? t("Not set") : null)}</td>
        <td class="num">${cell(s, "pool", poolTxt(s))}${s.pool_with_bod ? ` <span class="muted">${t("team + BOD")}</span>` : ""}</td>
        <td class="num">${cell(s, "bringer", s.key === "stp" ? t("Not set") : null)}</td>
        <td class="num">${s.partner != null ? `${t("Partner")} ${cell(s, "partner")}` : s.bod != null ? `${t("BOD")} ${cell(s, "bod")}`
          : s.pool_with_bod ? t("Within the pool") : s.key === "stp" ? t("Not set") : "—"}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted mt" style="font-size:12.5px">${t("Type 1: the partner is PM; office fixed at 60%, partner and team negotiate within 40%. Type 2: Finance sets the PM; the project value picks Low (< Rp100m), Medium (Rp100m–Rp1bn) or High (Rp1bn–Rp5bn), and above Rp5bn it is an STP. Type 3: Low below Rp500m, High from Rp500m.")}</p>
    <p class="muted" style="font-size:12.5px">${t("Agent, if used:")} ${ed ? `<input id="rmAgentRate" type="number" step="0.5" min="0" max="100" value="${Math.round(cfg.agent_rate * 1000) / 10}" style="width:70px;text-align:right">%`
      : remuPct(cfg.agent_rate)} ${t("of the project value, from the office's share. Eligibility (min GP) is separate from the bringer award.")}</p></div>`;
  if ($("#rmScSave")) $("#rmScSave").onclick = async () => {
    const schemes = {};
    $$("#rmBody .rm-sc").forEach(i => { (schemes[i.dataset.s] = schemes[i.dataset.s] || {})[i.dataset.k] = i.value === "" ? null : parseFloat(i.value) / 100; });
    try { await api("/api/config", { method: "PUT", json: { schemes, agent_rate: parseFloat($("#rmAgentRate").value) / 100 } }); toast(t("Scheme saved")); reload(); }
    catch (e) { toast(e.message, true); }
  };
}


/* ---- shell ------------------------------------------------------------------ */
const PAGES = {
  plans: ["Cost plans", "the RAB ROT sheet as a form, its margin and the remuneration it pays", remuRab],
  people: ["People & grades", "who can be on a plan's team, and what each grade weighs", remuPeople],
  scheme: ["Scheme", "what each scheme gives the office, the team pool, the bringer and the partner / BOD", remuScheme],
};
async function render() {
  const route = (location.hash || "#/plans").replace("#/", "").split("?")[0];
  const key = PAGES[route] ? route : "plans";
  $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === key));
  const [title, sub, fn] = PAGES[key];
  const el = $("#content");
  el.innerHTML = `<div class="page-head"><h2>${title} <span class="muted" style="font-size:13px;font-weight:500">· ${sub}</span></h2></div>
    <div id="rmBody"><div class="card"><div class="empty">Reading…</div></div></div>`;
  const body = $("#rmBody");
  try { await fn(body, render); }
  catch (e) { body.innerHTML = `<div class="card"><p class="neg">${esc(e.message)}</p></div>`; }
}
function boot() {
  $("#themeBtn").onclick = () => {
    const th = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = th;
    localStorage.setItem("rr.theme", th);
  };
  $$("#nav a").forEach(a => a.addEventListener("click", () => { state.rabEdit = null; }));
  window.addEventListener("hashchange", render);
  render();
}
boot();
