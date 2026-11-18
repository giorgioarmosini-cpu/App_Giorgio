import "./style.css";
import * as db from "./db.js";
import * as V from "./vision.js";
import { countWithAI, explainError } from "./ai.js";
import { exportPdf, exportXlsx, buildTable, saveAndShare } from "./export.js";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

const PALETTE = ["#34c759", "#0a84ff", "#ff9f0a", "#bf5af2", "#ffd60a", "#64d2ff", "#ff375f", "#30d158", "#5e5ce6", "#ac8e68", "#66d4cf", "#ff6482"];
const state = { tab: "conta", items: [], sessions: [], settings: { ...V.DEFAULTS, apiKey: "" }, current: null };
const backStack = []; // funzioni per chiudere schermate sovrapposte (tasto Indietro)

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (ts) => new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
const itemById = (id) => state.items.find((i) => i.id === id);
const colorOf = (id) => itemById(id)?.color || "#34c759";
const withSamples = () => state.items.map((it) => ({ ...it, samples: (it.photoSamples || []).flat() }));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- piccoli componenti ----------
function toast(msg, ms = 2600) {
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

// ---------- avvio ----------
async function init() {
  const [items, sessions, settings] = await Promise.all([db.getAll("items"), db.getAll("sessions"), db.getKV("settings", {})]);
  state.items = items.sort((a, b) => a.name.localeCompare(b.name));
  state.sessions = sessions.sort((a, b) => b.created - a.created);
  state.settings = { ...state.settings, ...settings };
  if (Capacitor.isNativePlatform()) {
    App.addListener("backButton", () => {
      if (backStack.length) backStack[backStack.length - 1]();
      else if (state.current) { state.current = null; render(); }
      else if (state.tab !== "conta") { state.tab = "conta"; render(); }
      else App.exitApp();
    });
  }
  render();
}

const saveSettings = () => db.setKV("settings", state.settings);

function render() {
  const app = $("#app");
  app.innerHTML = `<main id="main"></main>
    <nav class="tabs">
      ${[["conta", "Conta", "M4 6h16M4 12h16M4 18h10"], ["catalogo", "Catalogo", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"], ["impostazioni", "Impostazioni", "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2M19 12h2M12 3v2M12 19v2"]]
        .map(([k, l, d]) => `<button data-tab="${k}" class="${state.tab === k ? "on" : ""}"><svg viewBox="0 0 24 24"><path d="${d}"/></svg>${l}</button>`).join("")}
    </nav>`;
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; render(); }));
  const main = $("#main");
  if (state.tab === "conta") state.current ? renderSession(main) : renderSessions(main);
  else if (state.tab === "catalogo") renderCatalog(main);
  else renderSettings(main);
}

// ---------- CONTA ----------
function renderSessions(main) {
  main.innerHTML = `<header><h1>Conteggi</h1></header>
    <button class="btn primary big" id="new">+ Nuovo conteggio</button>
    ${state.items.length ? "" : `<p class="hint warn">Il catalogo è vuoto: aggiungi gli articoli con le loro foto nella scheda <b>Catalogo</b>. Senza catalogo l'app conta i pezzi ma non li distingue.</p>`}
    <div class="list">${state.sessions.map((s) => {
      const tot = (s.scans || []).reduce((a, sc) => a + sum(sc.counts) + (sc.unknown || 0), 0);
      return `<button class="card" data-id="${s.id}"><b>${esc(s.name)}</b><small>${fmt(s.created)} · ${(s.scans || []).length} scansioni · ${tot} pezzi</small></button>`;
    }).join("") || `<p class="hint">Nessun conteggio salvato.</p>`}</div>`;
  $("#new").onclick = async () => {
    const name = await ask("Nome del conteggio", `Conteggio ${new Date().toLocaleDateString("it-IT")}`);
    if (!name) return;
    const s = { id: db.uid(), name, created: Date.now(), scans: [] };
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
  const { head, rows, foot } = buildTable(s, state.items);
  const dotFor = (name) => { const it = state.items.find((i) => i.name === name); return it ? `<span class="dot" style="background:${it.color}"></span>` : ""; };
  main.innerHTML = `<header><button class="icon" id="back">‹</button><h1 id="rename">${esc(s.name)}</h1><button class="icon" id="menu">⋯</button></header>
    <div class="actions">
      <button class="btn primary" id="photo">📷 Foto</button>
      <button class="btn primary" id="video">🎥 Video</button>
      <button class="btn" id="gallery">🖼️ Galleria</button>
    </div>
    <p class="hint">Sfondo uniforme e diverso dal colore dei pezzi, luce diffusa, foto dall'alto. Puoi fare più scansioni: ognuna diventa una colonna.</p>
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

async function startScan(session, accept, capture) {
  const [file] = await pickFiles(accept, { capture });
  if (!file) return;
  const items = withSamples();
  try {
    if (file.type.startsWith("video/")) {
      busy("Leggo il video…");
      await nextFrame();
      const frames = await V.videoFrames(file, state.settings.videoFrames, 1400);
      busy("Analizzo i fotogrammi…");
      await nextFrame();
      const results = frames.map((f) => {
        const c = V.drawToCanvas(f, 1000);
        const r = V.classify(V.analyzeCanvas(c, state.settings), items, state.settings);
        const { counts, unknown } = V.countsOf(r);
        return { hires: f, canvas: c, result: r, total: sum(counts) + unknown };
      });
      const sorted = [...results].sort((a, b) => a.total - b.total);
      const med = sorted[sorted.length >> 1];
      done();
      review(session, { ...med, method: `Offline (video, ${frames.length} fotogrammi)`, extra: `Pezzi per fotogramma: ${results.map((r) => r.total).join(", ")}. Mostro il fotogramma con il valore mediano.` });
    } else {
      busy("Analizzo la foto…");
      await nextFrame();
      const img = await V.loadImage(file);
      const hires = V.drawToCanvas(img, 1568);
      const canvas = V.drawToCanvas(img, 1000);
      const result = V.classify(V.analyzeCanvas(canvas, state.settings), items, state.settings);
      done();
      review(session, { hires, canvas, result, method: "Offline (foto)" });
    }
  } catch (e) {
    done();
    toast("Errore: " + e.message, 4000);
  }
}

function review(session, { hires, canvas, result, method, extra }) {
  const st = { method, adj: {}, adjUnknown: 0, ai: null, note: "" };
  const { el, close } = overlay(`<div class="review">
      <header><button class="icon" data-a="close">✕</button><h1>Verifica conteggio</h1></header>
      <div class="imgbox"><canvas id="ov"></canvas></div>
      <p class="hint" id="rhint"></p>
      <div id="rlist" class="list"></div>
      <div class="actions sticky">
        <button class="btn" data-a="ai">🤖 Conta con IA</button>
        <button class="btn primary" data-a="save">✔ Salva scansione</button>
      </div></div>`, "full");
  const ov = $("#ov", el);

  const current = () => {
    if (st.ai) return { counts: { ...st.ai.counts }, unknown: st.ai.unknown };
    const c = V.countsOf(result);
    for (const id in st.adj) c.counts[id] = Math.max(0, (c.counts[id] || 0) + st.adj[id]);
    c.unknown = Math.max(0, c.unknown + st.adjUnknown);
    return c;
  };
  const draw = () => {
    if (st.ai) { ov.width = canvas.width; ov.height = canvas.height; ov.getContext("2d").drawImage(canvas, 0, 0); }
    else V.renderOverlay(ov, canvas, result, colorOf);
    const { counts, unknown } = current();
    $("#rhint", el).innerHTML = st.ai
      ? `Conteggio fatto dall'IA. ${esc(st.ai.note)}`
      : `${esc(extra || "")} Tocca un pezzo sulla foto per correggerlo. <span class="dot" style="background:#ff3b30"></span>? = non riconosciuto, ×N = pezzi a contatto o sovrapposti.`;
    const rows = state.items.map((it) => ({ id: it.id, name: it.name, code: it.code, color: it.color, n: counts[it.id] || 0 })).sort((a, b) => b.n - a.n);
    $("#rlist", el).innerHTML = rows.map((r) => `<div class="countrow"><span class="dot" style="background:${r.color}"></span><span class="nm">${esc(r.name)}${r.code ? `<small> ${esc(r.code)}</small>` : ""}</span>
        <button class="step" data-d="-1" data-id="${r.id}">−</button><b data-set="${r.id}">${r.n}</b><button class="step" data-d="1" data-id="${r.id}">+</button></div>`).join("")
      + `<div class="countrow"><span class="dot" style="background:#ff3b30"></span><span class="nm">Non riconosciuti</span>
        <button class="step" data-d="-1" data-id="">−</button><b data-set="">${unknown}</b><button class="step" data-d="1" data-id="">+</button></div>
        <div class="countrow total"><span class="nm">Totale pezzi</span><b>${sum(counts) + unknown}</b></div>`;
  };
  const change = (id, d) => {
    if (st.ai) { if (id) st.ai.counts[id] = Math.max(0, (st.ai.counts[id] || 0) + d); else st.ai.unknown = Math.max(0, st.ai.unknown + d); }
    else if (id) st.adj[id] = (st.adj[id] || 0) + d; else st.adjUnknown += d;
    draw();
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
    if (a === "ai") {
      if (!state.items.length) return toast("Per l'IA serve almeno un articolo nel catalogo.");
      if (!state.settings.apiKey) return toast("Inserisci la chiave API nelle Impostazioni.", 3500);
      try {
        busy("L'IA sta contando… (può servire un minuto)");
        const photo = V.canvasToJpeg(hires, 1568, 0.85);
        st.ai = await countWithAI({ apiKey: state.settings.apiKey, photo, items: state.items });
        st.method = "IA online";
        draw();
      } catch (err) {
        toast(explainError(err), 4500);
      } finally { done(); }
    }
    if (a === "save") {
      const { counts, unknown } = current();
      for (const k in counts) if (!counts[k]) delete counts[k];
      session.scans.push({ id: db.uid(), date: Date.now(), method: st.method, counts, unknown, note: st.ai?.note || "", thumb: V.canvasToJpeg(ov, 520, 0.7) });
      await db.put("sessions", session);
      close();
      render();
      toast(`Scansione ${session.scans.length} salvata`);
    }
  });

  // tocco su un pezzo per correggerlo
  ov.addEventListener("click", async (e) => {
    if (st.ai) return;
    const r = ov.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * ov.width), y = Math.round(((e.clientY - r.top) / r.height) * ov.height);
    let lab = -1;
    const R = Math.round(ov.width / 60);
    for (let rad = 0; rad <= R && lab < 0; rad += 2) for (let dy = -rad; dy <= rad && lab < 0; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < ov.width && yy < ov.height && result.labels[yy * result.w + xx] >= 0) { lab = result.labels[yy * result.w + xx]; break; }
    }
    if (lab < 0) return;
    const blob = result.blobs[lab];
    const v = await sheet(`Questo pezzo (${blob.k > 1 ? blob.k + " pezzi uniti" : "1 pezzo"}) è…`, [
      ...state.items.map((it) => ({ label: it.name, value: "i:" + it.id, dot: it.color })),
      { label: "Non riconosciuto", value: "u", dot: "#ff3b30" },
      { label: "Cambia numero di pezzi", value: "k" },
      { label: blob.ignored ? "Ripristina" : "Ignora (non è un pezzo)", value: "x", cls: "danger" },
    ]);
    if (!v) return;
    if (v.startsWith("i:")) { blob.item = v.slice(2); blob.ignored = false; }
    else if (v === "u") { blob.item = null; blob.ignored = false; }
    else if (v === "x") blob.ignored = !blob.ignored;
    else if (v === "k") { const n = await ask("Quanti pezzi ci sono qui?", blob.k, "number"); if (n && +n > 0) blob.k = Math.round(+n); }
    draw();
  });
  draw();
}

// ---------- CATALOGO ----------
function renderCatalog(main) {
  main.innerHTML = `<header><h1>Catalogo</h1></header>
    <button class="btn primary big" id="new">+ Nuovo articolo</button>
    <p class="hint">Per ogni articolo scatta 1–5 foto di riferimento con alcuni pezzi separati, sullo stesso tipo di sfondo che userai per contare.</p>
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
        const c = V.drawToCanvas(await V.loadImage(f), 1000);
        const feats = V.referenceFeatures(c, state.settings);
        if (!feats.length) zero++;
        it.photos.push(V.canvasToJpeg(c, 800, 0.8));
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
    <section><h3>Riconoscimento offline</h3>
      <label>Sfondo
        <select class="input" name="background">
          ${[["auto", "Automatico"], ["chiaro", "Chiaro (pezzi più scuri)"], ["scuro", "Scuro (pezzi più chiari)"]].map(([v, l]) => `<option value="${v}" ${s.background === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
      <label>Tolleranza riconoscimento: <b id="tolv">${s.tolerance.toFixed(1)}</b>
        <input type="range" name="tolerance" min="0.8" max="4" step="0.1" value="${s.tolerance}"><small>Bassa = più severo (più "non riconosciuti"), alta = più permissivo.</small></label>
      <label>Dimensione minima di un pezzo: <b id="minv">${Math.round(s.minArea * 10000)}</b>
        <input type="range" name="minArea" min="1" max="40" step="1" value="${Math.round(s.minArea * 10000)}"><small>Aumentala se l'app conta granelli di polvere o riflessi.</small></label>
      <label>Fotogrammi analizzati nei video: <b id="vfv">${s.videoFrames}</b>
        <input type="range" name="videoFrames" min="3" max="11" step="2" value="${s.videoFrames}"></label>
      <label class="inline"><input type="checkbox" name="splitTouching" ${s.splitTouching ? "checked" : ""}> Conta i pezzi a contatto o sovrapposti</label>
      <label class="inline"><input type="checkbox" name="useSize" ${s.useSize ? "checked" : ""}> Usa la dimensione per distinguere gli articoli <small>(solo se fotografi sempre alla stessa distanza)</small></label>
      <button class="btn" id="recalc">Ricalcola il catalogo con queste impostazioni</button>
    </section>
    <section><h3>IA online (facoltativa)</h3>
      <p class="hint">Con una chiave API di Anthropic (console.anthropic.com) il pulsante "Conta con IA" usa Claude per un conteggio più preciso. Serve internet; ogni analisi costa pochi centesimi. La chiave resta solo su questo telefono.</p>
      <label>Chiave API<input class="input" name="apiKey" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
    </section>
    <section><h3>Dati</h3>
      <div class="actions"><button class="btn" id="backup">Esporta backup</button><button class="btn" id="restore">Ripristina backup</button></div>
      <p class="hint">Il backup contiene catalogo e conteggi (non la chiave API).</p>
    </section>
    <p class="hint center">Conta Pezzi · versione ${__APP_VERSION__}</p>`;
  main.querySelectorAll("[name]").forEach((inp) => (inp.oninput = inp.onchange = () => {
    const k = inp.name;
    let v = inp.type === "checkbox" ? inp.checked : inp.value;
    if (k === "tolerance") { v = +v; $("#tolv").textContent = v.toFixed(1); }
    if (k === "minArea") { $("#minv").textContent = v; v = +v / 10000; }
    if (k === "videoFrames") { v = +v; $("#vfv").textContent = v; }
    if (k === "apiKey") v = v.trim();
    s[k] = v;
    saveSettings();
  }));
  $("#recalc").onclick = async () => {
    busy("Ricalcolo le foto del catalogo…");
    await nextFrame();
    for (const it of state.items) {
      it.photoSamples = [];
      for (const p of it.photos || []) it.photoSamples.push(V.referenceFeatures(V.drawToCanvas(await V.loadImage(p), 1000), s));
      await db.put("items", it);
    }
    done();
    toast("Catalogo ricalcolato");
  };
  $("#backup").onclick = async () => {
    const json = JSON.stringify({ app: "conta-pezzi", version: 1, items: state.items, sessions: state.sessions });
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = btoa(bin);
    await saveAndShare(`backup-conta-pezzi-${new Date().toISOString().slice(0, 10)}.json`, b64, "application/json").catch((e) => toast(e.message));
  };
  $("#restore").onclick = async () => {
    const [f] = await pickFiles(".json,application/json");
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "conta-pezzi") throw new Error("File di backup non valido");
      if (!(await confirmBox("Ripristinare il backup? Gli articoli e i conteggi con lo stesso codice interno verranno sovrascritti."))) return;
      for (const it of data.items || []) await db.put("items", it);
      for (const se of data.sessions || []) await db.put("sessions", se);
      await init();
      toast("Backup ripristinato");
    } catch (e) { toast("Errore: " + e.message); }
  };
}

init();
