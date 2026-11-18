// Riconoscimento e conteggio offline: segmentazione dallo sfondo, componenti connesse,
// descrittori di forma/colore e confronto con il catalogo fotografico.

// ---------- caricamento immagini ----------
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Immagine non leggibile"));
    img.src = src instanceof Blob ? URL.createObjectURL(src) : src;
  });
}

export function drawToCanvas(source, maxDim) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, maxDim / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export function canvasToJpeg(canvas, maxDim = canvas.width, quality = 0.85) {
  const c = maxDim < Math.max(canvas.width, canvas.height) ? drawToCanvas(canvas, maxDim) : canvas;
  return c.toDataURL("image/jpeg", quality);
}

// Estrae alcuni fotogrammi distribuiti lungo il video
export async function videoFrames(file, n = 5, maxDim = 1000) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error("Video non leggibile su questo dispositivo"));
  });
  const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / n);
    await new Promise((res) => {
      const done = () => { v.removeEventListener("seeked", done); res(); };
      v.addEventListener("seeked", done);
      v.currentTime = Math.max(0, t);
      setTimeout(done, 3000);
    });
    frames.push(drawToCanvas(v, maxDim));
  }
  URL.revokeObjectURL(url);
  return frames;
}

// ---------- colore ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const f3 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(data, n) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]];
    const x = f3((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f3(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f3((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    L[i] = 116 * y - 16;
    A[i] = 500 * (x - y);
    B[i] = 200 * (y - z);
  }
  return { L, A, B };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return th;
}

// ---------- morfologia ----------
function boxCount(mask, w, h, r) {
  const W = w + 1, I = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row;
    }
  }
  return (x, y) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
    const x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    return [I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0], (x1 - x0) * (y1 - y0)];
  };
}
function erode(mask, w, h, r) {
  const q = boxCount(mask, w, h, r), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [s, a] = q(x, y);
    out[y * w + x] = s === a ? 1 : 0;
  }
  return out;
}
function dilate(mask, w, h, r) {
  const q = boxCount(mask, w, h, r), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = q(x, y)[0] > 0 ? 1 : 0;
  return out;
}

// ---------- segmentazione + componenti ----------
export const DEFAULTS = {
  background: "auto",   // auto | chiaro | scuro
  minArea: 0.0003,      // frazione dell'immagine
  tolerance: 2.2,       // soglia di somiglianza
  useSize: false,       // la distanza della foto è sempre la stessa
  splitTouching: true,
  videoFrames: 5,
};

export function analyzeCanvas(canvas, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const w = canvas.width, h = canvas.height, n = w * h;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const { L, A, B } = toLab(data, n);

  // colore di sfondo = mediana dei pixel del bordo
  const bl = [], ba = [], bb = [];
  const step = Math.max(1, Math.round((w + h) / 400));
  const push = (i) => { bl.push(L[i]); ba.push(A[i]); bb.push(B[i]); };
  for (let x = 0; x < w; x += step) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y += step) { push(y * w); push(y * w + w - 1); }
  const bg = [median(bl), median(ba), median(bb)];

  // mappa di differenza dallo sfondo (luminosità pesata meno, per le ombre)
  const d = new Uint8Array(n), hist = new Uint32Array(256);
  const wl = o.background === "auto" ? 0.6 : 1;
  for (let i = 0; i < n; i++) {
    let dl = L[i] - bg[0];
    if (o.background === "chiaro" && dl > 0) dl = 0;   // oggetti più scuri dello sfondo
    if (o.background === "scuro" && dl < 0) dl = 0;    // oggetti più chiari dello sfondo
    const da = A[i] - bg[1], db = B[i] - bg[2];
    const v = Math.min(255, 2 * Math.sqrt(wl * dl * dl + da * da + db * db));
    d[i] = v;
    hist[v | 0]++;
  }
  const th = Math.max(otsu(hist, n), 24);
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = d[i] > th ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) / 500));
  mask = dilate(erode(mask, w, h, r), w, h, r);      // apertura: toglie il rumore
  mask = erode(dilate(mask, w, h, r), w, h, r);      // chiusura: chiude piccoli buchi

  // componenti connesse (4-connessione)
  const labels = new Int32Array(n).fill(-1);
  const minPix = Math.max(12, o.minArea * n);
  const blobs = [];
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, per = 0, sL = 0, sA = 0, sB = 0;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      sL += L[i]; sA += A[i]; sB += B[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      let edge = false;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || !mask[j]) { edge = true; continue; }
        if (labels[j] === -1) { labels[j] = next; stack[sp++] = j; }
      }
      if (edge) per++;
    }
    blobs.push({ id: next, area, sx, sy, sxx, syy, sxy, per, sL, sA, sB, x0, y0, x1, y1 });
    next++;
  }

  const kept = [];
  const remap = new Int32Array(next).fill(-1);
  for (const b of blobs) {
    if (b.area < minPix || b.area > 0.35 * n) continue;
    remap[b.id] = kept.length;
    Object.assign(b, holesOf(labels, w, b));
    kept.push(describe(b, n));
  }
  for (let i = 0; i < n; i++) labels[i] = labels[i] >= 0 ? remap[labels[i]] : -1;
  return { w, h, labels, blobs: kept, bg, threshold: th };
}

// Conta i fori interni di un pezzo (rondelle, dadi…): zone di sfondo chiuse dentro il pezzo
function holesOf(labels, w, b) {
  const bw = b.x1 - b.x0 + 3, bh = b.y1 - b.y0 + 3, m = bw * bh;
  const seen = new Uint8Array(m); // 1 = pezzo, 2 = sfondo raggiunto dall'esterno
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const X = b.x0 + x - 1, Y = b.y0 + y - 1;
    if (x > 0 && y > 0 && x < bw - 1 && y < bh - 1 && labels[Y * w + X] === b.id) seen[y * bw + x] = 1;
  }
  const st = [0];
  seen[0] = 2;
  const fill = (start, mark) => {
    st.length = 0; st.push(start); seen[start] = mark;
    let c = 0;
    while (st.length) {
      const i = st.pop(); c++;
      const x = i % bw;
      for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, i - bw, i + bw]) {
        if (j >= 0 && j < m && !seen[j]) { seen[j] = mark; st.push(j); }
      }
    }
    return c;
  };
  fill(0, 2);
  let holes = 0, holeArea = 0;
  const minHole = Math.max(4, b.area * 0.004);
  for (let i = 0; i < m; i++) if (!seen[i]) {
    const c = fill(i, 3);
    if (c >= minHole) { holes++; holeArea += c; }
  }
  return { holes, holeArea };
}

function describe(b, n) {
  const cx = b.sx / b.area, cy = b.sy / b.area;
  const mxx = b.sxx / b.area - cx * cx, myy = b.syy / b.area - cy * cy, mxy = b.sxy / b.area - cx * cy;
  const tr = mxx + myy, det = mxx * myy - mxy * mxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = Math.max(1e-6, tr / 2 + disc), l2 = Math.max(1e-6, tr / 2 - disc);
  const hu1 = (mxx + myy) / b.area; // momento invariante di scala (secondo ordine normalizzato)
  return {
    area: b.area, cx, cy, box: [b.x0, b.y0, b.x1, b.y1], holes: b.holes,
    f: {
      holes: Math.min(b.holes, 4),
      hole: b.holeArea / (b.area + b.holeArea),
      elong: Math.sqrt(l2 / l1),
      circ: Math.min(1.5, (4 * Math.PI * b.area) / (b.per * b.per)),
      fill: Math.min(1.5, b.area / (4 * Math.PI * Math.sqrt(l1 * l2))),
      hu1: Math.log(hu1),
      L: b.sL / b.area, a: b.sA / b.area, b: b.sB / b.area,
      rel: Math.log(b.area / n),
    },
  };
}

// ---------- confronto con il catalogo ----------
const SCALE = { elong: 0.08, circ: 0.09, fill: 0.08, hu1: 0.12, holes: 0.35, hole: 0.06, L: 18, a: 7, b: 7, rel: 0.25 };

export function distance(f, g, useSize, colorOnly = false) {
  let s = 0, k = 0;
  for (const key in SCALE) {
    if (key === "rel" && !useSize) continue;
    if (f[key] === undefined || g[key] === undefined) continue; // campioni salvati con versioni precedenti
    if (colorOnly && !["L", "a", "b"].includes(key)) continue;
    const z = (f[key] - g[key]) / SCALE[key];
    s += z * z; k++;
  }
  return Math.sqrt(s / k);
}

// Estrae i descrittori dei pezzi da una foto di riferimento
export function referenceFeatures(canvas, opt) {
  const res = analyzeCanvas(canvas, opt);
  if (!res.blobs.length) return [];
  const maxA = Math.max(...res.blobs.map((b) => b.area));
  return res.blobs.filter((b) => b.area > 0.3 * maxA).slice(0, 12).map((b) => b.f);
}

// Assegna ogni pezzo all'articolo più simile e conta (anche pezzi a contatto)
export function classify(result, items, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  for (const b of result.blobs) {
    let best = null, bestD = Infinity;
    for (const it of items) for (const s of it.samples || []) {
      const dd = distance(b.f, s, o.useSize);
      if (dd < bestD) { bestD = dd; best = it.id; }
    }
    b.dist = bestD;
    b.item = bestD <= o.tolerance ? best : null;
    b.k = 1;
  }
  if (o.splitTouching) {
    // area tipica di un singolo pezzo per articolo = mediana delle aree riconosciute
    const areas = {}, holesPer = {};
    for (const b of result.blobs) if (b.item) { (areas[b.item] ||= []).push(b.area); (holesPer[b.item] ||= []).push(b.holes); }
    const single = {}, holeSingle = {};
    for (const id in areas) { single[id] = median(areas[id]); holeSingle[id] = Math.round(median(holesPer[id])); }
    for (const it of items) {
      // se nella foto non ci sono pezzi singoli di un articolo, uso i fori del campione
      if (holeSingle[it.id] === undefined && it.samples?.length) holeSingle[it.id] = Math.round(median(it.samples.map((s) => s.holes || 0)));
    }
    for (const b of result.blobs) {
      if (b.item) continue; // forma riconosciuta = pezzo singolo
      // pezzi a contatto: forma diversa, ma colore simile e area (o fori) multipla di un pezzo singolo
      let best = null, bestScore = Infinity, bestK = 1;
      for (const it of items) {
        if (!single[it.id]) continue;
        const ratio = b.area / single[it.id];
        if (ratio < 1.6) continue;
        let k = Math.round(ratio);
        const hs = holeSingle[it.id] || 0;
        if (hs > 0) {
          if (b.holes % hs !== 0 || b.holes === 0) continue; // i fori devono tornare
          k = b.holes / hs;
          if (Math.abs(ratio / k - 1) > 0.35) continue;
        } else if (b.holes > 0) continue;
        let cd = Infinity;
        for (const s of it.samples || []) cd = Math.min(cd, distance(b.f, s, false, true));
        if (cd > o.tolerance) continue;
        const score = cd + 3 * Math.abs(ratio / k - 1);
        if (score < bestScore) { bestScore = score; best = it.id; bestK = k; }
      }
      if (best) { b.item = best; b.k = Math.max(2, bestK); b.merged = true; }
    }
  }
  return result;
}

export function countsOf(result) {
  const counts = {};
  let unknown = 0;
  for (const b of result.blobs) {
    if (b.ignored) continue;
    if (b.item) counts[b.item] = (counts[b.item] || 0) + b.k;
    else unknown += b.k;
  }
  return { counts, unknown };
}

// Disegna contorni e numeri sopra l'immagine
export function renderOverlay(target, base, result, colorOf) {
  const { w, h, labels, blobs } = result;
  target.width = w;
  target.height = h;
  const ctx = target.getContext("2d");
  ctx.drawImage(base, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const rgb = blobs.map((b) => hexToRgb(b.ignored ? "#777777" : b.item ? colorOf(b.item) : "#ff3b30"));
  const t = Math.max(1, Math.round(Math.max(w, h) / 450));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = labels[i];
    if (l < 0) continue;
    let edge = false;
    for (let dy = -t; dy <= t && !edge; dy++) for (let dx = -t; dx <= t; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || labels[yy * w + xx] !== l) { edge = true; break; }
    }
    if (!edge) continue;
    const c = rgb[l], p = i * 4;
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2];
  }
  ctx.putImageData(img, 0, 0);
  const fs = Math.max(11, Math.round(Math.max(w, h) / 55));
  ctx.font = `bold ${fs}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const b of blobs) {
    if (b.ignored) continue;
    const label = b.k > 1 ? `×${b.k}` : b.item ? "" : "?";
    if (!label) continue;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,.75)";
    ctx.strokeText(label, b.cx, b.cy);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, b.cx, b.cy);
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
