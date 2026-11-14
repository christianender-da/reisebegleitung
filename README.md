# reisebegleitung

Bausteine für eine persönliche Reisebegleitung im Stil eines Bahn-Navigators – auf Basis offener Fahrplandaten
von [Transitous](https://transitous.org) (MOTIS 2, inkl. Echtzeit aus DELFI).

*Building blocks for a personal journey companion on top of the open MOTIS API of Transitous: stop search,
journey planning, live refresh of booked trips, progress, transfer checks and German rail ticket rules.*

- **Client** für die Transitous-API: Haltestellensuche, Verbindungssuche, Fahrtverlauf (`transitous.ts`)
- **Datenmodell** unabhängig von der Quelle (`types.ts`), Umwandlung aus MOTIS (`motis.ts`)
- **Auffrischen** einer gewählten Verbindung mit Echtzeit, inkl. aller Zwischenhalte (`refresh.ts`)
- **Fortschritt** (vor Abfahrt / unterwegs zwischen Halt X und Y / Umstieg / angekommen) und **Umstiegsampel** (`progress.ts`)
- **Ticketregeln** (Flexpreis, Sparpreis mit Zugbindung, BahnCard 100, Deutschlandticket) für Suche und Alternativen (`tickets.ts`)

Keine Abhängigkeiten, TypeScript-Quellen (ESM). Läuft in Cloudflare Workers, Browsern und Node ≥ 22.18.

## Beispiel

```ts
import { createClient, progress, refreshJourney, transfers } from 'reisebegleitung';

const client = createClient({ userAgent: 'meine-app/1.0 (+https://example.org/kontakt)' });
const [from] = await client.searchStops('Darmstadt Hbf');
const [to] = await client.searchStops('Kassel-Wilhelmshöhe');
const [journey] = await client.plan({ from: from.id, to: to.id });

// später, z. B. jede Minute:
const { journey: live } = await refreshJourney(journey, (tripId) => client.trip(tripId));
console.log(progress(live).phase, transfers(live));
```

## Nutzungsregeln von Transitous

Transitous wird von Freiwilligen betrieben. Wer diese Bibliothek mit `api.transitous.org` nutzt, muss deren
[Nutzungsregeln](https://transitous.org/api/) einhalten, u. a.:

- nur Open-Source- und nicht-kommerzielle Projekte,
- `User-Agent` mit Anwendungsname, Version und Kontakt (E-Mail oder URL) – `createClient` verlangt ihn,
- sichtbarer Link auf <https://transitous.org/sources/> (Konstante `TRANSITOUS_SOURCES`) und Beachtung der Lizenzen der Quellen (u. a. OpenStreetMap),
- wenig Last: mehr als ca. 720 `/plan`-Anfragen pro Tag nur nach Absprache. Für die Live-Verfolgung `trip()` nutzen und zwischenspeichern.

## Entwicklung

```bash
npm test          # node --test, mit echten (gekürzten) Transitous-Antworten in test/fixtures
npm run typecheck
```

Die Ticketregeln sind eine Vereinfachung der Fahrgastrechte (Stand 2026) und keine Rechtsauskunft.

## Lizenz

MIT – siehe [LICENSE](LICENSE). Fahrplandaten: siehe <https://transitous.org/sources/>.
