# Wortschwindel

Ein Lexikonspiel für den Deutschunterricht nach dem Prinzip von „Nobody's Perfect“ / „Balderdash“. Es läuft komplett im Browser: Die Lehrkraft leitet das Spiel am Laptop mit Beamer, die Klasse spielt mit Handys oder Laptops mit.

- Keine Konten, keine Datenbank, keine App-Installation
- Beitritt per Raumcode oder QR-Code, allein oder als Team
- Läuft als Docker-Container, z. B. hinter einem Cloudflare Tunnel

---

## Spielregeln (zum Vorlesen)

> Gleich erscheint ein seltenes Wort, das kaum jemand kennt. Ihr denkt euch eine Erklärung dafür aus, die so klingt, als stünde sie im Wörterbuch: kurz, sachlich, ein Satz.
>
> Danach mische ich alle eure erfundenen Erklärungen mit der echten Definition. Ich lese sie nacheinander vor, dann stimmt ihr ab: Welche ist die echte?
>
> **Punkte:**
> - **2 Punkte**, wenn ihr die echte Definition findet.
> - **1 Punkt** für jede Person, die auf eure erfundene Erklärung hereinfällt.
> - **3 Punkte**, wenn eure Erklärung fast genau stimmt (das entscheide ich).
>
> Für die eigene Erklärung könnt ihr nicht stimmen. Wer am Ende die meisten Punkte hat, gewinnt!

Die Punktwerte lassen sich im Steuerpult ändern.

## Ablauf einer Runde

| Phase | Beamer | Handys | Spielleitung |
|---|---|---|---|
| **Schreiben** | Begriff, Countdown, wer schon abgegeben hat | Textfeld mit Formulierungshinweis und Vorschau | Zeit setzen, +30 s, Pause, sofort beenden, Wort überspringen |
| **Moderation** | „Die Definitionen werden gemischt …“ | „Warte auf die Spielleitung …“ | Antworten prüfen: bearbeiten, löschen, als richtig werten, Duplikate zusammenlegen |
| **Abstimmung** | Nummerierte Definitionen (im Vorlese-Modus einzeln aufgedeckt), Countdown | Antippbare Karten, eigene Antwort ausgegraut | Vorlesen mit Leertaste/→, Hervorheben mit ←/→, „Auflösen“ |
| **Auflösung** | Schritt für Schritt: Text → wer reingefallen ist → wer es geschrieben hat, zum Schluss die echte Definition | „Schau auf den Beamer!“, danach das eigene Rundenergebnis | Jeder Klick bzw. Leertaste deckt den nächsten Schritt auf, „Alles aufdecken“ |
| **Punktestand** | Animierte Rangliste mit Punktzuwachs | Eigene Platzierung | „Nächste Runde“ |
| **Spielende** | Siegerpodest, Konfetti, Statistiken | Platzierung und Auszeichnungen | „Nochmal spielen“, „Ergebnisse exportieren“ (CSV) |

**Die Spielleitung bestimmt das Tempo:**
- Der Vorlese-Modus (Standard: an) zeigt die Definitionen einzeln. Die Auflösung geht nur per Klick weiter.
- Die Timer lassen sich auf 0 (= ohne Zeitlimit) stellen oder so einstellen, dass sie beim Ablauf nicht automatisch weiterschalten.
- **Zeit erst während der Runde festlegen:** Starte ohne Zeitlimit und setze mit „⏱ Zeit setzen“ (Taste `T`) erst dann einen Countdown, wenn die meisten fertig sind, z. B. „noch 30 Sekunden“. Das geht beim Schreiben und bei der offenen Abstimmung. Ein laufender Timer lässt sich damit ersetzen oder wieder entfernen. „+30 s“ startet einen Timer, falls noch keiner läuft.

**Einheitliche Antworten:** Alle Antworten und auch die echte Definition werden gleich formatiert, damit der Stil nichts verrät:
- Leerzeichen werden bereinigt und der erste Buchstabe groß geschrieben.
- Anführungszeichen werden entfernt, und am Ende steht immer genau ein Punkt.
- Einleitungen wie „Das ist …“, „Es bedeutet …“ oder „Damit meint man …“ werden gestrichen. Das lässt sich in den Einstellungen abschalten.

Die Handys zeigen dazu einen kurzen Formulierungshinweis und eine Live-Vorschau.

---

## Lokal starten

Voraussetzung: [Node.js](https://nodejs.org/) 20 oder neuer.

```bash
npm install
npm run dev          # startet mit automatischem Neustart bei Codeänderungen
```

- Spielleitung: <http://localhost:3000/host> (ohne `HOST_PIN` gilt die PIN **1234**, nur für lokale Tests!)
- Mitspielen: <http://localhost:3000/>, im selben WLAN über `http://<IP-des-Rechners>:3000`

Mit eigener PIN und kurzen Test-Timern (Windows PowerShell):

```powershell
$env:HOST_PIN="geheim"; $env:DEV_SHORT_TIMERS="true"; npm run dev
```

### Tests und Testspieler

```bash
npm test                                             # Unit-Tests der Spiellogik

# 8 Bots treten einem Raum bei, den du im Browser leitest:
npm run bots -- --code ABCD --count 8

# Komplett automatisch: Bots UND Spielleitung, mit Leak- und Reconnect-Prüfung
npm run bots -- --host 1234 --count 8 --rounds 3 --spy --reconnect
```

`--spy` prüft jede Nachricht an die Spieler darauf, ob vor der Auflösung Autoren oder die echte Definition mitgeschickt werden. Das Skript bricht mit Fehler ab, wenn etwas durchsickert.

---

## Mit Docker starten (eigener Server)

```bash
cp .env.example .env        # HOST_PIN und PUBLIC_URL anpassen!
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

- Der Container läuft als Benutzer `node` (UID 1000). Mit `PERSIST=true` muss dieser Benutzer in `./data` schreiben dürfen:
  `sudo chown -R 1000:1000 data`
- `./data` wird in den Container eingebunden. Wortlisten und Blockliste kannst du also direkt auf dem Server bearbeiten. Nach Änderungen: `docker compose restart`.
- Ohne `HOST_PIN` startet der Container nicht (Absicht).
- Standardmäßig ist der Port nur auf `127.0.0.1` erreichbar, weil der Cloudflare Tunnel lokal verbindet. Für Zugriff im LAN passe die `ports`-Zeile in `docker-compose.yml` an.
- Update: `git pull && docker compose up -d --build`

### Umgebungsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | Port des Servers | `3000` |
| `HOST_PIN` | PIN für `/host` (**Pflicht** in Docker) | – |
| `PUBLIC_URL` | Öffentliche Adresse für QR-Code und Beitrittslink, z. B. `https://quiz.example.org` | aus der Anfrage abgeleitet |
| `PERSIST` | `true` = Räume in `data/state.json` sichern und nach Neustart wiederherstellen | `false` |
| `ROOM_TTL_HOURS` | Inaktive Räume werden nach so vielen Stunden gelöscht | `3` |
| `DEV_SHORT_TIMERS` | Nur für Tests: 15 s Schreiben, 10 s Abstimmen | `false` |

### Betrieb hinter Cloudflare Tunnel

Cloudflare Tunnel unterstützt WebSockets ohne weitere Einstellungen. Zusätzlich gibt es einen Polling-Fallback, falls ein Schulnetz WebSockets blockiert.

1. Lege im Cloudflare-Dashboard unter *Zero Trust → Networks → Tunnels* einen Tunnel an.
2. Richte einen *Public Hostname* ein, z. B. `quiz.deine-domain.de` → `http://localhost:3000`. Wenn `cloudflared` selbst als Container läuft: → `http://wortschwindel:3000`.
3. Setze `PUBLIC_URL=https://quiz.deine-domain.de` in `.env`, damit QR-Code und Link stimmen.
4. Optional: Aktiviere den `cloudflared`-Dienst in `docker-compose.yml` und trage `CLOUDFLARE_TUNNEL_TOKEN` in `.env` ein.

Der Server vertraut den Proxy-Headern (`trust proxy`) und nutzt `CF-Connecting-IP` für die Begrenzung von Fehlversuchen.

> Tipp: Schütze `/host` zusätzlich mit *Cloudflare Access*, z. B. per E-Mail-Code. Die Spielerseiten bleiben dabei öffentlich.

---

## Eigene Wortliste erstellen

### Als Datei auf dem Server (dauerhaft)

Lege eine Datei `data/wordlists/<name>.json` an:

```json
{
  "title": "Biologie Klasse 8",
  "words": [
    {
      "term": "Mykorrhiza",
      "article": "die",
      "wordClass": "Substantiv",
      "definition": "Lebensgemeinschaft zwischen Pilzen und den Wurzeln von Pflanzen.",
      "category": "Biologie",
      "difficulty": 3
    }
  ]
}
```

- Pflicht sind nur `term` und `definition`.
- `article` (der/die/das), `wordClass`, `category` und `difficulty` (1–5) sind optional.
- Beim Start prüft der Server alle Listen. Fehlerhafte Einträge werden mit einer Warnung im Log übersprungen, der Server stürzt deswegen nicht ab.
- Formuliere Definitionen als kurzen, sachlichen Satz in eigenen Worten.

> **Hinweis:** `data/wordlists/beispiel.json` ist nur ein **Platzhalter** mit 15 Begriffen zum Ausprobieren. Ersetze oder ergänze sie für den Unterricht.

### Im Browser (nur für einen Raum)

Im Steuerpult unter **Wortliste** (in der Lobby) kannst du eine JSON-Datei hochladen oder CSV einfügen. Vor der Übernahme zeigt eine Vorschau, wie viele Zeilen gültig bzw. ungültig sind.

CSV-Format, eine Zeile pro Wort, Trennzeichen Semikolon, Artikel und Kategorie optional:

```
Begriff;Artikel;Definition;Kategorie
Apokope;die;Wegfall eines Lauts am Ende eines Wortes.;Sprache
Drumlin;der;Länglicher Hügel, den ein Gletscher aus Geröll geformt hat.;Geografie
Tremolo;;Schnelle Wiederholung eines Tons.;Musik
```

Eine Kopfzeile wird erkannt und übersprungen. Enthält eine Definition selbst ein Semikolon, setze sie in Anführungszeichen.

### Namensfilter

`data/blocked-names.json` enthält Wörter, die in Spielernamen nicht vorkommen dürfen. Groß- und Kleinschreibung, Umlaute und einfache Zahlentricks (`1` statt `i`) werden dabei erkannt. Die Liste ist bewusst einfach gehalten und kann ergänzt werden. Die Spielleitung kann Spieler außerdem jederzeit umbenennen oder entfernen.

---

## Tipps für den Unterricht

- **Große Klassen: in Teams spielen.** Ab etwa 10 Antworten wird das Vorlesen und Abstimmen zäh. 5–8 Teams zu je 3–4 Personen funktionieren gut, das Team braucht nur ein Gerät. Unter „Mitglieder“ tragen Teams ihre Namen ein.
- **Rundenzahl:** Eine Runde dauert mit Vorlesen und Auflösung etwa 5–7 Minuten. Für eine 45-Minuten-Stunde reichen **4–5 Runden** plus Erklärung, für eine Doppelstunde 8–10.
- **Vorher im echten Schul-WLAN testen**, am besten mit dem Bot-Skript oder zwei, drei Handys. Manche Schulnetze blockieren WebSockets; dann greift automatisch der langsamere Polling-Modus.
- **Erweiterten Bildschirm statt Spiegeln nutzen:** Im Steuerpult öffnet „📺 Beamer-Ansicht öffnen“ ein zweites Fenster ohne Steuerelemente. Schiebe es auf den Beamer und drücke dort `F` für Vollbild. Die Moderation siehst du dann nur am Laptop.
  - Wenn du doch spiegelst: Antworten in der Moderation und die geheime Stimmenliste sind **standardmäßig verschwommen**. Blende sie nur ein, wenn der Beamer gerade nichts zeigt, oder blende das Steuerpult mit `S` aus.
- **Helles Design** ist bei Tageslicht am Beamer meist besser lesbar (Standard). Umschalten mit ◐.
- **Moderation nutzen:** Tippfehler korrigieren, unpassende Antworten löschen, fast richtige Antworten als richtig werten (+3). Gleiche Ideen fasst du mit „Zusammenlegen“ zusammen; beide Autoren bekommen dann die vollen Punkte.
- **Nachbesprechung:** „Ergebnisse exportieren“ lädt eine CSV-Datei mit allen Begriffen, Definitionen, Autoren und Stimmen herunter.
- Kennt jemand das Wort schon, zieht „Wort überspringen“ ein neues, und der Timer startet neu.

## Tastenkürzel (Spielleitung)

| Taste | Funktion |
|---|---|
| Leertaste / → / Bild ↓ | Nächster Schritt (Start, Vorlesen, Auflösung, nächste Runde) |
| ← / Bild ↑ | Vorlesen: zurück · Abstimmung: vorherige Definition hervorheben |
| → (während der Abstimmung) | Nächste Definition hervorheben |
| P | Timer pausieren / fortsetzen |
| + | 30 Sekunden mehr (startet einen Timer, falls keiner läuft) |
| T | Zeit setzen / Timer entfernen |
| F | Vollbild |
| S | Steuerpult ein-/ausblenden |
| M | Ton an/aus |
| ? | Hilfe anzeigen |

Präsentations-Presenter („Clicker“) senden meist Bild ↑/↓ und funktionieren damit direkt. Wenn beim Schreiben oder Abstimmen noch nicht alle fertig sind, fragt die Leertaste vor dem Beenden nach.

Auf der Beamer-Ansicht (`/screen/…`): `F` für Vollbild, `M` für Ton.

---

## Verbindungen & Robustheit

- Spieler kommen nach einem Neuladen oder Verbindungsabbruch automatisch in den Raum zurück, mit Namen, Punkten, Entwurf und abgegebener Stimme.
- Getrennte Spieler bleiben im Spiel und erscheinen auf dem Beamer ausgegraut. Wer länger als 30 Sekunden weg ist, wird bei „alle haben abgegeben“ nicht mehr abgewartet.
- Verliert die Spielleitung die Verbindung, pausiert der Timer automatisch; nach dem Wiederverbinden geht es weiter. Die Spielleitung kann das Spiel auch von einem anderen Gerät übernehmen: PIN eingeben und den Raum unter „Laufende Räume“ wählen.
- Das Display der Handys bleibt während des Spiels an (Screen Wake Lock), soweit der Browser das unterstützt.

## Datenschutz

Es werden nur die eingegebenen Namen/Teamnamen und Antworten verarbeitet, und zwar nur im Arbeitsspeicher. Mit `PERSIST=true` landen sie zusätzlich in `data/state.json`. Räume werden nach 3 Stunden Inaktivität gelöscht. Es gibt keine Konten, kein Tracking und keine externen Dienste; alle Skripte, Schriften und Sounds sind lokal.

## Projektstruktur

```
server.js              Express + Socket.IO, Einstieg
src/game/              reine Spiellogik (ohne Netzwerk, getestet)
src/net/               Räume, Timer, Socket-Events, Auth, Rate-Limit, Persistenz
public/                Browser-Oberfläche (ES-Module, kein Build-Schritt)
  js/i18n.js           alle Texte der Oberfläche zum Anpassen
  js/stage/            Beamer-Darstellung (für /host und /screen)
  js/player/           Handy-Ansicht
  js/host/             Steuerpult
data/                  Wortlisten, Namensfilter, ggf. state.json
scripts/bots.js        Testspieler
test/                  Unit-Tests (node:test)
```
