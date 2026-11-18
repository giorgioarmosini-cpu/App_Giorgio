# Conta Pezzi (app Android)

App per **riconoscere e contare pezzi piccoli e uguali** (viti, rondelle, dadi,
pastiglie, componenti…) da **foto o video** fatti col telefono, confrontandoli
con un **catalogo fotografico** di articoli. Si possono fare **più scansioni** e
esportare il risultato in **PDF** e **Excel (xlsx)**, con una colonna per ogni
scansione più il totale.

## Scaricare e installare l'APK

Ogni volta che il codice cambia su `main`, GitHub costruisce l'APK da solo
(scheda **Actions**, procedura "Costruisci APK Android", circa 5–8 minuti).

1. Dal telefono apri la pagina **Releases** del repository
   (oppure `…/releases/latest/download/ContaPezzi.apk`).
2. Scarica **ContaPezzi.apk** e aprilo.
3. La prima volta Android chiede di consentire l'installazione da questa
   fonte (Chrome o File): consenti e installa.
4. Gli aggiornamenti si installano sopra la versione precedente e i dati restano.

> Se il repository è privato, per scaricare devi aver fatto l'accesso a GitHub
> sul telefono, oppure scaricare l'APK dal computer e copiarlo sul telefono.

## Come si usa

1. **Catalogo** → *Nuovo articolo*: nome, codice, categoria, associazioni/note
   (fornitore, ubicazione, prezzo…) e 1–5 **foto di riferimento** con alcuni
   pezzi ben separati.
2. **Conta** → *Nuovo conteggio* → **Foto**, **Video** o **Galleria**.
3. Nella schermata **Verifica** controlla il risultato: ogni pezzo ha il contorno
   del colore del suo articolo; `?` = non riconosciuto, `×N` = pezzi a contatto
   o sovrapposti.
   Tocca un pezzo per correggerlo, o usa **− / +** sulle quantità.
   **Conta con IA** usa l'intelligenza artificiale online (più precisa).
4. **Salva scansione**: diventa una colonna (S1, S2, …). Ripeti quante volte vuoi.
5. **PDF** / **Excel**: si apre il menu Condividi (WhatsApp, Mail, Drive, File…).

### Consigli per foto precise
- Sfondo **uniforme** e di colore diverso dai pezzi (es. foglio bianco per pezzi
  scuri, cartoncino nero per pezzi lucidi o chiari).
- Luce diffusa, senza ombre forti; foto **dall'alto**.
- **Pezzi sovrapposti o a contatto**: l'app li riconosce come gruppo e stima
  quanti sono (×2, ×3…) da area, fori visibili e "centri" dei pezzi. Funziona
  bene se nella stessa foto c'è anche qualche pezzo singolo (serve come misura)
  e se ogni pezzo resta visibile almeno per metà. Per mucchi fitti usa
  **Conta con IA**.
- Le foto di riferimento vanno fatte sullo stesso tipo di sfondo.

## Due modi di riconoscere

| | Offline (sul telefono) | IA online |
|---|---|---|
| Internet | non serve | serve |
| Costo | gratis | pochi centesimi a foto |
| Come funziona | separa i pezzi dallo sfondo e confronta forma, fori e colore con il catalogo | invia la foto e le foto del catalogo a Claude (Anthropic) |
| Quando usarlo | pezzi ben distinti, sfondo pulito | pezzi ammucchiati, articoli molto simili |

Per l'IA serve una **chiave API Anthropic** (console.anthropic.com), da inserire
in **Impostazioni**. La chiave resta solo sul telefono.

## Sviluppo

```bash
npm install
npm run dev        # prova nel browser
npm run build      # crea dist/
npx cap add android && npx cap sync android   # progetto Android (serve Android Studio)
```

- `src/vision.js` – riconoscimento e conteggio offline
- `src/ai.js` – conteggio con IA (Claude)
- `src/export.js` – PDF e xlsx
- `src/main.js` – interfaccia
- `keystore/debug.keystore` – chiave di firma di prova (pubblica, password
  `android`), serve solo perché ogni APK abbia la stessa firma. Per il Play Store
  servirà una chiave di rilascio privata.
