// Riconoscimento e conteggio offline.
// 1) modello dello sfondo (globale o locale, per luce non uniforme)
// 2) soglia automatica, pulizia morfologica, componenti connesse
// 3) vaglio: rumore/polvere, pezzi troppo grandi, pezzi tagliati dal bordo
// 4) descrittori di forma, fori e colore
// 5) classificazione: catalogo (invariante alla scala) o profilo appreso (con dimensione reale)
// 6) pezzi a contatto/sovrapposti: stima da area, fori e centri; separazione watershed

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
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export function cropCanvas(canvas, [x0, y0, x1, y1]) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, x1 - x0);
  c.height = Math.max(1, y1 - y0);
  c.getContext("2d").drawImage(canvas, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

export function canvasToJpeg(canvas, maxDim = canvas.width, quality = 0.85) {
  const c = maxDim < Math.max(canvas.width, canvas.height) ? drawToCanvas(canvas, maxDim) : canvas;
  return c.toDataURL("image/jpeg", quality);
}

// Estrae alcuni fotogrammi distribuiti lungo il video
export async function videoFrames(file, n = 5, maxDim = 1920) {
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
function rgbToLab(r8, g8, b8, out) {
  const r = LIN[Math.min(255, r8 | 0)], g = LIN[Math.min(255, g8 | 0)], b = LIN[Math.min(255, b8 | 0)];
  const x = f3((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f3(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f3((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  out[0] = 116 * y - 16;
  out[1] = 500 * (x - y);
  out[2] = 200 * (y - z);
  return out;
}
// tabella colore 6 bit per canale: Lab veloce anche su foto da 10+ megapixel
const LAB_LUT = (() => {
  const t = new Float32Array(64 * 64 * 64 * 3), o = [0, 0, 0];
  for (let r = 0; r < 64; r++) for (let g = 0; g < 64; g++) for (let b = 0; b < 64; b++) {
    rgbToLab(r * 4 + 2, g * 4 + 2, b * 4 + 2, o);
    const i = ((r << 12) | (g << 6) | b) * 3;
    t[i] = o[0]; t[i + 1] = o[1]; t[i + 2] = o[2];
  }
  return t;
})();
const labIdx = (data, p) => (((data[p] >> 2) << 12) | ((data[p + 1] >> 2) << 6) | (data[p + 2] >> 2)) * 3;

export function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
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

// ---------- morfologia (3x3, veloce) ----------
function morph(mask, w, h, erode) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? -w : 0, yd = y < h - 1 ? w : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, xl = x > 0 ? -1 : 0, xr = x < w - 1 ? 1 : 0;
      const s = mask[i] + mask[i + xl] + mask[i + xr] + mask[i + yu] + mask[i + yd] +
        mask[i + yu + xl] + mask[i + yu + xr] + mask[i + yd + xl] + mask[i + yd + xr];
      out[i] = erode ? (s === 9 ? 1 : 0) : (s > 0 ? 1 : 0);
    }
  }
  return out;
}

// ---------- impostazioni ----------
export const DEFAULTS = {
  resolution: 2400,     // lato lungo usato per l'analisi (px)
  background: "auto",   // auto | chiaro | scuro
  localBg: true,        // sfondo stimato zona per zona (luce non uniforme)
  minArea: 0.00002,     // area minima assoluta (frazione dell'immagine)
  autoNoise: true,      // scarta polvere e riflessi molto più piccoli dei pezzi
  excludeBorder: false, // ignora i pezzi tagliati dal bordo della foto
  tolerance: 2.2,       // soglia di somiglianza
  useSize: false,       // (senza profilo) la distanza della foto è sempre la stessa
  splitTouching: true,  // conta i pezzi a contatto/sovrapposti
  separate: true,       // separa davvero i pezzi a contatto (watershed)
  videoFrames: 5,
};

// ---------- segmentazione ----------
export function analyzeCanvas(canvas, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const w = canvas.width, h = canvas.height, n = w * h;
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const LUT = LAB_LUT;

  // sfondo globale = mediana dei pixel del bordo
  const step = Math.max(1, Math.round((w + h) / 600));
  const bl = [], ba = [], bb = [];
  const pushB = (i) => { const k = labIdx(data, i * 4); bl.push(LUT[k]); ba.push(LUT[k + 1]); bb.push(LUT[k + 2]); };
  for (let x = 0; x < w; x += step) { pushB(x); pushB((h - 1) * w + x); }
  for (let y = 0; y < h; y += step) { pushB(y * w); pushB(y * w + w - 1); }
  const bg = [median(bl), median(ba), median(bb)];

  // sfondo locale: griglia di luminosità (mediana per zona, filtrata), limitata a ±25 dal globale
  const cell = Math.max(24, Math.round(Math.max(w, h) / 18));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  let grid = new Float32Array(gw * gh).fill(bg[0]);
  if (o.localBg) {
    const s2 = Math.max(1, Math.round(cell / 12));
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const vals = [];
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += s2)
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += s2) {
          const k = labIdx(data, (y * w + x) * 4);
          const da = LUT[k + 1] - bg[1], db = LUT[k + 2] - bg[2];
          if (da * da + db * db < 100 && Math.abs(LUT[k] - bg[0]) < 30) vals.push(LUT[k]); // solo pixel tipo sfondo
        }
      grid[gy * gw + gx] = vals.length > 8 ? median(vals) : bg[0];
    }
    // filtro mediano 3x3 sulla griglia, due passate
    for (let pass = 0; pass < 2; pass++) {
      const g2 = new Float32Array(grid.length);
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const v = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = gx + dx, Y = gy + dy;
          if (X >= 0 && Y >= 0 && X < gw && Y < gh) v.push(grid[Y * gw + X]);
        }
        g2[gy * gw + gx] = median(v);
      }
      grid = g2;
    }
  }

  // mappa di differenza dallo sfondo
  const d = new Uint8Array(n), hist = new Uint32Array(256);
  const wl = o.background === "auto" ? 0.6 : 1;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, y / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const bgL = (grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx) * (1 - ty) + (grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx) * ty;
      const i = y * w + x, k = labIdx(data, i * 4);
      let dl = LUT[k] - bgL;
      if (o.background === "chiaro" && dl > 0) dl = 0;   // pezzi più scuri dello sfondo
      if (o.background === "scuro" && dl < 0) dl = 0;    // pezzi più chiari dello sfondo
      const da = LUT[k + 1] - bg[1], db = LUT[k + 2] - bg[2];
      const v = Math.min(255, 2 * Math.sqrt(wl * dl * dl + da * da + db * db));
      d[i] = v;
      hist[v | 0]++;
    }
  }
  // soglia: Otsu, ma mai sopra il "rumore" dello sfondo misurato sui bordi
  const bd = [];
  for (let x = 0; x < w; x += step) bd.push(d[x], d[(h - 1) * w + x]);
  for (let y = 0; y < h; y += step) bd.push(d[y * w], d[y * w + w - 1]);
  const noise = quantile(bd, 0.95);
  const th = o.threshold || Math.max(20, Math.min(otsu(hist, n), noise * 1.5 + 14));

  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = d[i] > th ? 1 : 0;
  mask = morph(morph(mask, w, h, true), w, h, false);  // apertura: toglie i puntini
  mask = morph(morph(mask, w, h, false), w, h, true);  // chiusura: chiude piccole crepe

  // componenti connesse (4-connessione)
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const raw = [];
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = s;
    labels[s] = next;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && labels[i - 1] === -1) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && labels[i + 1] === -1) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && labels[i - w] === -1) { labels[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && labels[i + w] === -1) { labels[i + w] = next; stack[sp++] = i + w; }
    }
    raw.push({ id: next, area, box: [x0, y0, x1, y1] });
    next++;
  }

  // vaglio: area minima/massima, polvere, bordo
  let minPix = Math.max(6, o.minArea * n);
  let cand = raw.filter((b) => b.area >= minPix && b.area <= (o.maxArea ? o.maxArea * n : 0.35 * n));
  let dropped = raw.length - cand.length;
  if (o.autoNoise && cand.length >= 3) {
    // area "tipica" pesata per area: i granelli molto più piccoli sono polvere o riflessi
    const sorted = cand.map((b) => b.area).sort((a, b) => a - b);
    const tot = sorted.reduce((a, b) => a + b, 0);
    let acc = 0, typical = sorted[sorted.length - 1];
    for (const a of sorted) { acc += a; if (acc >= tot / 2) { typical = a; break; } }
    const before = cand.length;
    cand = cand.filter((b) => b.area >= typical * 0.06);
    dropped += before - cand.length;
  }
  if (o.excludeBorder) {
    const before = cand.length;
    cand = cand.filter((b) => b.box[0] > 0 && b.box[1] > 0 && b.box[2] < w - 1 && b.box[3] < h - 1);
    dropped += before - cand.length;
  }
  const remap = new Int32Array(next).fill(-1);
  cand.forEach((b, i) => (remap[b.id] = i));
  for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = remap[labels[i]];

  const result = { w, h, n, labels, data, blobs: [], bg, threshold: th, dropped };
  result.blobs = cand.map((b, i) => measure(result, i, b.box));
  return result;
}

// Misura un pezzo (etichetta id) dentro il suo riquadro: area, momenti, perimetro, colore, fori
function measure(result, id, box) {
  const { labels, w, h, data, n } = result;
  const [bx0, by0, bx1, by1] = box;
  let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, per = 0, sr = 0, sg = 0, sb = 0;
  let x0 = bx1, y0 = by1, x1 = bx0, y1 = by0;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const i = y * w + x;
    if (labels[i] !== id) continue;
    area++;
    const X = x - bx0, Y = y - by0; // coordinate locali: momenti numericamente stabili
    sx += X; sy += Y; sxx += X * X; syy += Y * Y; sxy += X * Y;
    const p = i * 4;
    sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (x === 0 || x === w - 1 || y === 0 || y === h - 1 || labels[i - 1] !== id || labels[i + 1] !== id || labels[i - w] !== id || labels[i + w] !== id) per++;
  }
  area = Math.max(1, area);
  const bb = [x0, y0, x1, y1];
  const { holes, holeArea } = holesOf(labels, w, id, bb, area);
  const cx = sx / area, cy = sy / area;
  const mxx = sxx / area - cx * cx, myy = syy / area - cy * cy, mxy = sxy / area - cx * cy;
  const tr = mxx + myy, det = mxx * myy - mxy * mxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = Math.max(1e-6, tr / 2 + disc), l2 = Math.max(1e-6, tr / 2 - disc);
  const lab = rgbToLab(sr / area, sg / area, sb / area, [0, 0, 0]);
  return {
    area, cx: cx + bx0, cy: cy + by0, box: bb, holes, k: 1,
    f: {
      holes: Math.min(holes, 4),
      hole: holeArea / (area + holeArea),
      elong: Math.sqrt(l2 / l1),
      circ: Math.min(1.5, (4 * Math.PI * area) / (per * per)),
      fill: Math.min(1.5, area / (4 * Math.PI * Math.sqrt(l1 * l2))),
      hu1: Math.log(Math.max(1e-6, (mxx + myy) / area)),
      L: lab[0], a: lab[1], b: lab[2],
      rel: Math.log(area / n),
    },
  };
}

// Conta i fori interni (rondelle, dadi…): zone di sfondo chiuse dentro il pezzo
function holesOf(labels, w, id, box, area) {
  const [x0b, y0b, x1b, y1b] = box;
  const bw = x1b - x0b + 3, bh = y1b - y0b + 3, m = bw * bh;
  const seen = new Uint8Array(m);
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++)
    if (labels[(y0b + y - 1) * w + x0b + x - 1] === id) seen[y * bw + x] = 1;
  const st = [];
  const fill = (start, mark) => {
    st.length = 0; st.push(start); seen[start] = mark;
    let c = 0;
    while (st.length) {
      const i = st.pop(), x = i % bw;
      c++;
      if (x > 0 && !seen[i - 1]) { seen[i - 1] = mark; st.push(i - 1); }
      if (x < bw - 1 && !seen[i + 1]) { seen[i + 1] = mark; st.push(i + 1); }
      if (i >= bw && !seen[i - bw]) { seen[i - bw] = mark; st.push(i - bw); }
      if (i + bw < m && !seen[i + bw]) { seen[i + bw] = mark; st.push(i + bw); }
    }
    return c;
  };
  fill(0, 2);
  let holes = 0, holeArea = 0;
  const minHole = Math.max(4, area * 0.004);
  for (let i = 0; i < m; i++) if (!seen[i]) {
    const c = fill(i, 3);
    if (c >= minHole) { holes++; holeArea += c; }
  }
  return { holes, holeArea };
}

// Trasformata di distanza (chamfer) dentro il riquadro di un pezzo.
// Restituisce raggio inscritto, "centri" separati e la mappa (per la separazione).
function distanceMap(result, idx, rs = 0, elong = 1) {
  const { labels, w } = result, b = result.blobs[idx];
  const [x0, y0, x1, y1] = b.box, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const D = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) D[y * bw + x] = labels[(y0 + y) * w + x0 + x] === idx ? 1e9 : 0;
  const S = Math.SQRT2;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = y * bw + x;
    if (!D[i]) continue;
    D[i] = Math.min(D[i], x > 0 ? D[i - 1] + 1 : 1, y > 0 ? D[i - bw] + 1 : 1,
      x > 0 && y > 0 ? D[i - bw - 1] + S : S, x < bw - 1 && y > 0 ? D[i - bw + 1] + S : S);
  }
  let max = 0;
  for (let y = bh - 1; y >= 0; y--) for (let x = bw - 1; x >= 0; x--) {
    const i = y * bw + x;
    if (!D[i]) continue;
    D[i] = Math.min(D[i], x < bw - 1 ? D[i + 1] + 1 : 1, y < bh - 1 ? D[i + bw] + 1 : 1,
      x < bw - 1 && y < bh - 1 ? D[i + bw + 1] + S : S, x > 0 && y < bh - 1 ? D[i + bw - 1] + S : S);
    if (D[i] > max) max = D[i];
  }
  if (!rs) return { max, peaks: [], D, bw, bh };
  const cand = [];
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x, v = D[i];
    if (v < rs * 0.6) continue;
    let isMax = true;
    for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && D[yy * bw + xx] > v) { isMax = false; break; }
    }
    if (isMax) cand.push([v, x, y]);
  }
  cand.sort((p, q) => q[0] - p[0]);
  // i pezzi allungati hanno una "cresta": allargo la zona di soppressione
  const keep = [], R2 = (rs * (0.8 + 1.1 * (1 - Math.min(1, elong)))) ** 2;
  for (const c of cand) if (keep.every((k) => (k[1] - c[1]) ** 2 + (k[2] - c[2]) ** 2 > R2)) keep.push(c);
  return { max, peaks: keep, D, bw, bh };
}

// Separa un gruppo in più pezzi: ogni pixel va al "centro" più vicino lungo il pezzo
// (watershed geodetico). Restituisce gli indici dei nuovi pezzi.
function separateBlob(result, idx, dm) {
  const { labels, w } = result, b = result.blobs[idx];
  const [x0, y0] = b.box, { bw, bh, peaks, D } = dm;
  const own = new Int32Array(bw * bh).fill(-1);
  let queue = [];
  peaks.forEach((p, k) => { const i = p[2] * bw + p[1]; own[i] = k; queue.push(i); });
  while (queue.length) {
    const nextQ = [];
    for (const i of queue) {
      const x = i % bw, k = own[i];
      if (x > 0 && own[i - 1] === -1 && D[i - 1]) { own[i - 1] = k; nextQ.push(i - 1); }
      if (x < bw - 1 && own[i + 1] === -1 && D[i + 1]) { own[i + 1] = k; nextQ.push(i + 1); }
      if (i >= bw && own[i - bw] === -1 && D[i - bw]) { own[i - bw] = k; nextQ.push(i - bw); }
      if (i + bw < bw * bh && own[i + bw] === -1 && D[i + bw]) { own[i + bw] = k; nextQ.push(i + bw); }
    }
    queue = nextQ;
  }
  const ids = [idx];
  for (let k = 1; k < peaks.length; k++) ids.push(result.blobs.length + k - 1);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = own[y * bw + x];
    if (k >= 0) labels[(y0 + y) * w + x0 + x] = ids[k];
  }
  const parts = ids.map((id) => measure(result, id, b.box));
  result.blobs[idx] = parts[0];
  for (let k = 1; k < parts.length; k++) result.blobs.push(parts[k]);
  return ids;
}

// ---------- confronto ----------
const SCALE = { elong: 0.08, circ: 0.09, fill: 0.08, hu1: 0.12, holes: 0.35, hole: 0.06, L: 18, a: 7, b: 7, rel: 0.25 };
const COLOR = ["L", "a", "b"];

export function distance(f, g, useSize, colorOnly = false) {
  let s = 0, k = 0;
  for (const key in SCALE) {
    if (key === "rel" && !useSize) continue;
    if (f[key] === undefined || g[key] === undefined) continue;
    if (colorOnly && !COLOR.includes(key)) continue;
    const z = (f[key] - g[key]) / SCALE[key];
    s += z * z; k++;
  }
  return k ? Math.sqrt(s / k) : Infinity;
}

// Estrae i descrittori dei pezzi da una foto di riferimento del catalogo
export function referenceFeatures(canvas, opt) {
  const res = analyzeCanvas(canvas, { ...opt, excludeBorder: false });
  if (!res.blobs.length) return [];
  const maxA = Math.max(...res.blobs.map((b) => b.area));
  return res.blobs.filter((b) => b.area > 0.3 * maxA).slice(0, 12).map((b) => b.f);
}

// Statistiche apprese da un profilo per un articolo: media e dispersione di ogni descrittore
export function learnStats(entry) {
  const feats = entry?.feats || [];
  if (!feats.length) return null;
  const mean = {}, std = {};
  for (const key in SCALE) {
    if (key === "rel") continue;
    const v = feats.map((f) => f[key]).filter((x) => x !== undefined);
    if (!v.length) continue;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
    mean[key] = m;
    std[key] = Math.max(sd, SCALE[key] * (v.length >= 5 ? 0.3 : 0.6));
  }
  const areas = entry.areas || [];
  const la = areas.map(Math.log);
  const lm = la.length ? la.reduce((a, b) => a + b, 0) / la.length : null;
  const ls = la.length > 1 ? Math.sqrt(la.reduce((a, b) => a + (b - lm) ** 2, 0) / (la.length - 1)) : 0;
  return {
    n: feats.length, mean, std,
    logArea: lm, logAreaStd: Math.max(ls, 0.12),
    areaFrac: areas.length ? median(areas) : null,
    minAreaFrac: areas.length ? Math.min(...areas) : null,
    maxAreaFrac: areas.length ? Math.max(...areas) : null,
    holes: Math.round(median(feats.map((f) => f.holes || 0))),
    rsRatio: entry.rs?.length ? median(entry.rs) : null,
    elong: median(feats.map((f) => f.elong)),
  };
}

function zDistance(f, st, colorOnly = false) {
  let s = 0, k = 0;
  for (const key in st.mean) {
    if (colorOnly && !COLOR.includes(key)) continue;
    if (f[key] === undefined) continue;
    const z = (f[key] - st.mean[key]) / st.std[key];
    s += z * z; k++;
  }
  return k ? Math.sqrt(s / k) : Infinity;
}

// Prepara i "modelli" degli articoli: campioni del catalogo + statistiche del profilo
export function buildModels(items, profile) {
  const scope = profile?.itemIds?.length ? items.filter((i) => profile.itemIds.includes(i.id)) : items;
  return scope.map((it) => {
    const samples = (it.photoSamples || []).flat();
    const st = profile ? learnStats(profile.learn?.[it.id]) : null;
    return {
      id: it.id, samples, st,
      holes: st ? st.holes : Math.round(median(samples.map((s) => s.holes || 0))),
      elong: st ? st.elong : median(samples.map((s) => s.elong)),
    };
  });
}

// Opzioni di analisi derivate dal profilo (vaglio per dimensione appresa)
export function profileOptions(profile, models, base) {
  const o = { ...base, ...(profile?.opts || {}) };
  const mins = models.map((m) => m.st?.minAreaFrac).filter((x) => x);
  const maxs = models.map((m) => m.st?.maxAreaFrac).filter((x) => x);
  if (mins.length) {
    o.minArea = Math.min(...mins) * 0.3;  // più piccolo di 1/3 del pezzo più piccolo = polvere
    o.autoNoise = false;
  }
  if (maxs.length) o.maxArea = Math.min(0.35, Math.max(...maxs) * 40); // mucchi fino a ~40 pezzi
  return o;
}

function matchDistance(b, m, o, colorOnly = false) {
  if (m.st) {
    let d = zDistance(b.f, m.st, colorOnly);
    if (!colorOnly && m.st.logArea !== null) {
      const zs = (b.f.rel - m.st.logArea) / m.st.logAreaStd; // dimensione reale appresa
      d = Math.sqrt((d * d * 4 + zs * zs * 1.5) / 5.5);
    }
    return d;
  }
  let best = Infinity;
  for (const s of m.samples) {
    if (!colorOnly && s.holes !== undefined && s.holes !== b.f.holes) continue;
    best = Math.min(best, distance(b.f, s, o.useSize, colorOnly));
  }
  return best;
}

// Assegna ogni pezzo all'articolo più simile e conta (anche pezzi a contatto/sovrapposti)
export function classify(result, models, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const assign = (b) => {
    let best = null, bestD = Infinity;
    for (const m of models) {
      if (m.st && m.st.holes !== b.f.holes) continue; // numero di fori diverso = articolo diverso
      const dd = matchDistance(b, m, o);
      if (dd < bestD) { bestD = dd; best = m.id; }
    }
    b.dist = bestD;
    b.item = bestD <= o.tolerance ? best : null;
    b.k = 1;
    b.merged = false;
  };
  result.blobs.forEach(assign);
  if (o.splitTouching) splitMerged(result, models, o, assign);
  edgePieces(result, models, o);
  return result;
}

// Pezzi tagliati dal bordo della foto: forma incompleta, ma colore giusto e dimensione plausibile
function edgePieces(result, models, o) {
  const { w, h, n } = result;
  const single = {};
  for (const m of models) {
    if (m.st?.areaFrac) single[m.id] = m.st.areaFrac * n;
    else {
      const a = result.blobs.filter((b) => b.item === m.id && !b.merged).map((b) => b.area);
      if (a.length) single[m.id] = median(a);
    }
  }
  for (const b of result.blobs) {
    if (b.item || b.ignored) continue;
    const [x0, y0, x1, y1] = b.box;
    if (x0 > 0 && y0 > 0 && x1 < w - 1 && y1 < h - 1) continue;
    let best = null, bd = Infinity;
    for (const m of models) {
      if (!single[m.id]) continue;
      const r = b.area / single[m.id];
      if (r < 0.25 || r > 1.3) continue;
      const cd = matchDistance(b, m, o, true);
      if (cd < bd) { bd = cd; best = m.id; }
    }
    if (best && bd <= o.tolerance) { b.item = best; b.edge = true; }
  }
}

function splitMerged(result, models, o, assign) {
  const blobs = result.blobs, n = result.n;
  const info = {};
  for (const m of models) {
    const singles = [];
    blobs.forEach((b, i) => { if (b.item === m.id) singles.push(i); });
    let area = m.st?.areaFrac ? m.st.areaFrac * n : null;               // dimensione appresa dal profilo
    if (!area && singles.length) area = median(singles.map((i) => blobs[i].area)); // oppure dai pezzi singoli
    if (!area) continue;
    const compact = m.holes === 0 && m.elong > 0.45;
    let rs = m.st?.rsRatio ? m.st.rsRatio * Math.sqrt(area) : 0;
    if (!rs && compact && singles.length) rs = median(singles.slice(0, 15).map((i) => distanceMap(result, i).max));
    info[m.id] = { area, compact, rs, holes: m.holes, elong: m.elong };
  }

  const estimate = (b, idx, inf, ratio) => {
    let k = ratio >= 1.6 ? Math.round(ratio) : 1, dm = null;
    if (inf.holes > 0 && b.holes > inf.holes) k = Math.max(k, Math.ceil(b.holes / inf.holes));
    if (inf.compact && inf.rs) {
      dm = distanceMap(result, idx, inf.rs, inf.elong);
      k = Math.max(k, dm.peaks.length);
    }
    while (k > 2 && ratio / k < 0.7) k--; // ogni pezzo sovrapposto resta in buona parte visibile
    return { k, dm };
  };

  const count0 = blobs.length;
  for (let idx = 0; idx < count0; idx++) {
    const b = blobs[idx];
    let best = null, bestScore = Infinity, bestK = 1, bestDm = null;
    if (b.item) {
      // forma simile a un pezzo singolo ma più grande: possono essere pezzi sovrapposti
      const inf = info[b.item];
      if (!inf) continue;
      const ratio = b.area / inf.area;
      if (ratio < 1.3) continue;
      const { k, dm } = estimate(b, idx, inf, ratio);
      if (k < 2 || ratio / k < 0.45) continue;
      best = b.item; bestK = k; bestDm = dm;
    } else {
      for (const m of models) {
        const inf = info[m.id];
        if (!inf) continue;
        const ratio = b.area / inf.area;
        if (ratio < 1.15) continue;
        const cd = matchDistance(b, m, o, true);
        if (cd > o.tolerance) continue;
        const { k, dm } = estimate(b, idx, inf, ratio);
        if (k < 2) continue;
        const fr = ratio / k; // 1 = a contatto, <1 = sovrapposti
        if (fr > 1.3 || fr < 0.45) continue;
        let score = cd + 2 * Math.max(0, fr - 1.1) + 2 * Math.max(0, 0.65 - fr);
        if (inf.holes === 0 && b.holes > 0) score += 1;
        if (inf.holes > 0 && b.holes === 0) score += 1.5;
        if (score < bestScore) { bestScore = score; best = m.id; bestK = k; bestDm = dm; }
      }
    }
    if (!best) continue;
    // separazione vera quando i centri trovati corrispondono al numero stimato
    if (o.separate && bestDm && bestDm.peaks.length >= 2 && bestDm.peaks.length === bestK) {
      const ids = separateBlob(result, idx, bestDm);
      for (const id of ids) {
        const p = result.blobs[id];
        assign(p);
        if (!p.item) {
          // parte di un gruppo: decido col colore (la forma è parzialmente coperta)
          let bm = null, bd = Infinity;
          for (const m of models) { const cd = matchDistance(p, m, o, true); if (cd < bd) { bd = cd; bm = m.id; } }
          p.item = bd <= o.tolerance ? bm : best;
        }
        p.split = true;
      }
    } else {
      b.item = best;
      b.k = bestK;
      b.merged = true;
    }
  }
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

// riquadro che contiene tutti i pezzi trovati (per mandare all'IA solo la parte utile)
export function contentBox(result, margin = 0.04) {
  const bl = result.blobs.filter((b) => !b.ignored);
  if (!bl.length) return [0, 0, result.w, result.h];
  const m = Math.round(Math.max(result.w, result.h) * margin);
  return [
    Math.max(0, Math.min(...bl.map((b) => b.box[0])) - m), Math.max(0, Math.min(...bl.map((b) => b.box[1])) - m),
    Math.min(result.w, Math.max(...bl.map((b) => b.box[2])) + m), Math.min(result.h, Math.max(...bl.map((b) => b.box[3])) + m),
  ];
}

// Disegna contorni e numeri sopra l'immagine
export function renderOverlay(target, base, result, colorOf, { numbers = false } = {}) {
  const { w, h, labels, blobs } = result;
  target.width = w;
  target.height = h;
  const ctx = target.getContext("2d");
  ctx.drawImage(base, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const rgb = blobs.map((b) => hexToRgb(b.ignored ? "#777777" : b.item ? colorOf(b.item) : "#ff3b30"));
  const medA = median(blobs.map((b) => b.area)) || 100;
  const t = Math.max(1, Math.min(Math.round(Math.max(w, h) / 600), Math.round(Math.sqrt(medA) / 10)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = labels[i];
    if (l < 0) continue;
    const edge = x < t || y < t || x >= w - t || y >= h - t ||
      labels[i - t] !== l || labels[i + t] !== l || labels[i - t * w] !== l || labels[i + t * w] !== l ||
      labels[i - 1] !== l || labels[i + 1] !== l || labels[i - w] !== l || labels[i + w] !== l;
    if (!edge) continue;
    const c = rgb[l], p = i * 4;
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2];
  }
  ctx.putImageData(img, 0, 0);
  const fs = Math.round(Math.max(10, Math.min(Math.max(w, h) / 55, Math.sqrt(medA) * 0.7)));
  ctx.font = `bold ${fs}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, fs / 5);
  let num = 0;
  for (const b of blobs) {
    if (b.ignored) continue;
    let label = b.k > 1 ? `×${b.k}` : b.item ? "" : "?";
    if (numbers) { num += b.k; label = b.k > 1 ? `${num - b.k + 1}-${num}` : String(num); }
    if (!label) continue;
    ctx.strokeStyle = "rgba(0,0,0,.8)";
    ctx.strokeText(label, b.cx, b.cy);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, b.cx, b.cy);
  }
}

// rapporto raggio inscritto / radice dell'area di un pezzo (per il profilo)
export function inscribedRatio(result, idx) {
  const b = result.blobs[idx];
  return distanceMap(result, idx).max / Math.sqrt(b.area);
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
