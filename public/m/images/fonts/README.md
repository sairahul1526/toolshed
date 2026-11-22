# Bundled fonts

These files are loaded when an image is rendered. They are plain TrueType files, split by script so
a render only reads the files its text needs.

| Folder | Family | Weights | Scripts | Licence |
| --- | --- | --- | --- | --- |
| `inter` | Inter | 400, 600, 800 | Latin, Latin Extended, Cyrillic, Greek, Vietnamese | SIL Open Font License 1.1 |
| `libre-baskerville` | Libre Baskerville | 400, 700 | Latin, Latin Extended | SIL Open Font License 1.1 |
| `jetbrains-mono` | JetBrains Mono | 500 | Latin, Latin Extended, Cyrillic, Greek | SIL Open Font License 1.1 |
| `noto-emoji` | Noto Emoji (one colour) | 400 | Emoji | SIL Open Font License 1.1 |

The files are the subsets published by the Fontsource project, unwrapped from WOFF to TrueType
without changing the outlines. Each folder holds the licence text in `OFL.txt`.

`../engine/catalog.js` lists every file with the characters it covers. A test fails if the list
and the files stop matching, so regenerate the list whenever a file changes.
