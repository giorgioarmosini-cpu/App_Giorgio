// Esportazione PDF e Excel (xlsx): righe = articoli, una colonna per scansione + Totale.
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

const fmt = (ts) => new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
const safe = (s) => (s || "conteggio").replace(/[^\w\-]+/g, "_").slice(0, 40);

export function buildTable(session, items) {
  const scans = session.scans || [];
  const head = ["Codice", "Articolo", "Categoria", ...scans.map((s, i) => `Scansione ${i + 1}`), "Totale"];
  const used = items.filter((it) => scans.some((s) => (s.counts[it.id] || 0) > 0));
  const known = new Set(items.map((i) => i.id));
  const rows = used.map((it) => {
    const vals = scans.map((s) => s.counts[it.id] || 0);
    return [it.code || "", it.name, it.category || "", ...vals, vals.reduce((a, b) => a + b, 0)];
  });
  // articoli eliminati dal catalogo ma presenti nelle scansioni
  const orphan = new Set();
  for (const s of scans) for (const id in s.counts) if (!known.has(id) && s.counts[id]) orphan.add(id);
  for (const id of orphan) {
    const vals = scans.map((s) => s.counts[id] || 0);
    rows.push(["", "(articolo eliminato)", "", ...vals, vals.reduce((a, b) => a + b, 0)]);
  }
  const unk = scans.map((s) => s.unknown || 0);
  if (unk.some((v) => v)) rows.push(["", "Non riconosciuti", "", ...unk, unk.reduce((a, b) => a + b, 0)]);
  const tot = scans.map((_, i) => rows.reduce((a, r) => a + r[3 + i], 0));
  const foot = ["", "TOTALE PEZZI", "", ...tot, tot.reduce((a, b) => a + b, 0)];
  return { head, rows, foot, scans };
}

export async function exportXlsx(session, items) {
  const { head, rows, foot, scans } = buildTable(session, items);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[session.name], [`Creato: ${fmt(session.created)}`], [], head, ...rows, foot]);
  ws["!cols"] = head.map((h, i) => ({ wch: i === 1 ? 28 : i < 3 ? 14 : 12 }));
  XLSX.utils.book_append_sheet(wb, ws, "Conteggio");
  const ws2 = XLSX.utils.aoa_to_sheet([
    ["Scansione", "Data e ora", "Metodo", "Pezzi", "Note"],
    ...scans.map((s, i) => [i + 1, fmt(s.date), s.method, Object.values(s.counts).reduce((a, b) => a + b, 0) + (s.unknown || 0), s.note || ""]),
  ]);
  ws2["!cols"] = [{ wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 8 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Scansioni");
  const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
  await saveAndShare(`${safe(session.name)}.xlsx`, b64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export async function exportPdf(session, items) {
  const { head, rows, foot, scans } = buildTable(session, items);
  const landscape = head.length > 8;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  doc.setFontSize(16);
  doc.text(session.name, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Creato: ${fmt(session.created)}  ·  Scansioni: ${scans.length}  ·  Esportato: ${fmt(Date.now())}`, 14, 22);
  doc.setTextColor(0);
  autoTable(doc, {
    startY: 27, head: [head], body: rows, foot: [foot],
    styles: { fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: [20, 120, 100] },
    footStyles: { fillColor: [230, 230, 230], textColor: 20, fontStyle: "bold" },
    columnStyles: Object.fromEntries(head.map((_, i) => [i, i >= 3 ? { halign: "right" } : {}])),
    didParseCell: (d) => { if (d.column.index >= 3) d.cell.styles.halign = "right"; },
  });
  // dettaglio scansioni con miniatura
  let y = doc.lastAutoTable.finalY + 8;
  const H = doc.internal.pageSize.getHeight();
  doc.setFontSize(11);
  if (y > H - 50) { doc.addPage(); y = 16; }
  doc.text("Scansioni", 14, y);
  y += 4;
  const tw = 42, th = 32;
  let x = 14;
  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    if (x + tw > W - 10) { x = 14; y += th + 12; }
    if (y + th + 10 > H) { doc.addPage(); y = 16; x = 14; }
    if (s.thumb) {
      try { doc.addImage(s.thumb, "JPEG", x, y, tw, th, undefined, "FAST"); } catch { /* miniatura non valida */ }
    }
    doc.setFontSize(8);
    doc.text(`${i + 1}. ${fmt(s.date)}`, x, y + th + 4);
    doc.text(`${s.method}`, x, y + th + 8);
    x += tw + 6;
  }
  const b64 = doc.output("datauristring").split(",")[1];
  await saveAndShare(`${safe(session.name)}.pdf`, b64, "application/pdf");
}

export async function saveAndShare(name, base64, mime) {
  if (Capacitor.isNativePlatform()) {
    const r = await Filesystem.writeFile({ path: name, data: base64, directory: Directory.Cache });
    await Share.share({ title: name, files: [r.uri], dialogTitle: "Condividi o salva" });
    return;
  }
  const bin = atob(base64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
