# reisebegleitung

> **Beta** – in Entwicklung, Funktionen und Schnittstellen können sich noch ändern. Angaben ohne Gewähr,
> siehe [Haftungsausschluss](#haftungsausschluss).

Persönliche Reisebegleitung für Bahnreisen – im Stil eines Bahn-Navigators, auf Basis offener Fahrplandaten von
[Transitous](https://transitous.org) (MOTIS 2, in Deutschland mit Echtzeit aus DELFI).

*A personal journey companion for train trips on top of the open Transitous/MOTIS API – usable as a library,
as building blocks for your own dashboard, or as a self-hosted Cloudflare app with passkey login.*

- Verbindungen suchen (Abfahrt/Ankunft) mit Ticketregeln: Flexpreis, Sparpreis, BahnCard 100, Deutschlandticket
- Live-Fortschritt: vor Abfahrt · unterwegs mit nächstem Halt · Umstieg · angekommen
- Abschnitte mit allen Zwischenhalten, Abfahrts- und Ankunftsgleisen (Zug) bzw. Steigen (Tram/Bus), Gleiswechseln und Verspätungen.
  Fehlen Zuggleise in den offenen Daten (häufig bei Regionalzügen und S-Bahnen), ergänzt sie die App optional aus DB IRIS
  (`IRIS_PLATFORMS`, inoffizielle Schnittstelle ohne Key, kann wegfallen) – erst für die gewählte Reise, nicht in der Suche, mit
  höchstens 16 Unteranfragen je Aufruf (Cloudflare Free erlaubt 50); einmal gefunden, kostet das Auffrischen nur die Gleiswechsel-Abfrage.
- Umstiegsampel: ok · knapp · nicht erreichbar · fällt aus · geschafft
- Check-in je Zug („Eingestiegen“): Status „An Bord“, Nachfrage „Zug verpasst?“, neue Verbindung ab dem Halt
- Aktualisierung im Hintergrund (Cron jede Minute), auch wenn niemand die Seite offen hat
- **Alternativen**, sobald ein Anschluss nicht erreichbar ist, ein Zug ausfällt oder ein Zug verpasst wurde – mit
  Hinweis, ob sie mit dem Ticket nutzbar sind (Zugbindung aufgehoben, Deutschlandticket); „Übernehmen“ ersetzt die
  restliche Reise; **jederzeit zurück zur ursprünglichen Verbindung** („↩ Zurück zur ursprünglichen Verbindung“, Check-ins auf dem
  gemeinsamen Anfang bleiben, danach Live-Abgleich – passt sie weiterhin nicht, erscheinen wieder Alternativen)
- **Benachrichtigungen** per Web Push (ohne Zusatz-App; auf iPhone/iPad nach „Zum Home-Bildschirm“)
- **Teilen-Links** für Familie und Freunde: Reise live verfolgen ohne Anmeldung (inkl. „An Bord“, ohne Ticketangaben),
  gültig bis 2 h nach der tatsächlichen Ankunft, jederzeit widerrufbar; Umschalter „Reduziert“ (Standard: Fokus auf den aktuellen Ort –
  Strecke mit Start, Umstiegen und Ziel, aktuelle Fahrt mit eigenem Fortschritt) / „Detailliert“, die Wahl merkt sich der Browser; dazu eine einfache Ansicht ohne JavaScript
  (alte Browser, Kindle). Gespeichert wird nur ein Hash des Links.
- **Foto** der reisenden Person an den Reisen und auf Teilen-Links: wird im Browser quadratisch auf 256 px verkleinert und
  neu gespeichert (Standort- und Kameradaten fallen weg), liegt in D1 (`journey_prefs`), jederzeit entfernbar
- **Animierte Icons** an den Reiseschritten (eigene Zeichnungen, ohne Marken): Zug, Tram, Bus und Fähre fahren im aktuellen
  Abschnitt; beim Umstieg läuft eine Person mit Rollkoffer – gemütlich ab 10 min Puffer, zügig bei 4–10 min, rennend darunter;
  ist der Anschluss nicht zu schaffen, dreht sich ein Zugkopf auf den Kopf und weint. Bei „Bewegung reduzieren“ stehen alle still.
- **Testhaltestelle**: „Testhaltestelle“ in der Suche wählen (Start oder Ziel) → Testfahrt, die alle Zustände live zeigt und **jede Minute
  die Szene wechselt** (9 Szenen): vor Abfahrt · im Bus · Umstieg gemütlich · Tram · Umstieg zügig · Regionalzug mit Verspätung und
  Gleiswechsel · Umstieg knapp · S-Bahn mit nicht erreichbarem Anschluss und Alternativen (inkl. Fähre, Ticket-Hinweise) · angekommen.
  Ohne Transitous/IRIS-Abfragen und ohne Benachrichtigungen; Check-ins gelten für die laufende Runde (mit Szene 1 beginnt alles neu). „Übernehmen“ einer
  Alternative wirkt (die Szenen laufen mit der neuen Verbindung weiter), „Zurück“ stellt die ursprüngliche wieder her.
  Die Testfahrt bleibt einen Tag (Teilen-Links funktionieren auch).

## Drei Arten der Nutzung

| | Was | Import |
|---|---|---|
| **Bibliothek** | Transitous-Client, Datenmodell, Fortschritt, Umstiege, Ticketregeln – ohne Abhängigkeiten | `reisebegleitung` |
| **Bausteine** | Server-Handler (Request → Response, mit D1-Speicher) und Preact-Oberfläche – zum Einbauen in eigene Apps/Dashboards | `reisebegleitung/server`, `reisebegleitung/ui`, `reisebegleitung/ui/styles.css` |
| **Eigenständige App** | fertige Web-App auf Cloudflare (Worker + D1), Anmeldung mit Passkey | Ordner `app/` |

## Eigenständige App einrichten (ca. 10 Minuten)

Voraussetzungen: kostenloses [Cloudflare-Konto](https://dash.cloudflare.com/sign-up), Node.js ≥ 22.18.

```bash
git clone https://github.com/christianender-da/reisebegleitung.git
cd reisebegleitung
npm ci
npx wrangler login
npx wrangler d1 create reisebegleitung      # gibt eine database_id aus
```

In `app/wrangler.jsonc`:

1. `database_id` durch die ausgegebene ID ersetzen.
2. **`CONTACT`** setzen – Pflicht laut Transitous-Nutzungsregeln: deine E-Mail-Adresse oder eine URL
   (z. B. deinen Fork). Sie wird bei jeder Anfrage im `User-Agent` mitgeschickt.
3. Optional eine eigene Domain unter `routes` eintragen (sonst `reisebegleitung.<konto>.workers.dev`).
4. Optional `OWNER_NAME`: dein Name, den Empfänger von Teilen-Links sehen („Geteilt von …“).

```bash
npm run app:migrate       # Tabellen anlegen
npm run app:deploy        # Oberfläche bauen und Worker hochladen
npm run app:setup-code    # einmaliger Einrichtungscode (30 min gültig), erscheint nur im Terminal
```

Dann die Seite öffnen, den Einrichtungscode eingeben und einen **Passkey** anlegen (Face ID, Touch ID, Windows Hello …).
Danach wird **einmal** ein Wiederherstellungscode angezeigt – sicher aufbewahren. Weitere Geräte: angemeldet
„Passkey hinzufügen“ (iCloud-/Google-Schlüsselbund synchronisiert Passkeys ohnehin). Auf dem iPhone über „Teilen →
Zum Home-Bildschirm“ als App installieren.

**Benachrichtigungen (optional):** einmal einen VAPID-Schlüssel erzeugen und als Secret hinterlegen, dann neu deployen:

```bash
npm run vapid-keys | npx wrangler secret put VAPID_PRIVATE_JWK --config app/wrangler.jsonc
```

Danach in der App „🔔 Benachrichtigungen bei Problemen“ antippen (je Gerät). Als Absender-Kontakt für die Push-Dienste
wird `CONTACT` verwendet.

Updates: `git pull && npm ci && npm run app:migrate && npm run app:deploy`.

Die App frischt laufende Reisen per Cron jede Minute auf (`triggers` in `app/wrangler.jsonc`; im kostenlosen Plan
sind einige Cron Trigger pro Konto enthalten).

### Als Abhängigkeit in einem eigenen Repo betreiben

Wer seine Konfiguration (Domain, Datenbank, Name) nicht in einem Fork pflegen will: Paket als Abhängigkeit einbinden
(`npm i github:christianender-da/reisebegleitung#<commit>`) und eine eigene `wrangler.jsonc` anlegen, die Worker, Oberfläche
und Migrationen aus `node_modules/reisebegleitung/app/` verwendet:

```jsonc
{
  "name": "meine-reise",
  "main": "../node_modules/reisebegleitung/app/src/worker.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": true, "not_found_handling": "single-page-application" },
  "vars": { "CONTACT": "du@example.org" },
  "d1_databases": [{ "binding": "DB", "database_name": "meine-reise", "database_id": "…", "migrations_dir": "../node_modules/reisebegleitung/app/migrations" }],
  "triggers": { "crons": ["* * * * *"] }
}
```

Oberfläche bauen: `vite build --config node_modules/reisebegleitung/app/web/vite.config.ts --outDir "$PWD/<ordner>/dist" --emptyOutDir`.

### Lokal entwickeln

```bash
npm run app:migrate:local
npm run app:dev -- --var CONTACT:you@example.org     # http://localhost:8787
npm run app:setup-code -- --local
```

Passkeys funktionieren lokal nur über `http://localhost` (nicht über eine IP-Adresse).

## Bausteine in eine eigene App einbauen

Server (z. B. Cloudflare Worker, D1-Schema aus `migrations/` übernehmen):

```ts
import { createJourneyService, d1Store, handleJourneyRequest } from 'reisebegleitung/server';

const service = createJourneyService({ store: d1Store(env.DB), userAgent: 'meine-app/1.0 (+mail@example.org)' });
// Anmeldung prüft deine App; scope trennt Reiselisten (z. B. je Widget)
return handleJourneyRequest(service, request, '/trips', { scope: 'default', owner: 'me', canEdit: true });

// Hintergrund (Cron jede Minute): laufende Reisen auffrischen
export default { fetch, scheduled: (_e, env, ctx) => ctx.waitUntil(service.refreshActive()) };
```

Benachrichtigungen: `createJourneyService({ …, push: { privateJwk: env.VAPID_PRIVATE_JWK, subject: 'mailto:…' } })` und
im Service Worker der Seite `push`/`notificationclick` behandeln (Vorlage: `app/web/public/sw.js`).

Teilen-Links: `handleSharedRequest(service, token)` (JSON) und `renderSharedLite(await service.shared(token), 'de', { fullUrl: '/r/' + token })` (HTML ohne
JavaScript, mit `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` ausliefern) unter einem öffentlichen Pfad
einhängen, z. B. `/r/<token>/data` und `/r/<token>/lite`; die Seite `/r/<token>` rendert `<SharedView dataUrl=… />`.
Das Foto zum Link liefert `handleSharedAvatar(service, token)`, z. B. unter `/r/<token>/avatar` (Standardadresse von `SharedView`).
Ungültige Tokens per Rate-Limit bremsen.

Oberfläche (Preact):

```tsx
import { createJourneyApi, JourneyView } from 'reisebegleitung/ui';
import 'reisebegleitung/ui/styles.css';

<JourneyView api={createJourneyApi('/api/journey')} canEdit lang="de" />;
```

Die Stile nutzen die CSS-Variablen der Seite (`--bg`, `--card`, `--text`, `--muted`, `--line`, `--accent`, `--on`, `--busy`,
`--danger`), sonst helle Standardfarben. Die Quellen sind TypeScript (`.ts`-Importe): im Projekt
`allowImportingTsExtensions` aktivieren; Vite und Wrangler bündeln sie direkt.

Bibliothek allein:

```ts
import { createClient, progress, refreshJourney, transfers } from 'reisebegleitung';

const client = createClient({ userAgent: 'meine-app/1.0 (+https://example.org/kontakt)' });
const [from] = await client.searchStops('Darmstadt Hbf');
const [to] = await client.searchStops('Kassel-Wilhelmshöhe');
const [journey] = await client.plan({ from: from.id, to: to.id });
const { journey: live } = await refreshJourney(journey, (tripId) => client.trip(tripId));
console.log(progress(live).phase, transfers(live));
```

## App-Icon

Quelle ist `app/web/public/icon.svg` (Zug mit Strecke und Ziel-Pin, 512 × 512, vollflächiger Hintergrund – Ecken rundet das System).
**iOS nimmt für den Home-Bildschirm kein SVG**, sondern nur `apple-touch-icon.png` (180 × 180, ohne Transparenz); fehlt es, zeigt
das iPhone ein verkleinertes Bild der Seite. Das Manifest nutzt `icon-192.png`, `icon-512.png` und `icon-maskable-512.png`
(Inhalt in der sicheren Zone, 80 %), Benachrichtigungen `icon-192.png`. Nach einer Änderung am SVG die PNGs neu erzeugen:

```bash
npx -y playwright@1 install chromium   # einmalig
node scripts/render-icons.mjs
```

Ein schon abgelegtes Home-Bildschirm-Symbol übernimmt ein neues Icon erst nach Entfernen und erneutem „Zum Home-Bildschirm“.

### Startbild (Splash-Screen)

**Android** baut den Startbildschirm selbst aus dem Manifest: Icon auf `background_color` (`#0f4f63`).
**iOS/iPadOS** zeigt nur ein `apple-touch-startup-image`, das pixelgenau zur Fenstergröße passt – deshalb liegt in
`app/web/public/splash/` je Gerät und Ausrichtung ein PNG (Zug mit Strecke auf dem Verlauf der Icon-Farben), eingebunden in
`app/web/index.html`. Abgedeckt sind iPhone 17 (402 × 874 pt, @3x) und iPad Pro 11″ (834 × 1194 pt, @2x); andere Geräte
starten wie bisher ohne Bild. Neu erzeugen bzw. ein Gerät ergänzen (Liste `DEVICES` im Skript, dann die `<link>`-Zeilen):

```bash
node scripts/render-splash.mjs
```

Auch das Startbild erscheint erst nach Entfernen und erneutem Ablegen auf dem Home-Bildschirm.

## Nutzungsregeln von Transitous

Transitous wird von Freiwilligen betrieben. Wer `api.transitous.org` nutzt, muss die
[Nutzungsregeln](https://transitous.org/api/) einhalten, u. a.:

- nur Open-Source- und nicht-kommerzielle Nutzung,
- `User-Agent` mit Anwendungsname, Version und Kontakt (die App verlangt `CONTACT`),
- sichtbarer Link auf <https://transitous.org/sources/> (ist in der Oberfläche eingebaut) und Beachtung der Lizenzen der Quellen,
- wenig Last: mehr als ca. 720 Verbindungssuchen pro Tag nur nach Absprache. Die Live-Verfolgung nutzt den
  günstigeren Fahrtverlauf mit 60 s Cache und läuft nur von 3 h vor Abfahrt bis kurz nach Ankunft.

Bitte nicht als öffentlichen Dienst für viele Nutzer betreiben – gedacht ist eine Installation pro Person/Familie.

## Entwicklung

```bash
npm test            # node --test, mit echten (gekürzten) Transitous-Antworten in test/fixtures
npm run typecheck
```

Die Ticketregeln sind eine Vereinfachung der Fahrgastrechte (Stand 2026) und keine Rechtsauskunft.

## Haftungsausschluss

Dieses Projekt ist eine **Beta-Version** und ein privates Open-Source-Projekt. Es ist **kein Angebot der Deutschen Bahn**
oder eines anderen Verkehrsunternehmens und steht mit ihnen in keiner Verbindung.

- **Keine Gewähr für die Daten:** Fahrplan- und Echtzeitdaten stammen aus offenen Quellen (Transitous und deren
  Datenlieferanten). Sie können unvollständig, verspätet oder falsch sein; Gleiswechsel, Ausfälle, Ersatzverkehr oder
  Umleitungen fehlen unter Umständen. Maßgeblich sind die Auskünfte der Verkehrsunternehmen (Aushänge, Ansagen,
  offizielle Apps).
- **Keine Rechtsberatung:** Die Ticketregeln (z. B. Aufhebung der Zugbindung, Nutzung mit Deutschlandticket) sind
  vereinfacht und können von den Beförderungsbedingungen und Fahrgastrechten im Einzelfall abweichen.
- **Anschlüsse und Alternativen** sind Vorschläge. Ob ein Anschluss erreicht wird oder eine Alternative mit dem Ticket
  genutzt werden darf, liegt in der eigenen Verantwortung.
- **Haftung:** Die Software wird ohne Gewährleistung bereitgestellt (siehe [LICENSE](LICENSE)). Für Schäden aus der Nutzung,
  z. B. verpasste Verbindungen, zusätzliche Fahrt- oder Übernachtungskosten, wird – soweit gesetzlich zulässig – keine
  Haftung übernommen. Die Haftung für Vorsatz und grobe Fahrlässigkeit sowie für Schäden aus der Verletzung des Lebens,
  des Körpers oder der Gesundheit bleibt unberührt.
- **Eigene Installationen** betreibt jede und jeder in eigener Verantwortung, einschließlich Datenschutz gegenüber Personen,
  mit denen Reisen geteilt werden, und der Einhaltung der Nutzungsregeln von Transitous.

*Disclaimer (English): Beta software, provided "as is" without warranty. Not affiliated with Deutsche Bahn or any transport
operator. Timetable and real-time data come from open sources and may be incomplete or wrong; ticket rules are simplified
and not legal advice. Always check official operator information. Self-hosted instances are operated at your own
responsibility.*

## Lizenz

MIT – siehe [LICENSE](LICENSE). Fahrplandaten: siehe <https://transitous.org/sources/>.
