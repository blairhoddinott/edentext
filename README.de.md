<p align="center">
  <img src="public/favicon.svg" width="80" alt="">
</p>

<h1 align="center">
  <img src="public/EdenText.png" height="40" alt="EdenText">
</h1>

<p align="center">
  <strong>Leistungsstarke Textverarbeitung – nur einen Link entfernt.</strong><br>
  Kostenlos · Open Source · Private by Design
</p>

<p align="center">
  <a href="https://github.com/stffnb/edentext/actions/workflows/ci.yml"><img src="https://github.com/stffnb/edentext/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="Lizenz: AGPL-3.0"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/github/package-json/v/stffnb/edentext" alt="Version"></a>
  <img src="https://img.shields.io/badge/status-beta-orange" alt="Status: Beta">
</p>

<p align="center">
  <a href="https://edentext.app"><strong>▶ EdenText öffnen</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Deutsch</b> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.ru.md">Русский</a> · <a href="README.uk.md">Українська</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.webp">
  <img src="docs/hero-light.webp" alt="EdenText bearbeitet einen zweispaltigen Newsletter, die Funktionen sind markiert">
</picture>

---

EdenText ist eine leistungsstarke Textverarbeitung im Browser – für alles von der schnellen Notiz bis zum ganzen Buch. Kein Server, kein Konto: Alles wird lokal verarbeitet, Ihre Dokumente verlassen nie Ihren Computer. Einfach den Link öffnen oder EdenText als schlanke Browser-App ganz offline nutzen – für die meisten Sprachen genügen zum Start unter 2 MB Download, Wörterbücher und Schriften kommen bei Bedarf nach[^1]. Die Oberfläche gibt es auf Englisch, Deutsch, Spanisch, Französisch, Portugiesisch, Griechisch, Russisch, Ukrainisch, Japanisch und Chinesisch (vereinfacht und traditionell).

> [!NOTE]
> EdenText ist jung, in der **Beta** und wird aktiv weiterentwickelt – weitere
> Funktionen sind unterwegs. Getestet wird gründlich – bei jedem Commit laufen die
> komplette Testsuite und Round-Trip-Prüfungen mit LibreOffice –, mit gelegentlichen
> Fehlern ist trotzdem zu rechnen; behalten Sie von wichtigen Dokumenten Sicherungskopien.
> Die Kopie im Browser bewahrt außerdem die letzten drei Fassungen des geöffneten
> Dokuments auf und bietet sie an, falls es sich einmal nicht laden lässt.
>
> **Einen Fehler gefunden, oder sieht ein Dokument nicht richtig aus?** Bitte
> [melden Sie es als Issue](https://github.com/stffnb/edentext/issues) – jede Meldung hilft.
> Besonders willkommen sind Dokumente, die EdenText anders darstellt als Word, LibreOffice
> oder WPS Office: Hängen Sie die Datei (oder eine abgespeckte Kopie) an, dann wird daraus
> ein Testfall.

<a href="https://edentext.app"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/showcase/thesis-dark.png">
  <img src="docs/showcase/thesis.png" alt="EdenText bearbeitet eine Abschlussarbeit: nummerierte Kapitel, Formeln und eine Kopfzeile">
</picture></a>

## Funktionen

- **Echtes Seitenlayout** – A4- und Letter-Seiten, Ränder, Kopf- und Fußzeilen, Fußnoten,
  Spalten, Seiten- und Zeilennummerierung, Wasserzeichen; für Bücher gespiegelte Ränder
  und Kapitel, die auf einer rechten Seite beginnen
- **Öffnet und speichert `.odt` und `.docx`**, exportiert PDF; Vorlagen (`.ott`/`.dotx`)
  und eine Galerie mit Briefvorlagen nach DIN 5008; passwortgeschützte Dateien in beiden Formaten
- **Kompatibel mit Word und LibreOffice** – Dokumente behalten in allen drei Programmen
  ihr Layout, abgesichert durch automatisierte Round-Trip- und Layouttests
- **Formatvorlagen** – Absatz-, Zeichen-, Tabellen- und Listenvorlagen mit Vererbung,
  Kapitelnummerierung
- **Tabellen** mit Tabellenvorlagen, Sortierung und Formeln wie in einer Tabellenkalkulation
- **Alles für die Abschlussarbeit** – Inhaltsverzeichnis, Beschriftungen, Querverweise,
  Zitate und Literaturverzeichnis, Stichwortverzeichnis, Formeln (LaTeX)
- **Überarbeiten** – Änderungsverfolgung und Kommentar-Threads in Sprechblasen am Rand,
  druckbare Markierungen, Rechtschreibprüfung (Englisch, Deutsch, Spanisch, Französisch,
  Portugiesisch, Griechisch, Russisch und Ukrainisch), Synonyme (alle davon außer
  Griechisch), Grammatikprüfung (Englisch)
- **Optionaler KI-Assistent** – mit dem Anbieter Ihrer Wahl oder einem lokalen Modell;
  beantwortet Fragen zum Dokument und bearbeitet es als nachverfolgte Änderungen. Lässt
  sich abschalten; Anfragen gehen direkt an den Anbieter, ohne Umweg über einen EdenText-Server
- **Private by Design** – Ihre Dokumente verlassen nie Ihren Computer, alles wird
  lokal verarbeitet; als installierbare App auch offline nutzbar. Die Website zählt anonyme
  Besuche (GoatCounter, in der EU gehostet, ohne Cookies); der Editor selbst sendet nichts –
  es sei denn, Sie schalten den KI-Assistenten ein, der dann an den gewählten Anbieter
  sendet. Dokumente werden automatisch im Browser gesichert; „Zuletzt benutzte Dokumente“
  kann geschlossene Dokumente beim nächsten Start verwerfen oder gar nicht erst dort
  speichern, und ein privates Fenster hinterlässt nach dem Schließen keine Spuren
- **Jeder aktuelle Browser** – in Chrome und Edge schreibt „Speichern“ zurück in die
  geöffnete Datei, in Brave ebenso, sobald `brave://flags/#file-system-access-api`
  aktiviert ist; sonst ist jedes Speichern ein Download – schalten Sie dann in den
  Browsereinstellungen „Vor dem Download fragen, wo eine Datei gespeichert werden soll“
  ein, um den Speicherort selbst zu wählen

Wo der Browser verhindert, dass EdenText exakt wie Word oder LibreOffice aussieht, steht
unter [Known limitations](CHANGELOG.md#known-limitations) (englisch).

## Galerie

Die Dokumente hinter diesen Bildern liegen als `.odt` und `.docx` in [`docs/showcase/`](docs/showcase/)
und lassen sich direkt in EdenText, LibreOffice oder Word öffnen. Erzeugt werden sie von
`scripts/showcase/run.mjs`; die Fotos stammen von der NASA, das Buch von Lewis Carroll –
beides gemeinfrei.

<table>
<tr>
<td width="50%" valign="top"><a href="docs/showcase/thesis-review.png"><img src="docs/showcase/thesis-review.png" alt="Änderungsverfolgung und Kommentare" width="100%"></a><br><b>Überarbeiten</b> – Änderungsverfolgung, Kommentar-Threads am Rand, ein Entwurf-Wasserzeichen</td>
<td width="50%" valign="top"><a href="docs/showcase/book-spread.png"><img src="docs/showcase/book-spread.png" alt="Ein Buch als Doppelseite" width="100%"></a><br><b>Buch</b> – A5, gespiegelte Ränder, Kapitel beginnen rechts, lebende Kolumnentitel; nach der Titelei beginnt die Zählung neu, deshalb trägt Seite 11 die Seitenzahl 9</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/showcase/newsletter.png"><img src="docs/showcase/newsletter.png" alt="Ein zweispaltiger Newsletter" width="100%"></a><br><b>Newsletter</b> – Spalten, Bilder mit Beschriftung, ein Infokasten</td>
<td width="50%" valign="top"><a href="docs/showcase/newsletter-tables.png"><img src="docs/showcase/newsletter-tables.png" alt="Tabellen mit Formeln" width="100%"></a><br><b>Tabellen</b> – Tabellenvorlagen und Formeln wie in einer Tabellenkalkulation</td>
</tr>
</table>

## Desktop-App

Jedes Release enthält außerdem unsignierte Desktop-Installer, gebaut mit Electron:

- **macOS** – `EdenText-<version>-arm64.dmg` (Apple Silicon) oder `EdenText-<version>.dmg` (Intel).
  Ziehen Sie die App in den Ordner „Programme“. Da sie nicht signiert ist, öffnen Sie sie
  beim ersten Mal per Rechtsklick → Öffnen oder führen `xattr -d com.apple.quarantine /Applications/EdenText.app` aus.
- **Windows** – `EdenText-Setup-<version>.exe`. SmartScreen warnt vor einem unbekannten
  Herausgeber: Weitere Informationen → Trotzdem ausführen.
- **Linux** – `EdenText-<version>.AppImage` (`chmod +x`, dann starten) oder das `.deb`
  (`sudo apt install ./edentext_*.deb`).

## Entwicklung

```bash
npm install
npm run dev      # Entwicklungsserver mit Hot-Reload
npm test         # Testsuite
npm run build    # Produktions-Build → dist/
cd desktop && npm install && npm start   # Desktop-App auf demselben Build
```

Gebaut mit Svelte 5, TypeScript, Vite und TipTap 3 (ProseMirror).

## Selbst hosten

Es gibt kein Backend und keinen Zustand auf dem Server; die Dokumente bleiben im Browser.
Zu jedem Release erscheint ein Container-Image (amd64 und arm64):

```bash
docker run -p 8080:80 ghcr.io/stffnb/edentext
```

Oder liefern Sie die Dateien selbst aus: Jedes Release enthält ein `edentext-<tag>.zip`
mit der gebauten App, und `npm run build` erzeugt denselben Ordner in `dist/` – darauf
lässt sich jeder Webserver richten. Alternativ bauen Sie das Image lokal mit
`docker build -t edentext .`.

## Architektur

```mermaid
flowchart TD
  Browser[Browser: lokale, offlinefähige App] --> App[App-Gerüst und Svelte-Oberfläche]
  App --> Editor[TipTap-/ProseMirror-Editor]
  Editor <--> Document[Strukturiertes Dokument und Editor-Erweiterungen]
  Document --> Layout[Formatvorlagen, Seitenlayout, Seitenumbruch und Rahmen]
  Document <--> Storage[localStorage: Dokumente, Einstellungen und Wiederherstellungskopien]
  Document <--> Interchange[ODT- und DOCX-Import/-Export]
  Interchange --> Files[Datei-APIs des Browsers, Downloads und Vorlagen]
  Editor --> Tools[Rechtschreibung, Grammatik, Formeln und Überarbeiten]
  Layout --> Render[Bearbeitbare Seiten im Browser]
```

EdenText läuft vollständig im Browser: `App.svelte` setzt die Oberfläche um das
TipTap-Dokumentmodell und seine Editor-Erweiterungen zusammen. Formatvorlagen und Layout
machen aus diesem Modell bearbeitbare Seiten; die Speicherschicht hält den lokalen Zustand
und die Wiederherstellungskopien. Import und Export übersetzen dasselbe Modell nach ODT und
DOCX, die Datei-APIs des Browsers speichern die Ergebnisse oder laden sie herunter. Die
Invarianten von Formaten und Layout beschreiben die [Architektur-Leitfäden](docs/architecture/) (englisch).

## Mitmachen

Beiträge sind willkommen – siehe [CONTRIBUTING.md](CONTRIBUTING.md) (englisch). Zum Mergen
ist ein unterschriebenes [CLA](CLA.md) nötig; das wird bei jedem Pull Request automatisch geprüft.

### Mitwirkende

Danke an alle, die mit Ideen, Fehlerberichten, Tests und Rückmeldungen geholfen haben:

- Patrick R. – Alpha- und Betatests
- [@Deleh](https://github.com/Deleh) – Betatests

## Lizenz

Copyright © 2026 Steffen Becker · Made in Germany

[AGPL-3.0](LICENSE). Für Einsätze, zu denen die AGPL nicht passt, gibt es eine
[kommerzielle Lizenz](LICENSE.commercial.md). Mitgelieferte Schriften und Sprachdaten
behalten ihre eigenen Lizenzen – siehe [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

*EdenText ist ein unabhängiges Projekt und weder mit Microsoft noch mit The Document
Foundation verbunden. `.docx` und `.odt` werden aus Gründen der Interoperabilität unterstützt.*

*Dies ist eine Übersetzung der englischen [README](README.md); maßgeblich ist die englische Fassung.*

[^1]: Komprimiert übertragen: ~0,7 MB App-Code, der Rest ist die Rechtschreibprüfung mit
    dem Wörterbuch für die Sprache des Browsers und die Schriften, die eine Seite anzeigt;
    das griechische und das ukrainische Wörterbuch kommen mit ~2,5 bzw. ~1,5 MB hinzu.
    Alles andere wird erst bei Bedarf geladen und für die Offline-Nutzung behalten; alle
    Schriften, Wörterbücher und Thesauri zusammen sind ~18 MB groß, mit der englischen
    Grammatikprüfung ~26 MB.
