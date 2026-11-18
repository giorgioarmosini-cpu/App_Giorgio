// Conteggio con IA online (Claude). Serve una chiave API inserita nelle Impostazioni.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";

const Result = z.object({
  conteggi: z.array(z.object({ id_articolo: z.string(), quantita: z.number() })),
  non_riconosciuti: z.number(),
  note: z.string(),
});

const SYSTEM = `Sei un sistema di conteggio pezzi per magazzino e produzione.
Ricevi le foto di riferimento di alcuni articoli di un catalogo e poi una foto da analizzare.
Conta con la massima precisione quanti pezzi di ciascun articolo sono visibili nella foto da analizzare.
Conta anche i pezzi sovrapposti, a contatto o parzialmente coperti, se sono riconoscibili.
I pezzi che non corrispondono a nessun articolo del catalogo vanno in non_riconosciuti.
Usa solo gli id articolo forniti. Includi ogni articolo del catalogo, anche con quantità 0.
In note scrivi in italiano, in una o due frasi, eventuali dubbi (pezzi coperti, foto sfocata, articoli simili).`;

const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);
const img = (dataUrl) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(dataUrl) } });

export async function countWithAI({ apiKey, photo, items }) {
  if (!apiKey) throw new Error("Inserisci la chiave API nelle Impostazioni.");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 5 * 60 * 1000, maxRetries: 2 });

  const perItem = items.length > 12 ? 1 : 2;
  const content = [{ type: "text", text: "CATALOGO ARTICOLI (foto di riferimento):" }];
  for (const it of items.slice(0, 40)) {
    const info = [`id=${it.id}`, `nome: ${it.name}`, it.code && `codice: ${it.code}`, it.category && `categoria: ${it.category}`, it.notes && `note: ${it.notes}`]
      .filter(Boolean).join(" | ");
    content.push({ type: "text", text: `Articolo ${info}` });
    for (const ph of (it.photos || []).slice(0, perItem)) content.push(img(ph));
  }
  content.push({ type: "text", text: "FOTO DA ANALIZZARE:" }, img(photo), { type: "text", text: "Conta i pezzi di ciascun articolo." });

  const msg = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: betaZodOutputFormat(Result) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  if (msg.stop_reason === "refusal") throw new Error("L'IA ha rifiutato di analizzare questa foto.");
  if (msg.stop_reason === "max_tokens") throw new Error("Risposta dell'IA incompleta, riprova.");
  const out = msg.parsed_output;
  if (!out) throw new Error("Risposta dell'IA non valida, riprova.");

  const valid = new Set(items.map((i) => i.id));
  const counts = {};
  for (const c of out.conteggi) {
    if (valid.has(c.id_articolo)) counts[c.id_articolo] = Math.max(0, Math.round(c.quantita));
  }
  return { counts, unknown: Math.max(0, Math.round(out.non_riconosciuti)), note: out.note };
}

export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Chiave API non valida.";
  if (e instanceof Anthropic.PermissionDeniedError) return "La chiave API non ha i permessi necessari.";
  if (e instanceof Anthropic.RateLimitError) return "Troppe richieste: attendi un minuto e riprova.";
  if (e instanceof Anthropic.BadRequestError) return "Richiesta non accettata: " + (e.message || "");
  if (e instanceof Anthropic.APIConnectionError) return "Nessuna connessione a internet.";
  if (e instanceof Anthropic.APIError) return "Errore del servizio IA, riprova più tardi.";
  return e?.message || String(e);
}
