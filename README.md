# reisebegleitung

Persönliche Reisebegleitung für Bahnreisen – im Stil eines Bahn-Navigators, auf Basis offener Fahrplandaten von
[Transitous](https://transitous.org) (MOTIS 2, in Deutschland mit Echtzeit aus DELFI).

*A personal journey companion for train trips on top of the open Transitous/MOTIS API – usable as a library,
as building blocks for your own dashboard, or as a self-hosted Cloudflare app with passkey login.*

- Verbindungen suchen (Abfahrt/Ankunft) mit Ticketregeln: Flexpreis, Sparpreis, BahnCard 100, Deutschlandticket
- Live-Fortschritt: vor Abfahrt · unterwegs mit nächstem Halt · Umstieg · angekommen
- Abschnitte mit allen Zwischenhalten, Gleisen, Gleiswechseln und Verspätungen
- Umstiegsampel: ok · knapp · nicht erreichbar · fällt aus

Geplant: Check-in je Zug, Alternativen bei verpassten Anschlüssen (Web Push), Teilen-Link für Familie und
Freunde, der 2 h nach Ankunft abläuft.

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

```bash
npm run app:migrate       # Tabellen anlegen
npm run app:deploy        # Oberfläche bauen und Worker hochladen
npm run app:setup-code    # einmaliger Einrichtungscode (30 min gültig), erscheint nur im Terminal
```

Dann die Seite öffnen, den Einrichtungscode eingeben und einen **Passkey** anlegen (Face ID, Touch ID, Windows Hello …).
Danach wird **einmal** ein Wiederherstellungscode angezeigt – sicher aufbewahren. Weitere Geräte: angemeldet
„Passkey hinzufügen“ (iCloud-/Google-Schlüsselbund synchronisiert Passkeys ohnehin). Auf dem iPhone über „Teilen →
Zum Home-Bildschirm“ als App installieren.

Updates: `git pull && npm ci && npm run app:migrate && npm run app:deploy`.

### Lokal entwickeln

```bash
npm run app:migrate:local
npm run app:dev -- --var CONTACT:you@example.org     # http://localhost:8787
npm run app:setup-code -- --local
```

Passkeys funktionieren lokal nur über `http://localhost` (nicht über eine IP-Adresse).

## Bausteine in eine eigene App einbauen

Server (z. B. Cloudflare Worker, D1-Schema aus `migrations/0001_journey.sql` übernehmen):

```ts
import { createJourneyService, d1Store, handleJourneyRequest } from 'reisebegleitung/server';

const service = createJourneyService({ store: d1Store(env.DB), userAgent: 'meine-app/1.0 (+mail@example.org)' });
// Anmeldung prüft deine App; scope trennt Reiselisten (z. B. je Widget)
return handleJourneyRequest(service, request, '/trips', { scope: 'default', owner: 'me', canEdit: true });
```

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

## Lizenz

MIT – siehe [LICENSE](LICENSE). Fahrplandaten: siehe <https://transitous.org/sources/>.
