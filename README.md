# KeepX – Offline-Archiv für X / Twitter

**KeepX** ist ein lokales, offline-fähiges Archiv für X/Twitter-Beiträge. Über eine Browser-Erweiterung (Chrome / Brave), per URL-Import im Web-Dashboard oder automatisch über einen Telegram-Kanal lassen sich Posts inklusive Text, Links, Bildern und Videos dauerhaft in einer lokalen SQLite-Datenbank und im Dateisystem sichern.

Das Projekt kommt ohne Build-Schritt, Bundler oder externe Frameworks aus (Node.js + Express + SQLite im Backend, Vanilla JS im Frontend und in der Extension).

---

## Funktionen

- **1-Klick-Speichern auf x.com:** Die Browser-Erweiterung fügt direkt in Beiträgen auf `x.com` einen Speichern-Button ein und erfasst Text, Autor, Zeitstempel, externe Links, Zitate sowie eingebettete Medien.
- **Lokale Mediensicherung:**
  - Bilder von `pbs.twimg.com` werden automatisch in Originalauflösung (`name=orig`) heruntergeladen.
  - Videos werden serverseitig als direkte MP4-Dateien aufgelöst (mit automatischem Browser-Fallback via `MediaRecorder`, z. B. bei geschützten Konten).
- **Web-Dashboard (`http://localhost:3000`):**
  - **Volltextsuche:** Schnelle Suche über Tweet-Text, eigene Notizen, Autorname und Handle (SQLite FTS5 mit `trigram`-Tokenizer).
  - **Tagging & Notizen:** Beliebige Tags vergeben/filtern (automatisch kleingeschrieben und zusammengeführt) sowie persönliche Notizen pro Beitrag speichern.
  - **Massen-Import per URL:** Bis zu 50 Tweet-URLs gleichzeitig über das Dashboard importieren (via `api.fxtwitter.com`).
  - **Datenbank-Backup:** Export und Import der Datenbankeinträge (Tweets, Tags, Notizen, Links, Medien-Metadaten) als `.jsonl`-Datei.
- **Optionale Telegram-Integration:** Überwacht auf Wunsch einen Telegram-Kanal per Bot-API (Long Polling) und importiert dort gepostete X/Twitter-Links automatisch im Hintergrund.

---

## Projektstruktur

```text
backend/
  server.js          Express-Server, Middleware, statisches Hosting, Startlogik
  config.js          Konfiguration (PORT, Pfade, optionale Telegram-Einstellungen)
  db.js              SQLite-Datenbankschema, Migrationen, FTS5-Suchindex, Abfragen
  routes/
    tweets.js        /api/tweets – Speichern, Listen, Suchen, Tags, Notizen, Löschen
    import.js        /api/import – URL-Import über fxtwitter
    backup.js        /api/backup – JSONL-Export und -Import der Datenbank
  services/
    media.js         Download, Speicherung und Bereinigung von Mediendateien
    importer.js      Abruf und Aufbereitung von Tweets über api.fxtwitter.com
    telegram.js      Telegram Bot API Polling für automatische Kanal-Importe
    links.js         Normalisierung und Deduplizierung von Links
  tests/             Unit-Tests (Node.js Test-Runner)
  storage/media/     Heruntergeladene Bilder und Videos (lokale Nutzerdaten, git-ignoriert)
  tweets.db          SQLite-Datenbank (lokale Nutzerdaten, git-ignoriert)
extension/
  manifest.json      Manifest V3 Browser-Erweiterung für Chrome / Brave
  content.js         DOM-Parser, Button-Injektion auf x.com und Video-Fallback
  background.js      Service Worker für die Kommunikation mit dem lokalen Backend
  content.css        Styling für den Speichern-Button
frontend/
  index.html         Web-Dashboard (Tailwind CSS via CDN)
  app.js             Dashboard-Logik (Suche, Filter, Paging, Import, Backup)
stop-server.ps1      PowerShell-Hilfsskript zum Beenden des laufenden Servers
```

---

## Voraussetzungen

- **Node.js** (entwickelt und getestet mit Node 24) und **npm**
- **Google Chrome** oder **Brave** (für die Browser-Erweiterung)

---

## Installation & Start

### 1. Backend installieren und starten

Im Hauptverzeichnis des Projekts:

```powershell
npm --prefix backend install
npm --prefix backend start
```

Der Server läuft standardmäßig auf **`http://localhost:3000`**:
- **Dashboard:** [http://localhost:3000](http://localhost:3000)
- **Health-Check:** [http://localhost:3000/health](http://localhost:3000/health)

Zum Beenden des Servers (oder über ein zweites Terminal):

```powershell
.\stop-server.ps1
```

### 2. Browser-Erweiterung installieren (Chrome / Brave)

1. Öffne `chrome://extensions` (bzw. `brave://extensions`).
2. Aktiviere oben rechts den **Entwicklermodus** (*Developer mode*).
3. Klicke auf **Entpackte Erweiterung laden** (*Load unpacked*).
4. Wähle den Ordner `extension/` aus diesem Repository aus.
5. Lade geöffnete `x.com`-Tabs einmal neu.

---

## Optionale Telegram-Integration

KeepX kann neue Beiträge in einem Telegram-Kanal automatisch nach X/Twitter-Status-Links durchsuchen und archivieren:

1. Erstelle einen Bot über `@BotFather` auf Telegram und füge ihn als Administrator zu deinem Kanal hinzu (mit Berechtigung zum Lesen von Kanalbeiträgen).
2. Stelle sicher, dass für den Bot kein Webhook aktiv ist (KeepX nutzt Long Polling).
3. Setze vor dem Start die Umgebungsvariablen `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHANNEL_ID` (numerische ID wie `-1001234567890` oder `@kanalname`):

```powershell
$env:TELEGRAM_BOT_TOKEN = "dein-bot-token"
$env:TELEGRAM_CHANNEL_ID = "-1001234567890"
npm --prefix backend start
```

Sind die Variablen nicht gesetzt, bleibt das Telegram-Polling deaktiviert und alle anderen Funktionen arbeiten normal weiter.

---

## REST-API Übersicht

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/api/tweets` | Paginierte Tweet-Liste (`q`, `tag`, `limit`, `cursor`) |
| `POST` | `/api/tweets` | Tweet aus der Browser-Erweiterung speichern |
| `POST` | `/api/import` | 1 bis 50 Tweet-URLs über `fxtwitter` importieren |
| `POST` | `/api/tweets/:id/tags` | Tag zu einem Tweet hinzufügen (`{ tag }`) |
| `DELETE` | `/api/tweets/:id/tags/:tag` | Tag von einem Tweet entfernen |
| `PUT` | `/api/tweets/:id/notes` | Persönliche Notizen aktualisieren (`{ notes }`) |
| `DELETE` | `/api/tweets/:id` | Tweet samt zugehörigen Mediendateien löschen |
| `GET` | `/api/backup/export` | Datenbank als `.jsonl`-Datei exportieren |
| `POST` | `/api/backup/import` | Datenbank aus `.jsonl`-Datei importieren |
| `GET` | `/health` | Statusprüfung des Servers |

---

## Tests ausführen

Die Backend-Tests nutzen den integrierten Test-Runner von Node.js und arbeiten auf temporären Testdatenbanken:

```powershell
npm --prefix backend test
```

