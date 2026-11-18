import "./style.css";
import * as db from "./db.js";
import * as V from "./vision.js";
import { countWithAI, explainError } from "./ai.js";
import { exportPdf, exportXlsx, buildTable, saveAndShare } from "./export.js";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

const PALETTE = ["#34c759", "#0a84ff", "#ff9f0a", "#bf5af2", "#ffd60a", "#64d2ff", "#ff375f", "#30d158", "#5e5ce6", "#ac8e68", "#66d4cf", "#ff6482"];
const RESOLUTIONS = [[1600, "Normale (1600 px)"], [2400, "Alta (2400 px)"], [3200, "Molto alta (3200 px)"], [4000, "Massima (4000 px)"]];
const SETTINGS_VERSION = 2;
const MAX_LEARN = 400; // campioni appresi per articolo in un profilo
const state = { tab: "conta", items: [], sessions: [], profiles: [], settings: { ...V.DEFAULTS, apiKey: "" }, current: null };
const backStack = []; // funzioni per chiudere schermate sovrapposte (tasto Indietro)

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (ts) => new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
const itemById = (id) => state.items.find((i) => i.id === id);
const profileById = (id) => state.profiles.find((p) => p.id === id);
const colorOf = (id) => itemById(id)?.color || "#34c759";
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
const pct = (f) => (f * 100 < 0.01 ? (f * 100).toFixed(4) : (f * 100).toFixed(3)) + "%";

// ---------- piccoli componenti ----------
function toast(msg, ms = 2600) {
  document.querySelectorAll(".toast").forEach((x) => x.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function busy(msg) {
  let b = $("#busy");
  if (!b) { b = document.createElement("div"); b.id = "busy"; document.body.appendChild(b); }
  b.innerHTML = `<div class="spinner"></div><p>${esc(msg)}</p>`;
  b.hidden = false;
}
const done = () => { const b = $("#busy"); if (b) b.hidden = true; };

function overlay(html, cls = "") {
  const el = document.createElement("div");
  el.className = "overlay " + cls;
  el.innerHTML = html;
  document.body.appendChild(el);
  const close = () => { el.remove(); const i = backStack.indexOf(close); if (i >= 0) backStack.splice(i, 1); };
  backStack.push(close);
  return { el, close };
}

function sheet(title, options) {
  return new Promise((resolve) => {
    const { el, close } = overlay(`<div class="sheet"><h3>${esc(title)}</h3>${options
      .map((o, i) => `<button class="btn ${o.cls || ""}" data-i="${i}">${o.dot ? `<span class="dot" style="background:${o.dot}"></span>` : ""}${esc(o.label)}</button>`).join("")}
      <button class="btn ghost" data-i="-1">Annulla</button></div>`, "dim");
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b && e.target !== el) return;
      const i = b ? +b.dataset.i : -1;
      close();
      resolve(i >= 0 ? options[i].value : null);
    });
  });
}

function ask(title, value = "", type = "text") {
  return new Promise((resolve) => {
    const { el, close } = overlay(`<div class="sheet"><h3>${esc(title)}</h3>
      <input class="input" type="${type}" value="${esc(value)}" ${type === "number" ? 'inputmode="numeric" min="0"' : ""}>
      <div class="row"><button class="btn ghost" data-a="no">Annulla</button><button class="btn primary" data-a="ok">OK</button></div></div>`, "dim");
    const inp = $("input", el);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const finish = (ok) => { close(); resolve(ok ? inp.value.trim() : null); };
    el.addEventListener("click", (e) => { const a = e.target.closest("button")?.dataset.a; if (a) finish(a === "ok"); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); });
  });
}

const confirmBox = (title) => sheet(title, [{ label: "Sì, conferma", value: true, cls: "danger" }]);

function pickFiles(accept, { capture = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    if (capture) inp.setAttribute("capture", "environment");
    if (multiple) inp.multiple = true;
    inp.onchange = () => resolve([...inp.files]);
    inp.oncancel = () => resolve([]);
    inp.click();
  });
}

// trova il pezzo toccato su un canvas che mostra un risultato di analisi
function blobAt(canvas, result, e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * canvas.width), y = Math.round(((e.clientY - r.top) / r.height) * canvas.height);
  const R = Math.max(6, Math.round((canvas.width / r.width) * 14)); // ~14 px sullo schermo
  for (let rad = 0; rad <= R; rad += 1) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < result.w && yy < result.h) {
      const l = result.labels[yy * result.w + xx];
      if (l >= 0) return l;
    }
  }
  return -1;
}

// barra zoom per le foto ad alta risoluzione
function zoomBar(box) {
  const bar = document.createElement("div");
  bar.className = "zoombar";
  bar.innerHTML = [1, 2, 4, 8].map((z) => `<button class="${z === 1 ? "on" : ""}" data-z="${z}">${z}×</button>`).join("");
  bar.onclick = (e) => {
    const z = e.target.closest("[data-z]")?.dataset.z;
    if (!z) return;
    const c = $("canvas", box);
    const cx = (box.scrollLeft + box.clientWidth / 2) / box.scrollWidth, cy = (box.scrollTop + box.clientHeight / 2) / box.scrollHeight;
    c.style.width = z * 100 + "%";
    box.scrollLeft = cx * box.scrollWidth - box.clientWidth / 2;
    box.scrollTop = cy * box.scrollHeight - box.clientHeight / 2;
    bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.z === z));
  };
  box.before(bar);
}

// ---------- avvio ----------
async function init() {
  const [items, sessions, profiles, settings] = await Promise.all([db.getAll("items"), db.getAll("sessions"), db.getAll("profiles"), db.getKV("settings", {})]);
  state.items = items.sort((a, b) => a.name.localeCompare(b.name));
  state.sessions = sessions.sort((a, b) => b.created - a.created);
  state.profiles = profiles.sort((a, b) => a.name.localeCompare(b.name));
  state.settings = { ...state.settings, ...settings };
  if (state.settings.ver !== SETTINGS_VERSION) {
    // nuove impostazioni per pezzi piccoli e alta risoluzione
    Object.assign(state.settings, { minArea: V.DEFAULTS.minArea, resolution: V.DEFAULTS.resolution, ver: SETTINGS_VERSION });
    saveSettings();
  }
  render();
}
let backReady = false;
function setupBack() {
  if (backReady || !Capacitor.isNativePlatform()) return;
  backReady = true;
  App.addListener("backButton", () => {
    if (backStack.length) backStack[backStack.length - 1]();
    else if (state.current) { state.current = null; render(); }
    else if (state.tab !== "conta") { state.tab = "conta"; render(); }
    else App.exitApp();
  });
}

const saveSettings = () => db.setKV("settings", state.settings);

function render() {
  setupBack();
  const app = $("#app");
  const tabs = [
    ["conta", "Conta", "M4 6h16M4 12h16M4 18h10"],
    ["profili", "Profili", "M12 3l8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4"],
    ["catalogo", "Catalogo", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
    ["impostazioni", "Impostazioni", "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2M19 12h2M12 3v2M12 19v2"],
  ];
  app.innerHTML = `<main id="main"></main>
    <nav class="tabs">${tabs.map(([k, l, d]) => `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}"><svg viewBox="0 0 24 24"><path d="${d}"/></svg>${l}</button>`).join("")}</nav>`;
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; render(); }));
  const main = $("#main");
  if (state.tab === "conta") state.current ? renderSession(main) : renderSessions(main);
  else if (state.tab === "profili") renderProfiles(main);
  else if (state.tab === "catalogo") renderCatalog(main);
  else renderSettings(main);
}

// impostazioni di analisi per un conteggio (con o senza profilo)
function analysisSetup(profile) {
  const models = V.buildModels(state.items, profile);
  const opts = V.profileOptions(profile, models, state.settings);
  const res = profile?.opts?.resolution || state.settings.resolution;
  return { profile, models, opts, res };
}

async function chooseProfile(current) {
  if (!state.profiles.length) return { id: null };
  const v = await sheet("Profilo di scansione", [
    { label: "Nessun profilo (tutto il catalogo)", value: "none" },
    ...state.profiles.map((p) => ({ label: `${p.name}${p.id === current ? " ✓" : ""}`, value: p.id })),
  ]);
  if (!v) return null;
  return { id: v === "none" ? null : v };
}

// ---------- CONTA ----------
function renderSessions(main) {
  main.innerHTML = `<header><h1>Conteggi</h1></header>
    <button class="btn primary big" id="new">+ Nuovo conteggio</button>
    ${state.items.length ? "" : `<p class="hint warn">Il catalogo è vuoto: aggiungi gli articoli nella scheda <b>Catalogo</b>. Senza catalogo l'app conta i pezzi ma non li distingue.</p>`}
    ${state.items.length && !state.profiles.length ? `<p class="hint">Per pezzi piccoli crea un <b>Profilo</b>: l'app impara dimensione e aspetto reali da una foto di campioni.</p>` : ""}
    <div class="list">${state.sessions.map((s) => {
      const tot = (s.scans || []).reduce((a, sc) => a + sum(sc.counts) + (sc.unknown || 0), 0);
      const pr = profileById(s.profileId);
      return `<button class="card" data-id="${s.id}"><b>${esc(s.name)}</b><small>${fmt(s.created)} · ${(s.scans || []).length} scansioni · ${tot} pezzi${pr ? ` · profilo ${esc(pr.name)}` : ""}</small></button>`;
    }).join("") || `<p class="hint">Nessun conteggio salvato.</p>`}</div>`;
  $("#new").onclick = async () => {
    const name = await ask("Nome del conteggio", `Conteggio ${new Date().toLocaleDateString("it-IT")}`);
    if (!name) return;
    const pr = await chooseProfile(null);
    if (!pr) return;
    const s = { id: db.uid(), name, created: Date.now(), scans: [], profileId: pr.id };
    await db.put("sessions", s);
    state.sessions.unshift(s);
    state.current = s.id;
    render();
  };
  main.querySelectorAll(".card").forEach((c) => (c.onclick = () => { state.current = c.dataset.id; render(); }));
}

function renderSession(main) {
  const s = state.sessions.find((x) => x.id === state.current);
  if (!s) { state.current = null; return render(); }
  const pr = profileById(s.profileId);
  const { head, rows, foot } = buildTable(s, state.items);
  const dotFor = (name) => { const it = state.items.find((i) => i.name === name); return it ? `<span class="dot" style="background:${it.color}"></span>` : ""; };
  main.innerHTML = `<header><button class="icon" id="back">‹</button><h1 id="rename">${esc(s.name)}</h1><button class="icon" id="menu">⋯</button></header>
    <button class="chip" id="prof">Profilo: <b>${pr ? esc(pr.name) : "nessuno (tutto il catalogo)"}</b> ✎</button>
    <div class="actions">
      <button class="btn primary" id="photo">📷 Foto</button>
      <button class="btn primary" id="video">🎥 Video</button>
      <button class="btn" id="gallery">🖼️ Galleria</button>
    </div>
    <p class="hint">Sfondo uniforme e diverso dal colore dei pezzi, luce diffusa, foto dall'alto${pr ? ", alla stessa distanza della foto dei campioni del profilo" : ""}. Ogni scansione diventa una colonna.</p>
    ${s.scans.length ? `<div class="tablewrap"><table>
      <thead><tr>${head.slice(1).filter((_, i) => i !== 1).map((h, i) => `<th ${i >= 1 && i <= s.scans.length ? `data-scan="${i - 1}" class="tap"` : ""}>${esc(h.replace("Scansione ", "S"))}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${dotFor(r[1])}${esc(r[1])}${r[0] ? `<small> ${esc(r[0])}</small>` : ""}</td>${r.slice(3).map((v, i, a) => `<td class="${i === a.length - 1 ? "tot" : ""}">${v}</td>`).join("")}</tr>`).join("")}</tbody>
      <tfoot><tr><td>${esc(foot[1])}</td>${foot.slice(3).map((v) => `<td>${v}</td>`).join("")}</tr></tfoot>
    </table></div>
    <p class="hint">Tocca l'intestazione di una scansione (S1, S2…) per vederla o eliminarla.</p>
    <div class="actions"><button class="btn" id="pdf">⬇ PDF</button><button class="btn" id="xlsx">⬇ Excel</button></div>`
    : `<p class="hint">Nessuna scansione. Inizia con Foto, Video o Galleria.</p>`}`;
  $("#back").onclick = () => { state.current = null; render(); };
  $("#rename").onclick = async () => { const n = await ask("Rinomina conteggio", s.name); if (n) { s.name = n; await db.put("sessions", s); render(); } };
  $("#prof").onclick = async () => { const p = await chooseProfile(s.profileId); if (p) { s.profileId = p.id; await db.put("sessions", s); render(); } else if (!state.profiles.length) toast("Crea prima un profilo nella scheda Profili."); };
  $("#menu").onclick = async () => {
    const v = await sheet(s.name, [{ label: "Rinomina", value: "ren" }, { label: "Elimina conteggio", value: "del", cls: "danger" }]);
    if (v === "ren") $("#rename").click();
    if (v === "del" && (await confirmBox("Eliminare questo conteggio?"))) {
      await db.del("sessions", s.id);
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      state.current = null;
      render();
    }
  };
  $("#photo").onclick = () => startScan(s, "image/*", true);
  $("#video").onclick = () => startScan(s, "video/*", true);
  $("#gallery").onclick = () => startScan(s, "image/*,video/*", false);
  const ex = async (fn) => { try { busy("Preparo il file…"); await fn(s, state.items); } catch (e) { toast("Errore: " + e.message); } finally { done(); } };
  if ($("#pdf")) $("#pdf").onclick = () => ex(exportPdf);
  if ($("#xlsx")) $("#xlsx").onclick = () => ex(exportXlsx);
  main.querySelectorAll("th[data-scan]").forEach((th) => (th.onclick = async () => {
    const i = +th.dataset.scan, sc = s.scans[i];
    const v = await sheet(`Scansione ${i + 1} · ${fmt(sc.date)} · ${sc.method}`, [{ label: "Vedi foto", value: "see" }, { label: "Elimina scansione", value: "del", cls: "danger" }]);
    if (v === "see") { const o = overlay(`<div class="viewer"><img src="${sc.thumb}"><p>${esc(sc.note || "")}</p><button class="btn">Chiudi</button></div>`, "dim"); o.el.onclick = o.close; }
    if (v === "del" && (await confirmBox(`Eliminare la scansione ${i + 1}?`))) { s.scans.splice(i, 1); await db.put("sessions", s); render(); }
  }));
}

function analyzeOne(canvas, setup) {
  return V.classify(V.analyzeCanvas(canvas, setup.opts), setup.models, setup.opts);
}

async function startScan(session, accept, capture) {
  const [file] = await pickFiles(accept, { capture });
  if (!file) return;
  const setup = analysisSetup(profileById(session.profileId));
  try {
    if (file.type.startsWith("video/")) {
      busy("Leggo il video…");
      await nextFrame();
      const frames = await V.videoFrames(file, state.settings.videoFrames, Math.min(setup.res, 1920));
      const results = [];
      for (let i = 0; i < frames.length; i++) {
        busy(`Analizzo il fotogramma ${i + 1} di ${frames.length}…`);
        await nextFrame();
        const r = analyzeOne(frames[i], setup);
        const { counts, unknown } = V.countsOf(r);
        results.push({ canvas: frames[i], result: r, total: sum(counts) + unknown });
      }
      const sorted = [...results].sort((a, b) => a.total - b.total);
      const med = sorted[sorted.length >> 1];
      done();
      review(session, setup, { ...med, method: `Offline (video, ${frames.length} fotogrammi)`, extra: `Pezzi per fotogramma: ${results.map((r) => r.total).join(", ")}. Mostro il fotogramma con il valore mediano.` });
    } else {
      busy(`Analizzo la foto ad alta risoluzione (${setup.res} px)…`);
      await nextFrame();
      const img = await V.loadImage(file);
      const canvas = V.drawToCanvas(img, setup.res);
      const t0 = performance.now();
      const result = analyzeOne(canvas, setup);
      done();
      review(session, setup, { canvas, result, method: "Offline (foto)", ms: performance.now() - t0 });
    }
  } catch (e) {
    done();
    toast("Errore: " + (e.message || e), 4000);
  }
}

// aggiunge al profilo i pezzi singoli confermati di un risultato
function learnInto(profile, result, filter = () => true) {
  profile.learn ||= {};
  let added = 0;
  result.blobs.forEach((b, i) => {
    if (b.ignored || !b.item || b.k !== 1 || b.merged || b.split || !filter(b)) return;
    if (!profile.itemIds.includes(b.item)) return;
    const e = (profile.learn[b.item] ||= { feats: [], areas: [], rs: [] });
    e.feats.push(b.f);
    e.areas.push(b.area / result.n);
    e.rs.push(V.inscribedRatio(result, i));
    for (const k of ["feats", "areas", "rs"]) if (e[k].length > MAX_LEARN) e[k].splice(0, e[k].length - MAX_LEARN);
    added++;
  });
  return added;
}

function review(session, setup, { canvas, result, method, extra, ms }) {
  const st = { method, adj: {}, adjUnknown: 0, ai: null, numbers: false };
  const inScope = setup.profile ? state.items.filter((i) => setup.profile.itemIds.includes(i.id)) : state.items;
  const { el, close } = overlay(`<div class="review">
      <header><button class="icon" data-a="close">✕</button><h1>Verifica conteggio</h1><button class="icon small" data-a="num" title="Numera">#</button></header>
      <div class="imgbox"><canvas id="ov"></canvas></div>
      <p class="hint" id="rhint"></p>
      <div id="rlist" class="list"></div>
      ${setup.profile ? `<button class="btn wide" data-a="teach">📚 Insegna al profilo "${esc(setup.profile.name)}" i pezzi di questa foto</button>` : ""}
      <div class="actions sticky">
        <button class="btn" data-a="ai">🤖 Conta con IA</button>
        <button class="btn primary" data-a="save">✔ Salva scansione</button>
      </div></div>`, "full");
  const ov = $("#ov", el);
  zoomBar($(".imgbox", el));

  const current = () => {
    if (st.ai) return { counts: { ...st.ai.counts }, unknown: st.ai.unknown };
    const c = V.countsOf(result);
    for (const id in st.adj) c.counts[id] = Math.max(0, (c.counts[id] || 0) + st.adj[id]);
    c.unknown = Math.max(0, c.unknown + st.adjUnknown);
    return c;
  };
  const drawImage = () => {
    if (st.ai) { ov.width = canvas.width; ov.height = canvas.height; ov.getContext("2d").drawImage(canvas, 0, 0); }
    else V.renderOverlay(ov, canvas, result, colorOf, { numbers: st.numbers });
  };
  const drawList = () => {
    const { counts, unknown } = current();
    $("#rhint", el).innerHTML = st.ai
      ? `Conteggio fatto dall'IA. ${esc(st.ai.note)}`
      : `${esc(extra || "")} ${result.w}×${result.h} px${ms ? `, ${(ms / 1000).toFixed(1)} s` : ""}${result.dropped ? `, scartati ${result.dropped} granelli/riflessi` : ""}. Usa lo zoom e tocca un pezzo per correggerlo. <span class="dot" style="background:#ff3b30"></span>? = non riconosciuto, ×N = pezzi a contatto o sovrapposti.`;
    const ids = new Set([...inScope.map((i) => i.id), ...Object.keys(counts)]);
    const rows = [...ids].map((id) => itemById(id)).filter(Boolean).map((it) => ({ id: it.id, name: it.name, code: it.code, color: it.color, n: counts[it.id] || 0 })).sort((a, b) => b.n - a.n);
    $("#rlist", el).innerHTML = rows.map((r) => `<div class="countrow"><span class="dot" style="background:${r.color}"></span><span class="nm">${esc(r.name)}${r.code ? `<small> ${esc(r.code)}</small>` : ""}</span>
        <button class="step" data-d="-1" data-id="${r.id}">−</button><b data-set="${r.id}">${r.n}</b><button class="step" data-d="1" data-id="${r.id}">+</button></div>`).join("")
      + `<div class="countrow"><span class="dot" style="background:#ff3b30"></span><span class="nm">Non riconosciuti</span>
        <button class="step" data-d="-1" data-id="">−</button><b data-set="">${unknown}</b><button class="step" data-d="1" data-id="">+</button></div>
        <div class="countrow total"><span class="nm">Totale pezzi</span><b>${sum(counts) + unknown}</b></div>`;
  };
  const draw = () => { drawImage(); drawList(); };
  const change = (id, d) => {
    if (st.ai) { if (id) st.ai.counts[id] = Math.max(0, (st.ai.counts[id] || 0) + d); else st.ai.unknown = Math.max(0, st.ai.unknown + d); }
    else if (id) st.adj[id] = (st.adj[id] || 0) + d; else st.adjUnknown += d;
    drawList();
  };
  const setTo = async (id) => {
    const cur = id ? current().counts[id] || 0 : current().unknown;
    const v = await ask("Quantità", cur, "number");
    if (v === null || isNaN(+v)) return;
    change(id, Math.max(0, Math.round(+v)) - cur);
  };

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a],[data-d],[data-set]");
    if (!b) return;
    if (b.dataset.d) return change(b.dataset.id, +b.dataset.d);
    if (b.dataset.set !== undefined && !b.dataset.a) return setTo(b.dataset.set);
    const a = b.dataset.a;
    if (a === "close") { if (await confirmBox("Scartare questa scansione?")) close(); }
    if (a === "num") { st.numbers = !st.numbers; drawImage(); }
    if (a === "teach") {
      const p = setup.profile;
      const n = learnInto(p, result);
      await db.put("profiles", p);
      toast(n ? `Il profilo ha imparato ${n} pezzi da questa foto` : "Nessun pezzo singolo riconosciuto da insegnare", 3500);
    }
    if (a === "ai") {
      if (!state.items.length) return toast("Per l'IA serve almeno un articolo nel catalogo.");
      if (!state.settings.apiKey) return toast("Inserisci la chiave API nelle Impostazioni.", 3500);
      try {
        busy("L'IA sta contando… (può servire un minuto)");
        // mando solo la zona con i pezzi, alla massima risoluzione consentita
        const crop = V.cropCanvas(canvas, V.contentBox(result));
        const photo = V.canvasToJpeg(crop, 1568, 0.88);
        st.ai = await countWithAI({ apiKey: state.settings.apiKey, photo, items: inScope });
        st.method = "IA online";
        draw();
      } catch (err) {
        toast(explainError(err), 4500);
      } finally { done(); }
    }
    if (a === "save") {
      const { counts, unknown } = current();
      for (const k in counts) if (!counts[k]) delete counts[k];
      const pr = setup.profile;
      session.scans.push({ id: db.uid(), date: Date.now(), method: st.method + (pr ? ` · ${pr.name}` : ""), counts, unknown, note: st.ai?.note || "", thumb: V.canvasToJpeg(ov, 900, 0.72) });
      await db.put("sessions", session);
      close();
      render();
      toast(`Scansione ${session.scans.length} salvata`);
    }
  });

  // tocco su un pezzo per correggerlo
  ov.addEventListener("click", async (e) => {
    if (st.ai) return;
    const lab = blobAt(ov, result, e);
    if (lab < 0) return;
    const blob = result.blobs[lab];
    const v = await sheet(`Questo pezzo (${blob.k > 1 ? blob.k + " pezzi uniti" : "1 pezzo"}) è…`, [
      ...inScope.map((it) => ({ label: it.name, value: "i:" + it.id, dot: it.color })),
      { label: "Non riconosciuto", value: "u", dot: "#ff3b30" },
      { label: "Cambia numero di pezzi", value: "k" },
      { label: blob.ignored ? "Ripristina" : "Ignora (non è un pezzo)", value: "x", cls: "danger" },
    ]);
    if (!v) return;
    if (v.startsWith("i:")) { blob.item = v.slice(2); blob.ignored = false; blob.merged = false; }
    else if (v === "u") { blob.item = null; blob.ignored = false; }
    else if (v === "x") blob.ignored = !blob.ignored;
    else if (v === "k") { const n = await ask("Quanti pezzi ci sono qui?", blob.k, "number"); if (n && +n > 0) { blob.k = Math.round(+n); blob.merged = blob.k > 1; } }
    draw();
  });
  draw();
}

// ---------- PROFILI ----------
function renderProfiles(main) {
  main.innerHTML = `<header><h1>Profili di scansione</h1></header>
    <button class="btn primary big" id="new">+ Nuovo profilo</button>
    <p class="hint">Un profilo è una selezione di articoli che l'app impara da una o più <b>foto di campioni</b>: dimensione reale, colore, forma e fori. Usa sempre lo stesso sfondo e la stessa distanza (meglio con un supporto) per la foto dei campioni e per i conteggi.</p>
    <div class="list">${state.profiles.map((p) => {
      const learned = p.itemIds.map((id) => p.learn?.[id]?.feats?.length || 0);
      return `<button class="card" data-id="${p.id}"><b>${esc(p.name)}</b><small>${p.itemIds.length} articoli · ${learned.reduce((a, b) => a + b, 0)} campioni appresi · ${p.opts?.resolution || state.settings.resolution} px</small></button>`;
    }).join("") || `<p class="hint">Nessun profilo.</p>`}</div>`;
  $("#new").onclick = () => {
    if (!state.items.length) return toast("Aggiungi prima gli articoli nel Catalogo.");
    editProfile(null);
  };
  main.querySelectorAll(".card").forEach((c) => (c.onclick = () => editProfile(profileById(c.dataset.id))));
}

function editProfile(orig) {
  const p = orig ? structuredClone(orig) : {
    id: db.uid(), name: "", itemIds: [], learn: {}, photos: [], created: Date.now(),
    opts: { resolution: 3200, tolerance: 2.6, background: state.settings.background, localBg: true, excludeBorder: false, separate: true, splitTouching: true },
  };
  const o = p.opts;
  const { el, close } = overlay(`<div class="editor">
      <header><button class="icon" data-a="close">✕</button><h1>${orig ? "Modifica profilo" : "Nuovo profilo"}</h1></header>
      <label>Nome *<input class="input" name="name" value="${esc(p.name)}" placeholder="es. Viteria M3–M5"></label>
      <h3>Articoli del profilo</h3>
      <div class="checks">${state.items.map((it) => `<label class="inline"><input type="checkbox" data-item="${it.id}" ${p.itemIds.includes(it.id) ? "checked" : ""}><span class="dot" style="background:${it.color}"></span>${esc(it.name)}${it.code ? ` <small>${esc(it.code)}</small>` : ""}</label>`).join("")}</div>
      <h3>Campioni appresi</h3>
      <div id="learned"></div>
      <div class="actions"><button class="btn primary" data-a="cam">📷 Foto campioni</button><button class="btn" data-a="gal">🖼️ Dalla galleria</button></div>
      <div class="photos" id="pph"></div>
      <h3>Criteri di analisi</h3>
      <section>
        <label>Risoluzione di scansione
          <select class="input" name="resolution">${RESOLUTIONS.map(([v, l]) => `<option value="${v}" ${+o.resolution === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <small>Più alta = pezzi più piccoli riconoscibili, ma analisi più lenta.</small></label>
        <label>Sfondo
          <select class="input" name="background">${[["auto", "Automatico"], ["chiaro", "Chiaro (pezzi più scuri)"], ["scuro", "Scuro (pezzi più chiari)"]].map(([v, l]) => `<option value="${v}" ${o.background === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Tolleranza: <b id="ptol">${(+o.tolerance).toFixed(1)}</b><input type="range" name="tolerance" min="1" max="5" step="0.1" value="${o.tolerance}">
          <small>Bassa = solo pezzi molto simili ai campioni; alta = più permissivo.</small></label>
        <label class="inline"><input type="checkbox" name="localBg" ${o.localBg ? "checked" : ""}> Compensa luce non uniforme e ombre</label>
        <label class="inline"><input type="checkbox" name="splitTouching" ${o.splitTouching ? "checked" : ""}> Conta pezzi a contatto o sovrapposti</label>
        <label class="inline"><input type="checkbox" name="separate" ${o.separate ? "checked" : ""}> Separa i pezzi a contatto con linee di taglio</label>
        <label class="inline"><input type="checkbox" name="excludeBorder" ${o.excludeBorder ? "checked" : ""}> Ignora i pezzi tagliati dal bordo della foto</label>
      </section>
      <div class="actions sticky">
        ${orig ? `<button class="btn danger" data-a="del">Elimina</button>` : ""}
        <button class="btn primary" data-a="save">Salva profilo</button>
      </div></div>`, "full");

  const readForm = () => {
    p.name = $("[name=name]", el).value.trim();
    p.itemIds = [...el.querySelectorAll("[data-item]")].filter((c) => c.checked).map((c) => c.dataset.item);
    o.resolution = +$("[name=resolution]", el).value;
    o.background = $("[name=background]", el).value;
    o.tolerance = +$("[name=tolerance]", el).value;
    for (const k of ["localBg", "splitTouching", "separate", "excludeBorder"]) o[k] = $(`[name=${k}]`, el).checked;
  };
  const drawLearned = () => {
    const rows = p.itemIds.map((id) => {
      const it = itemById(id), stt = V.learnStats(p.learn?.[id]);
      if (!it) return "";
      return `<div class="countrow"><span class="dot" style="background:${it.color}"></span><span class="nm">${esc(it.name)}<small>${stt ? ` · ${stt.n} campioni · area ${pct(stt.areaFrac)} della foto · ${stt.holes} fori` : " · nessun campione: scatta una foto campioni"}</small></span>
        ${stt ? `<button class="step" data-reset="${id}" title="Azzera">⟲</button>` : ""}</div>`;
    }).join("");
    $("#learned", el).innerHTML = rows || `<p class="hint">Seleziona gli articoli qui sopra, poi scatta una foto con alcuni pezzi di ciascuno, ben separati.</p>`;
    $("#pph", el).innerHTML = (p.photos || []).map((ph) => `<div class="ph"><img src="${ph}"></div>`).join("");
  };
  el.querySelector("[name=tolerance]").oninput = (e) => ($("#ptol", el).textContent = (+e.target.value).toFixed(1));
  el.querySelectorAll("[data-item]").forEach((c) => (c.onchange = () => { readForm(); drawLearned(); }));

  el.addEventListener("click", async (e) => {
    const rs = e.target.closest("[data-reset]");
    if (rs) { if (await confirmBox("Cancellare i campioni appresi per questo articolo?")) { delete p.learn[rs.dataset.reset]; drawLearned(); } return; }
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "close") close();
    if (a === "cam" || a === "gal") {
      readForm();
      if (!p.itemIds.length) return toast("Seleziona prima gli articoli del profilo.");
      const [file] = await pickFiles("image/*", { capture: a === "cam" });
      if (file) teach(p, file, drawLearned);
    }
    if (a === "del" && (await confirmBox(`Eliminare il profilo "${p.name}"?`))) {
      await db.del("profiles", p.id);
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      close();
      render();
    }
    if (a === "save") {
      readForm();
      if (!p.name) return toast("Inserisci il nome del profilo.");
      if (!p.itemIds.length) return toast("Seleziona almeno un articolo.");
      await db.put("profiles", p);
      state.profiles = [...state.profiles.filter((x) => x.id !== p.id), p].sort((a, b) => a.name.localeCompare(b.name));
      close();
      render();
      toast("Profilo salvato");
    }
  });
  drawLearned();
}

// Foto dei campioni: l'utente indica cosa è ogni pezzo, il profilo impara
async function teach(p, file, onDone) {
  busy(`Analizzo la foto dei campioni (${p.opts.resolution} px)…`);
  await nextFrame();
  let canvas, result;
  try {
    const img = await V.loadImage(file);
    canvas = V.drawToCanvas(img, p.opts.resolution);
    const models = V.buildModels(state.items, p);
    // per imparare uso il vaglio automatico (non ancora quello appreso) e niente separazione
    const opts = { ...state.settings, ...p.opts, autoNoise: true, minArea: V.DEFAULTS.minArea, separate: false };
    result = V.classify(V.analyzeCanvas(canvas, opts), models, { ...opts, tolerance: Math.max(opts.tolerance, 3) });
    if (p.itemIds.length === 1) for (const b of result.blobs) { if (b.k === 1) b.item = p.itemIds[0]; }
  } catch (e) { done(); return toast("Errore: " + e.message); }
  done();
  const items = p.itemIds.map(itemById).filter(Boolean);
  const { el, close } = overlay(`<div class="review">
      <header><button class="icon" data-a="close">✕</button><h1>Indica i campioni</h1></header>
      <div class="imgbox"><canvas id="tv"></canvas></div>
      <p class="hint">Tocca ogni pezzo e scegli l'articolo. I pezzi grigi o "?" non vengono appresi. Insegna solo pezzi <b>singoli e interi</b>. Puoi anche assegnare tutti i pezzi a un articolo.</p>
      <div id="tlist" class="list"></div>
      <div class="actions"><button class="btn" data-a="all">Assegna tutti a…</button><button class="btn" data-a="none">Togli tutti</button></div>
      <div class="actions sticky"><button class="btn primary" data-a="learn">📚 Impara da questi campioni</button></div></div>`, "full");
  const tv = $("#tv", el);
  zoomBar($(".imgbox", el));
  const draw = () => {
    V.renderOverlay(tv, canvas, result, colorOf, {});
    const cnt = {};
    for (const b of result.blobs) if (b.item && !b.ignored && b.k === 1) cnt[b.item] = (cnt[b.item] || 0) + 1;
    const unk = result.blobs.filter((b) => !b.item && !b.ignored).length;
    $("#tlist", el).innerHTML = items.map((it) => `<div class="countrow"><span class="dot" style="background:${it.color}"></span><span class="nm">${esc(it.name)}</span><b>${cnt[it.id] || 0}</b></div>`).join("")
      + `<div class="countrow"><span class="dot" style="background:#ff3b30"></span><span class="nm">Non assegnati</span><b>${unk}</b></div>`;
  };
  tv.addEventListener("click", async (e) => {
    const lab = blobAt(tv, result, e);
    if (lab < 0) return;
    const b = result.blobs[lab];
    const v = await sheet("Questo campione è…", [
      ...items.map((it) => ({ label: it.name, value: "i:" + it.id, dot: it.color })),
      { label: "Non assegnato", value: "u", dot: "#ff3b30" },
      { label: "Ignora (non è un pezzo intero)", value: "x", cls: "danger" },
    ]);
    if (!v) return;
    b.k = 1; b.merged = false;
    if (v.startsWith("i:")) { b.item = v.slice(2); b.ignored = false; }
    else if (v === "u") { b.item = null; b.ignored = false; }
    else b.ignored = true;
    draw();
  });
  el.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "close") close();
    if (a === "all") {
      const v = await sheet("Assegna tutti i pezzi a…", items.map((it) => ({ label: it.name, value: it.id, dot: it.color })));
      if (v) { for (const b of result.blobs) if (!b.ignored) { b.item = v; b.k = 1; b.merged = false; } draw(); }
    }
    if (a === "none") { for (const b of result.blobs) b.item = null; draw(); }
    if (a === "learn") {
      // scarta automaticamente i pezzi di dimensione anomala (probabili coppie o frammenti)
      const byItem = {};
      result.blobs.forEach((b) => { if (b.item && !b.ignored && b.k === 1) (byItem[b.item] ||= []).push(b.area); });
      const med = {};
      for (const id in byItem) med[id] = V.median(byItem[id]);
      const n = learnInto(p, result, (b) => b.area > med[b.item] * 0.6 && b.area < med[b.item] * 1.6);
      if (!n) return toast("Nessun campione assegnato.");
      p.photos = [...(p.photos || []), V.canvasToJpeg(tv, 500, 0.7)].slice(-6);
      close();
      onDone();
      toast(`Imparati ${n} campioni. Ricordati di salvare il profilo.`, 3500);
    }
  });
  draw();
}

// ---------- CATALOGO ----------
function renderCatalog(main) {
  main.innerHTML = `<header><h1>Catalogo</h1></header>
    <button class="btn primary big" id="new">+ Nuovo articolo</button>
    <p class="hint">Per ogni articolo scatta 1–5 foto di riferimento con alcuni pezzi separati, sullo stesso tipo di sfondo che userai per contare. Per pezzi piccoli crea poi un <b>Profilo</b>.</p>
    <div class="grid">${state.items.map((it) => `<button class="item" data-id="${it.id}">
      ${it.photos?.[0] ? `<img src="${it.photos[0]}">` : `<div class="noimg">nessuna foto</div>`}
      <span><span class="dot" style="background:${it.color}"></span><b>${esc(it.name)}</b></span>
      <small>${esc([it.code, it.category].filter(Boolean).join(" · ")) || "&nbsp;"}</small>
      <small>${(it.photos || []).length} foto · ${(it.photoSamples || []).flat().length} campioni</small></button>`).join("")}</div>`;
  $("#new").onclick = () => editItem(null);
  main.querySelectorAll(".item").forEach((b) => (b.onclick = () => editItem(itemById(b.dataset.id))));
}

function editItem(orig) {
  const it = orig ? structuredClone(orig) : { id: db.uid(), name: "", code: "", category: "", notes: "", color: PALETTE[state.items.length % PALETTE.length], photos: [], photoSamples: [] };
  const { el, close } = overlay(`<div class="editor">
      <header><button class="icon" data-a="close">✕</button><h1>${orig ? "Modifica articolo" : "Nuovo articolo"}</h1></header>
      <label>Nome *<input class="input" name="name" value="${esc(it.name)}" placeholder="es. Vite M4x20 zincata"></label>
      <label>Codice<input class="input" name="code" value="${esc(it.code)}" placeholder="es. VT-M4-20"></label>
      <label>Categoria<input class="input" name="category" value="${esc(it.category)}" placeholder="es. Viteria"></label>
      <label>Associazioni / note<textarea class="input" name="notes" rows="3" placeholder="fornitore, ubicazione, prezzo, descrizione…">${esc(it.notes)}</textarea></label>
      <label class="inline">Colore nel conteggio <input type="color" name="color" value="${it.color}"></label>
      <h3>Foto di riferimento</h3>
      <div class="photos" id="ph"></div>
      <div class="actions"><button class="btn" data-a="cam">📷 Scatta</button><button class="btn" data-a="gal">🖼️ Galleria</button></div>
      <div class="actions sticky">
        ${orig ? `<button class="btn danger" data-a="del">Elimina</button>` : ""}
        <button class="btn primary" data-a="save">Salva articolo</button>
      </div></div>`, "full");
  const drawPhotos = () => {
    $("#ph", el).innerHTML = it.photos.map((p, i) => `<div class="ph"><img src="${p}"><small>${(it.photoSamples[i] || []).length} pezzi</small><button data-rm="${i}">✕</button></div>`).join("")
      || `<p class="hint">Nessuna foto: aggiungine almeno una.</p>`;
  };
  const addPhotos = async (capture) => {
    const files = await pickFiles("image/*", { capture, multiple: !capture });
    if (!files.length) return;
    busy("Analizzo la foto di riferimento…");
    await nextFrame();
    let zero = 0;
    for (const f of files) {
      try {
        const img = await V.loadImage(f);
        const c = V.drawToCanvas(img, 1600);
        const feats = V.referenceFeatures(c, state.settings);
        if (!feats.length) zero++;
        it.photos.push(V.canvasToJpeg(c, 900, 0.82));
        it.photoSamples.push(feats);
      } catch (e) { toast(e.message); }
    }
    done();
    drawPhotos();
    if (zero) toast("In una foto non ho trovato pezzi: usa uno sfondo uniforme e contrastato.", 4000);
  };
  el.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { it.photos.splice(+rm.dataset.rm, 1); it.photoSamples.splice(+rm.dataset.rm, 1); return drawPhotos(); }
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "close") close();
    if (a === "cam") addPhotos(true);
    if (a === "gal") addPhotos(false);
    if (a === "del" && (await confirmBox(`Eliminare "${it.name}" dal catalogo?`))) {
      await db.del("items", it.id);
      state.items = state.items.filter((x) => x.id !== it.id);
      close();
      render();
    }
    if (a === "save") {
      for (const k of ["name", "code", "category", "notes", "color"]) it[k] = el.querySelector(`[name=${k}]`).value.trim();
      if (!it.name) return toast("Inserisci il nome dell'articolo.");
      await db.put("items", it);
      state.items = [...state.items.filter((x) => x.id !== it.id), it].sort((a, b) => a.name.localeCompare(b.name));
      close();
      render();
      toast("Articolo salvato");
    }
  });
  drawPhotos();
}

// ---------- IMPOSTAZIONI ----------
function renderSettings(main) {
  const s = state.settings;
  main.innerHTML = `<header><h1>Impostazioni</h1></header>
    <section><h3>Riconoscimento offline (senza profilo)</h3>
      <p class="hint">Con un profilo valgono i criteri del profilo.</p>
      <label>Risoluzione di scansione
        <select class="input" name="resolution">${RESOLUTIONS.map(([v, l]) => `<option value="${v}" ${+s.resolution === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Sfondo
        <select class="input" name="background">
          ${[["auto", "Automatico"], ["chiaro", "Chiaro (pezzi più scuri)"], ["scuro", "Scuro (pezzi più chiari)"]].map(([v, l]) => `<option value="${v}" ${s.background === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
      <label>Tolleranza riconoscimento: <b id="tolv">${(+s.tolerance).toFixed(1)}</b>
        <input type="range" name="tolerance" min="0.8" max="4" step="0.1" value="${s.tolerance}"><small>Bassa = più severo (più "non riconosciuti"), alta = più permissivo.</small></label>
      <label>Dimensione minima assoluta di un pezzo: <b id="minv">${Math.round(s.minArea * 100000)}</b>
        <input type="range" name="minArea" min="0" max="50" step="1" value="${Math.round(s.minArea * 100000)}"><small>In centomillesimi della foto. Il filtro automatico qui sotto di solito basta.</small></label>
      <label class="inline"><input type="checkbox" name="autoNoise" ${s.autoNoise ? "checked" : ""}> Scarta automaticamente polvere e riflessi</label>
      <label class="inline"><input type="checkbox" name="localBg" ${s.localBg ? "checked" : ""}> Compensa luce non uniforme e ombre</label>
      <label class="inline"><input type="checkbox" name="splitTouching" ${s.splitTouching ? "checked" : ""}> Conta pezzi a contatto o sovrapposti</label>
      <label class="inline"><input type="checkbox" name="separate" ${s.separate ? "checked" : ""}> Separa i pezzi a contatto con linee di taglio</label>
      <label class="inline"><input type="checkbox" name="excludeBorder" ${s.excludeBorder ? "checked" : ""}> Ignora i pezzi tagliati dal bordo della foto</label>
      <label class="inline"><input type="checkbox" name="useSize" ${s.useSize ? "checked" : ""}> Usa la dimensione per distinguere gli articoli <small>(solo se fotografi sempre alla stessa distanza)</small></label>
      <label>Fotogrammi analizzati nei video: <b id="vfv">${s.videoFrames}</b>
        <input type="range" name="videoFrames" min="3" max="11" step="2" value="${s.videoFrames}"></label>
      <button class="btn" id="recalc">Ricalcola il catalogo con queste impostazioni</button>
    </section>
    <section><h3>IA online (facoltativa)</h3>
      <p class="hint">Con una chiave API di Anthropic (console.anthropic.com) il pulsante "Conta con IA" usa Claude per un conteggio più preciso. Serve internet; ogni analisi costa pochi centesimi. La chiave resta solo su questo telefono.</p>
      <label>Chiave API<input class="input" name="apiKey" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
    </section>
    <section><h3>Dati</h3>
      <div class="actions"><button class="btn" id="backup">Esporta backup</button><button class="btn" id="restore">Ripristina backup</button></div>
      <p class="hint">Il backup contiene catalogo, profili e conteggi (non la chiave API).</p>
    </section>
    <p class="hint center">Conta Pezzi · versione ${__APP_VERSION__}</p>`;
  main.querySelectorAll("[name]").forEach((inp) => (inp.oninput = inp.onchange = () => {
    const k = inp.name;
    let v = inp.type === "checkbox" ? inp.checked : inp.value;
    if (k === "tolerance") { v = +v; $("#tolv").textContent = v.toFixed(1); }
    if (k === "minArea") { $("#minv").textContent = v; v = +v / 100000; }
    if (k === "videoFrames") { v = +v; $("#vfv").textContent = v; }
    if (k === "resolution") v = +v;
    if (k === "apiKey") v = v.trim();
    s[k] = v;
    saveSettings();
  }));
  $("#recalc").onclick = async () => {
    busy("Ricalcolo le foto del catalogo…");
    await nextFrame();
    for (const it of state.items) {
      it.photoSamples = [];
      for (const p of it.photos || []) it.photoSamples.push(V.referenceFeatures(V.drawToCanvas(await V.loadImage(p), 1600), s));
      await db.put("items", it);
    }
    done();
    toast("Catalogo ricalcolato");
  };
  $("#backup").onclick = async () => {
    const json = JSON.stringify({ app: "conta-pezzi", version: 2, items: state.items, profiles: state.profiles, sessions: state.sessions });
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    await saveAndShare(`backup-conta-pezzi-${new Date().toISOString().slice(0, 10)}.json`, btoa(bin), "application/json").catch((e) => toast(e.message));
  };
  $("#restore").onclick = async () => {
    const [f] = await pickFiles(".json,application/json");
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "conta-pezzi") throw new Error("File di backup non valido");
      if (!(await confirmBox("Ripristinare il backup? Gli elementi con lo stesso codice interno verranno sovrascritti."))) return;
      for (const it of data.items || []) await db.put("items", it);
      for (const p of data.profiles || []) await db.put("profiles", p);
      for (const se of data.sessions || []) await db.put("sessions", se);
      await init();
      toast("Backup ripristinato");
    } catch (e) { toast("Errore: " + e.message); }
  };
}

init();
