# /build-release

Pripraví a spustí **cross-platform release** CrowSync — desktop inštalátory
(Windows/macOS/Linux), standalone server binárky a Docker image. Samotný build
beží na GitHube (`.github/workflows/release.yml`); tento príkaz pripraví verziu,
overí kód a pushne release tag, ktorý workflow spustí.

> Tauri sa nedá cross-compilovať, takže Win/Mac inštalátory **nevedia** vzniknúť
> lokálne — vyrobí ich matrix workflow na GitHub runneroch. Lokálne vieme spraviť
> len smoke build pre aktuálny OS.

## Postup

### Krok 1 — Zisti aktuálnu verziu
Prečítaj `package.json`, pole `"version"`. Toto je single source of truth.

### Krok 2 — Opýtaj sa na novú verziu
Použi `AskUserQuestion`:
- Otázka: "Aktuálna verzia je X.Y.Z. Akú verziu chceš pre tento release?"
- Header: "Verzia"
- Možnosti: patch (X.Y.Z+1), minor (X.Y+1.0), major (X+1.0.0), vlastná

Vždy validuj semver (`X.Y.Z`). Pri "vlastná" použi zadanú hodnotu.

### Krok 3 — Nastav verziu vo všetkých súboroch
Aktualizuj Edit toolom (všetky naraz):
1. **`package.json`** — `"version": "X.Y.Z"`
2. **`src-tauri/Cargo.toml`** — `version = "X.Y.Z"` v `[package]`
3. **`src-tauri/tauri.conf.json`** — `"version": "X.Y.Z"`
4. **`server/main.py`** — `FastAPI(title="CrowSync", version="X.Y.Z", ...)` a oba fallbacky `get_setting("server_version", "X.Y.Z")` (v `/health` a `/settings`)
5. **`server/schema.sql`** — seed `INSERT OR IGNORE INTO settings VALUES ('server_version', 'X.Y.Z');`

### Krok 3.5 — Verifikácia verzií
```
grep -rn "STARA_VERZIA" package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json server/main.py server/schema.sql
```
Ak sa stará verzia ešte niekde nájde, oprav ju pred pokračovaním.

### Krok 4 — Pre-flight kontroly
Všetky musia prejsť (rovnaké checky ako CI):
```
npm ci
npm run type-check
npm run lint
npm run test
python -m pytest server/ -q
```

### Krok 5 — (voliteľné) Lokálny smoke build pre aktuálny OS
Rýchle overenie, že bundling funguje, pred spustením celého matrixu:
```
npm run tauri build                          # host-OS inštalátor → src-tauri/target/release/bundle/
pyinstaller packaging/crowsync-server.spec   # host-OS server binárka → dist/crowsync-server[.exe]
```
Toto NIE je povinné a vyrobí len artefakty pre aktuálny OS.

### Krok 6 — Commit, tag a push (spustí release)
```
git add -A
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "CrowSync vX.Y.Z"
git push origin HEAD
git push origin vX.Y.Z
```
Tag `vX.Y.Z` spustí `release.yml`. Push rob na aktuálnu vývojovú vetvu (alebo
`main`, ak je release z nej).

### Krok 7 — Sleduj build a reportuj
- Sleduj beh `release.yml` (GitHub Actions MCP `actions_list`/`actions_get`, alebo URL `…/actions`).
- Po dokončení vznikne **draft** GitHub Release s artefaktami:
  - desktop: `.dmg`/`.app` (mac), `.msi` + NSIS `.exe` (win), `.deb` + `.AppImage` (linux)
  - server binárky: `crowsync-server-{macos,windows,linux}-x64`
  - Docker image: `crowsync-server-vX.Y.Z.tar.gz` (load cez `docker load <`)
- Reportuj používateľovi URL draft release. Upozorni: inštalátory sú
  **nepodpísané** → macOS Gatekeeper (pravý klik → Open) a Windows SmartScreen
  (More info → Run anyway). Po otestovaní treba Release manuálne **publikovať**.

Ak niektorý job zlyhá, stiahni log (`get_job_logs`), zobraz podstatnú časť chyby
a navrhni opravu.
