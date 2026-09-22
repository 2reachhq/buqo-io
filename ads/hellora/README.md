# Hellora – Hochformat-Ads (1080 × 1920)

Minimalistische, grafische Ad-Videos im Apple-Stil, komplett aus HTML/CSS gebaut und als MP4 gerendert.
Kein After Effects nötig: Texte, Farben und Dauern stehen in `ads.js`, das Rendern übernimmt ein Skript.
Die Videos sind stumm gedacht – das Voice-Over kommt danach drüber (siehe unten).

## Schnellstart

```bash
cd ads/hellora
npm install                      # Playwright + ffmpeg (ffmpeg-static)
npx playwright install chromium  # einmalig: Chromium für das Rendern
npm run render                   # → out/intro.mp4, out/features.mp4, out/statement.mp4
```

Einzelne Ad rendern: `node render.mjs intro`
Nur Standbilder (alle 0,5 s ein PNG, zur schnellen Kontrolle): `npm run stills`

## Vorschau im Browser

```bash
npm run preview      # öffnet http://localhost:5173
```

Oben links zwischen den Ads wechseln. Leertaste oder Klick pausiert, ←/→ springt Frame für Frame, Pos1 setzt an den Anfang.
`index.html` funktioniert auch per Doppelklick (die Schrift ist eingebettet).

## Inhalte anpassen (`ads.js`)

Jede Ad ist eine Liste von Szenen. Jede Szene hat `kind`, `theme` (`light` / `dark`) und `dur` (Sekunden).

| kind        | Zweck                                   | Felder                                                   |
|-------------|------------------------------------------|----------------------------------------------------------|
| `brand`     | Markenwort groß, weicher Farbnebel       | `text`, `kicker`, `sub`, `glow: false`                   |
| `words`     | Ein Wort nach dem anderen                | `words: ['Einfach.', 'Klar.', 'Modern.']`                |
| `statement` | Headline, die Wort für Wort erscheint    | `text`, `kicker`, `sub`, `align: 'center'`               |
| `shapes`    | Geometrische Formen + Headline           | `text`, `kicker`, `shapes` (optional, eigene Komposition) |
| `list`      | Nummerierte Liste                        | `items`, `kicker`, `text`                                |
| `stat`      | Zahl, die hochzählt                      | `value`, `prefix`, `suffix`, `label`, `decimals`         |
| `cta`       | Abschluss mit Button                     | `text`, `sub`, `button`, `buttonStyle`, `url`, `glow`    |

In Texten: `\n` erzwingt einen Zeilenumbruch, `*Wort*` färbt das Wort im Farbverlauf.
Zu lange Einzeiler (Marke, Zahl, Einzelwort) werden automatisch verkleinert.

Farben und Marke stehen oben in `THEME` (Hintergrund, Textfarben, Akzent, Farbverlauf).
Die letzte Szene bleibt bis zum Ende stehen; alle anderen blenden am Ende aus.

Die Platzhalter-Texte (Claims, Liste, „100 %“) sind Vorschläge und sollten durch echte Hellora-Aussagen ersetzt werden.
`url` ist leer und wird erst angezeigt, wenn eine Adresse eingetragen ist.

## Voice-Over drunterlegen

Voice-Over aufnehmen (z. B. als `voice.m4a` oder `voice.wav`), dann:

```bash
node_modules/ffmpeg-static/ffmpeg -i out/intro.mp4 -i voice.m4a \
  -c:v copy -c:a aac -b:a 192k -shortest out/intro-final.mp4
```

Ist das Voice-Over länger als das Video: in `ads.js` die `dur`-Werte anheben und neu rendern.
Alternativ Video und Ton einfach in CapCut, iMovie, Premiere o. Ä. übereinanderlegen.

## Technische Daten

- 1080 × 1920 (9:16), 30 fps, H.264 (yuv420p, High-Profile), MP4 mit `faststart` – passt für Instagram Reels, TikTok, YouTube Shorts, Meta Ads.
- Safe-Area: Inhalte liegen zwischen 300 px von oben und 420 px von unten, damit Plattform-Overlays nichts verdecken.
- Optionen: `--fps 60`, `--crf 15` (höhere Qualität), `--scale 2` (2160 × 3840), `--out ordner`.
- Schrift: Inter (SIL Open Font License), eingebettet in `fonts/inter.css`.

## Wie es funktioniert

`engine.js` baut aus `ads.js` eine Timeline, in der jeder Frame eine reine Funktion der Zeit ist (`__seek(t)`).
`render.mjs` öffnet `index.html` in headless Chromium, springt Frame für Frame durch die Timeline,
macht Screenshots und schiebt sie direkt in ffmpeg. Dadurch ist das Ergebnis deterministisch und ruckelfrei,
unabhängig davon, wie schnell der Rechner ist.
