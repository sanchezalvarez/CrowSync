# Audit projektu CrowSync

**Dátum:** 2026-06-12 · **Rozsah:** server/ (Python), src/ (React), src-tauri/ (Rust), konfigurácia, dokumentácia
**Stav:** v0.1.0, MVP klient-side sync modelu

---

## Stav opráv

**2026-06-12:** K1, V1, V2, V3, V4, N1–N8.

**2026-06-13:**
- **Resumable/chunked upload** (Fáza 4) — tus-lite session model (`upload_sessions` tabuľka, init/PATCH/status/complete/abort endpointy, GC v `_auto_unlock_loop`). Klient `fs_ops.rs:upload_file` resumuje cez offset; cross-restart resume cez klientom generované `upload_id` (`src/utils/uploadState.ts`).
- **S1** — `require_admin` gate na `DELETE /projects/{id}`, `DELETE /members/{id}`, `PUT /settings`; frontend posiela `X-Admin-Token` z localStorage.
- **S2a** — API kľúče sa v DB ukladajú len ako SHA-256 hash (`storage.hash_api_key`); migrácia hashne legacy plaintext in-place; recovery re-POST `/members` vydá **nový** kľúč (hash sa nedá vrátiť).
- **S2b** — WS auth presunutá z query stringu do prvej správy po connecte (`{"type":"auth",…}`).
- **Rate-limit** na `POST /members` (in-memory sliding window podľa IP, 10/60 s).
- **S3 (TLS)** — pripravený Caddy reverse proxy (`Caddyfile` + `docker-compose.tls.yml`) + README sekcia; samotné TLS je deployment-level, nie kód.
- **S4/S5** — informačné, zdokumentované (admin token = master kľúč; MD5 nie je integrita proti útočníkovi).

**Bez zásahu:** N9 (build-release.md už opravený), N10 (`.claude/` zvyšky z CrowForge ponechané).

Detaily k jednotlivým nálezom ostávajú nižšie ako referencia.

---

## Zhrnutie

Jadro je zdravé: atomické DB operácie (`commit_new_version`, `try_acquire_lock`), streaming prenosy s limitmi, path-traversal ochrana, temp-file+rename pri downloade, WS reconnect s backoffom. Najväčší problém nie je bug v kóde, ale **diera v sync modeli** — klient si nepamätá, ktorú verziu naposledy synchronizoval, takže konfliktná ochrana sa reálne nikdy nespustí (K1).

---

## K — Kritické

### K1: Klient nemá lokálnu sync-bázu → push prepisuje cudzie zmeny, pull nevidí updaty
`POST /compare` rozlišuje len podľa checksumu: lokálny súbor s iným checksumom než server skončí v `modified_local` (push kandidát) — bez ohľadu na to, **kto** ho zmenil. Dôsledky:

- **Pull nikdy nestiahne update existujúceho súboru.** `new_remote` obsahuje len súbory, ktoré lokálne vôbec neexistujú. Keď kolega nahrá v2 súboru, ktorý mám lokálne, zobrazí sa mi ako „modified locally".
- **Push ticho prepíše kolegovu novšiu verziu.** `useFileWatch.push()` posiela `base_version = f.server_version` (aktuálnu serverovú verziu, `src/hooks/useFileWatch.ts:102`), takže `base == current` a 409 stale-base ochrana v `upload_file` sa nikdy neaktivuje. Konfliktný dialóg funguje len pri manuálnom uploade cez UI.
- Stavy `behind`/`conflict` z `FILE_STATUS` (`src/types/index.ts:80`) sa nedajú z compare výsledku vôbec odvodiť.

**Náprava:** klient potrebuje lokálny stav per projekt (path → naposledy synchronizovaná verzia + checksum, napr. `.crowsync/state.json` v pracovnom priečinku alebo tauri-plugin-store). Compare potom vie odlíšiť „ja som zmenil" / „server má novšie" / „obaja" a push posiela skutočnú bázu.

## V — Vysoké (bugy)

### V1: Auto-unlock porovnáva nekompatibilné formáty časov — zámky expirujú neskoro
`storage.get_expired_locks` (`server/storage.py:351`) porovnáva `locked_at` (ISO s `T`, z `datetime.isoformat()`) so `datetime('now', '-Xh')` (SQLite formát s medzerou) ako stringy. Pre rovnaký dátum `'T' (0x54) > ' '/'0-9'`, takže zámok z dnešného dňa nikdy neexpiruje dnes — uvoľní sa až keď sa rozíde dátum (~o deň neskôr). *(Známe z minulého kola, stále otvorené.)*
**Náprava:** ukladať `locked_at` cez `strftime('%Y-%m-%d %H:%M:%S')` v UTC, alebo porovnávať v Pythone.

### V2: `revert_file` nekontroluje zámok a nie je atomický
`server/main.py:600` — revert (a) nekontroluje `locked_by_id`, takže obíde lock semantiku (upload 423 vracia, revert nie); (b) používa neatomické `create_version` + `update_file` namiesto `commit_new_version` → race s konkurentným uploadom môže preskočiť/zdvojiť číslo verzie. *(b je známe z minulého kola.)*

### V3: Registrácia druhého člena cez UI zlyhá naprázdno
`App.tsx:handleSetup` POSTuje `/members` bez `X-Admin-Token`. Keď už existuje člen, server vráti 403, klient to potichu zhltne (`catch { /* offline */ }`) a používateľ je „pripojený" bez API kľúča — každý request potom padá na 401 bez vysvetlenia. Setup obrazovka nemá pole pre admin token ani pre manuálne vloženie existujúceho `api_key` (recovery na novom stroji).

### V4: Docker nasadenie nemá ako dostať `CROWSYNC_ADMIN_TOKEN` do kontajnera
`docker-compose.yml` premennú nenastavuje a `.env` sa do kontajnera nedostane (nie je v image, `load_dotenv()` ho tam nenájde; compose `.env` slúži len na substitúciu, ktorá sa tu nepoužíva). README krok `cp .env.example .env` je teda pre Docker bez účinku → po prvom členovi sa už nikto nezaregistruje. **Náprava:** pridať `CROWSYNC_ADMIN_TOKEN=${CROWSYNC_ADMIN_TOKEN:-}` do `environment` v compose.

## S — Stredné (bezpečnosť) — *vedome odložené, neimplementované*

- **S1: Žiadne role.** Každý autentifikovaný člen môže zmazať celý projekt aj s blobmi (`DELETE /projects/{id}`), deaktivovať ľubovoľného člena (`DELETE /members/{id}`) a meniť serverové nastavenia vrátane `storage_root` (`PUT /settings`). Pre tímový nástroj minimálne destruktívne operácie patria za admin token.
- **S2: API kľúče v DB v plaintexte** a vo WS query stringu (`?api_key=…` — môže pretiecť do access logov / proxy). Hashovanie kľúčov + presun WS auth do subprotokolu/prvej správy.
- **S3: TLS chýba** — `X-Api-Key` ide cez internet v plaintexte. Vedome odložené; pred ostrým nasadením reverse proxy (Caddy/nginx). 
- **S4:** `POST /members` s existujúcim menom vráti jeho `api_key` (gated admin tokenom — je to zámerný recovery mechanizmus, ale znamená, že **admin token je master kľúč ku všetkým účtom**; hodno zdokumentovať).
- **S5:** MD5 checksums sú OK na detekciu zmien, nie ako integrita proti útočníkovi (informačné).

## N — Nízke (mŕtvy kód / konfiguračný drift)

| # | Nález | Kde |
|---|---|---|
| N1 | `safe_join` definovaný, nikde nevolaný (všetko ide cez `normalize_rel_path`) | `server/main.py:41` |
| N2 | `MAX_UPLOAD_BYTES_HARD_LIMIT` (50 GB) deklarovaný, nikdy nevynucovaný | `server/main.py:31` |
| N3 | `scan_directory`, `load_ignore_patterns`, `is_ignored` — legacy server-side scan, žiadny endpoint ich nepoužíva | `server/file_manager.py` |
| N4 | `get_or_create_member`, `get_member_by_api_key`, `lock_file` nepoužívané | `server/storage.py` |
| N5 | `checksum` query param pri uploade sa ignoruje (server počíta vlastný MD5) — buď verifikovať zhodu, alebo z klienta odstrániť | `server/main.py:359` |
| N6 | `CROWSYNC_LOG_LEVEL` v `.env.example` aj compose, ale kód ho nečíta (chýba `logging.basicConfig`) | `server/main.py` |
| N7 | `@tauri-apps/plugin-fs` a `plugin-store` v `package.json`, ale nepoužité v `src/` a nie sú v `Cargo.toml`; `tauri.conf.json` má pre ne mŕtvu `plugins` sekciu | `package.json`, `src-tauri/tauri.conf.json` |
| N8 | `max_file_size_mb` je v `GET /settings`, ale `SettingsUpdate` ho neumožňuje zmeniť | `server/main.py:702` |
| N9 | `.claude/commands/build-release.md` bol pre CrowForge (neexistujúce súbory) — prepísaný pre CrowSync v rámci tohto auditu | `.claude/commands/` |
| N10 | `.claude/agents/risograph-ui-auditor.md` + `agent-memory/` referencujú CrowForge (`C:\unity\CrowForge`) — skopírovaný `.claude` z iného projektu; agent tu nemá čo auditovať | `.claude/agents/` |

## Pozitíva

- Atomické `commit_new_version` / `try_acquire_lock` / `try_release_lock` cez `with_transaction()` (write-lock + `BEGIN IMMEDIATE`) — race condition pri uploade/locku správne ošetrený, vrátane cleanup blobu pri každej vetve zlyhania.
- Streaming na všetkých prenosových cestách (8 MB chunky, FastAPI aj reqwest) — multi-GB assety nesedia v RAM; 413 fail-fast cez Content-Length + mid-stream `UploadTooLarge`.
- Download v Rust ide do `.crowsync-part` temp súboru + atomický rename — žiadne polovičné assety pri výpadku spojenia.
- `normalize_rel_path` konzistentne na každom file endpointe (traversal ochrana), `secrets.compare_digest` na všetky porovnania kľúčov.
- WS: exponenciálny reconnect, ping/pong, deduplikácia eventov, debounced refresh.

## Odporúčané poradie prác

1. **K1** — lokálna sync-báza na klientovi (bez nej je lock+verzia ochrana iluzórna pri push/pull).
2. **V1 + V2** — drobné serverové opravy (formát času, revert cez `commit_new_version` + lock check).
3. **V3 + V4** — admin-token pole v setup UI + recovery flow; compose env.
4. **S1** — destruktívne endpointy za admin token.
5. TLS / hashovanie kľúčov pred ostrým nasadením (plán Fáza 4).
6. Upratať N1–N8 (mŕtvy kód, drift).
