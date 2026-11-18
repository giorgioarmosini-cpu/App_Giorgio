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
   (fornitore, ubicazione, prezzo…) e 1–5 **foto di riferimento**.
2. **Profili** → *Nuovo profilo* (consigliato, indispensabile per pezzi piccoli):
   - scegli gli articoli del profilo e la **risoluzione** (fino a 4000 px);
   - **Foto campioni**: fotografa alcuni pezzi di ogni articolo, separati, sullo
     stesso sfondo e **alla stessa distanza** che userai per contare;
   - tocca i pezzi e indica a quale articolo appartengono (o *Assegna tutti a…*),
     poi **Impara da questi campioni**. L'app impara **dimensione reale**, colore,
     forma e fori di ogni articolo; puoi aggiungere altre foto campioni quando vuoi;
   - regola i criteri: tolleranza, sfondo, compensazione della luce, pezzi a
     contatto/sovrapposti, separazione, pezzi tagliati dal bordo.
3. **Conta** → *Nuovo conteggio* → scegli il **profilo** → **Foto**, **Video** o
   **Galleria**.
4. **Verifica**: zoom 1×–8×, `#` numera i pezzi. Ogni pezzo ha il contorno del
   colore del suo articolo; `?` = non riconosciuto, `×N` = gruppo di N pezzi.
   Tocca un pezzo per correggerlo, o usa **− / +**. **Insegna al profilo** aggiunge
   i pezzi di questa foto ai campioni: il profilo migliora con l'uso.
   **Conta con IA** usa l'intelligenza artificiale online.
5. **Salva scansione**: diventa una colonna (S1, S2, …). Ripeti quante volte vuoi.
6. **PDF** / **Excel**: si apre il menu Condividi (WhatsApp, Mail, Drive, File…).

### Criteri di separazione e vaglio

- **Risoluzione alta** (2400–4000 px) per vedere pezzi di pochi millimetri.
- **Sfondo locale**: compensa luce non uniforme e ombre leggere.
- **Vaglio automatico** di polvere e riflessi (o, con il profilo, tutto ciò che è
  più piccolo di 1/3 del pezzo più piccolo appreso).
- **Dimensione reale appresa** dal profilo: distingue articoli uguali ma di misura
  diversa (es. M3 e M4) e scarta oggetti troppo grandi o piccoli.
- **Fori** (rondelle, dadi): un pezzo deve avere lo stesso numero di fori.
- **Pezzi a contatto o sovrapposti**: stimati da area, fori e "centri"; quando i
  centri tornano, il gruppo viene **tagliato** in pezzi singoli (watershed).
- **Pezzi tagliati dal bordo**: contati se colore e dimensione sono plausibili,
  oppure ignorati con l'apposita opzione.

### Consigli per foto precise
- Sfondo **uniforme** e di colore diverso dai pezzi (es. foglio bianco per pezzi
  scuri, cartoncino nero per pezzi lucidi o chiari).
- Luce diffusa, senza ombre forti; foto **dall'alto**, meglio con un supporto
  fisso: la distanza deve essere la stessa della foto dei campioni del profilo.
- Riempi l'inquadratura con l'area dei pezzi: più pixel per pezzo = più precisione.

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
