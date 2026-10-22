// MORES HV terminal pages (/ and /login): the local clock and the LOW / HIGH
// display level, remembered on this desk. The level itself is set by an inline
// line in each page's <head> before the first paint, so nothing flashes.
(function () {
  const clock = document.getElementById("clock");
  function tick() {
    if (!clock) return;
    const d = new Date(), p = n => String(n).padStart(2, "0");
    clock.textContent = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  tick(); setInterval(tick, 1000);

  function setLevel(v) {
    document.documentElement.dataset.level = v;
    document.querySelectorAll(".level button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.level === v)));
    try { localStorage.setItem("erp.termLevel", v); } catch (_) {}
  }
  document.querySelectorAll(".level button").forEach(b => b.onclick = () => setLevel(b.dataset.level));
  setLevel(document.documentElement.dataset.level === "low" ? "low" : "high");

  // a line marked data-type types itself once (skipped when less motion is asked)
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-type]").forEach(el => {
    if (reduced) return;
    const text = el.textContent;
    el.textContent = "";
    let i = 0;
    const step = () => { el.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, 38); };
    setTimeout(step, 450);
  });
})();
