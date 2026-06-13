# /build-release

Spusti release build CrowSync desktop aplikácie (Tauri).

## Postup

### Krok 1 — Zisti aktuálnu verziu
Prečítaj `package.json` a nájdi pole `"version"`. Toto je single source of truth.

### Krok 2 — Opýtaj sa na novú verziu
Použi `AskUserQuestion` s jednou otázkou:
- Otázka: "Aktuálna verzia je X.Y.Z. Akú verziu chceš použiť pre tento build?"
- Header: "Verzia"
- Možnosti: patch (napr. X.Y.Z+1), minor (napr. X.Y+1.0), zachovaj súčasnú, vlastná

Ak user vyberie "zachovaj súčasnú", pokračuj s existujúcou verziou bez zmeny súborov.
Ak user vyberie vlastnú, použi ním zadanú hodnotu.
Vždy validuj semver formát (`X.Y.Z` — tri čísla oddelené bodkami).

### Krok 3 — Nastav verziu vo všetkých súboroch
Ak sa verzia mení, aktualizuj ju pomocou Edit tool v týchto súboroch (všetky naraz):

1. **`package.json`** — pole `"version": "X.Y.Z"`
2. **`src-tauri/Cargo.toml`** — riadok `version = "X.Y.Z"` v sekcii `[package]`
3. **`src-tauri/tauri.conf.json`** — pole `"version": "X.Y.Z"`
4. **`server/main.py`** — `FastAPI(title="CrowSync", version="X.Y.Z", ...)` a oba fallbacky `get_setting("server_version", "X.Y.Z")` (v `/health` a `/settings`)
5. **`server/schema.sql`** — seed riadok `INSERT OR IGNORE INTO settings VALUES ('server_version', 'X.Y.Z');`

### Krok 3.5 — Verifikácia verzií (pre-build check)
Spusti grep a over, že stará verzia sa už nikde nenachádza:
```
grep -rn "STARA_VERZIA" package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json server/main.py server/schema.sql
```
Ak sa nájdu výskyty starej verzie, oprav ich pred buildom.

> Pozn.: existujúce databázy majú `server_version` už zapísanú v tabuľke `settings`
> (seed je `INSERT OR IGNORE`) — na serveri treba hodnotu pri nasadení aktualizovať,
> alebo to spomenúť v release poznámkach.

### Krok 4 — Pre-build kontroly
```
npm run type-check
npm run lint
```
Obe musia prejsť bez chýb. (Test runner v projekte nie je.)

### Krok 5 — Spusti build
```
npm run tauri build
```
Toto najprv spustí `npm run build` (tsc + vite) a potom skompiluje Rust shell
a vytvorí inštalátory.

Počas behu informuj používateľa o progrese (Rust build môže trvať niekoľko minút).

### Krok 6 — Reportuj výsledok
Po úspešnom builde vypíš:
- Verzia: X.Y.Z
- Artefakty: `src-tauri/target/release/bundle/` (na Windows `nsis/*.exe`, prípadne `msi/*.msi`)
- Zoznam súborov z bundle priečinka (Glob `src-tauri/target/release/bundle/**/*.{exe,msi}`)

Ak build zlyhá, zobraz posledných 50 riadkov chybového výstupu a navrhni riešenie.
