# Audit projektu CrowSync

**Dátum:** 2026-06-14 · **Verzia:** v0.1.0
**Rozsah:** `server/` (Python/FastAPI), `src/` (React/TS), `src-tauri/` (Rust), schéma DB, konfigurácia (Docker/Caddy), dokumentácia
**Metóda:** kompletné čítanie kódu + spustenie testov (97 prešlo: 86 pytest, 11 vitest)

---

## Zhrnutie

Projekt je v dobrom stave. Jadro je solídne: atomické DB operácie cez `with_transaction()`, streaming na všetkých prenosových cestách, traversal ochrana, hash-only ukladanie kľúčov, WS auth mimo query stringu.

Najvýznamnejší problém nebol bug, ale **diera v sync modeli: nešírili sa zmazania súborov** (D1). Tá je spolu so všetkými M/N nálezmi **opravená 2026-06-14** (nižšie). Otvorené ostávajú len prevádzkové bezpečnostné veci (S).

| Závažnosť | Otvorené | Pozn. |
|---|---|---|
| Kritické (K) | 0 | — |
| Vysoké (D – design) | 0 | D1 opravené 2026-06-14 |
| Stredné (M) | 0 | M1–M3 opravené 2026-06-14 |
| Nízke / drift (N) | 0 | N1–N5 opravené 2026-06-14 |
| Bezpečnosť (S) | 2 prevádzkové | S-TLS, S-admin-master-key (známe, deployment-level) |

---

## Stav opráv — 2026-06-14

Všetky kódové nálezy implementované a overené (**90 pytest + 11 vitest** zelené, type-check čistý, `cargo check` OK).

- **D1** — `/compare` prijíma `tombstones` a vracia `deleted_local`/`deleted_remote`; `useFileWatch` push/pull ich aplikuje (server `DELETE` resp. natívny `delete_local`), manuálny delete v `SyncPage` maže aj lokálny súbor. Reklasifikácia chráni neuloženú prácu (zmenený checksum → `new_local`, nie delete). Nové testy v `server/tests/test_compare.py` pokrývajú deleted_local / conflict / deleted_remote / new_local.
- **M1** — `revert_file` kopíruje blob cez `asyncio.to_thread` (neblokuje event-loop).
- **M2** — `_gc_rate_limit_buckets()` v hodinovom loope čistí prázdne IP buckety.
- **M3** — WS auth má per-IP rate-limit (`_rate_limit_ws`, 20/60 s).
- **N1** — CLAUDE.md aktualizovaná (testy, sync-flow s tombstones, Known issues).
- **N2** — mŕtvy `storage.create_version` odstránený.
- **N3** — `auto_unlock_hours` + `max_file_size_mb` editovateľné v Settings UI.
- **N4** — legacy `root_path` odstránený z wire (model/klient); DB stĺpec ponechaný.
- **N5** — CrowForge zvyšky v `.claude/` (risograph agent + memory) zmazané.

Detailné popisy nálezov ostávajú nižšie ako referencia.

---

## D — Návrhová diera (vysoká)

### D1: Sync nešíri zmazania v žiadnom smere → zmazané súbory „obživnú"
`POST /compare` (`server/main.py:303–346`) klasifikuje len podľa prítomnosti + checksumu:
- súbor **lokálne chýba, na serveri je** → `new_remote` → `pull()` ho stiahne späť;
- súbor **lokálne je, na serveri chýba** → `new_local` → `push()` ho znova nahrá.

Dôsledok: keď člen lokálne zmaže asset, najbližší sync ho stiahne naspäť (`useFileWatch.ts:187`). Keď niekto zmaže súbor na serveri (cez UI `DELETE /files`), ostatným členom sa pri syncu znova nahrá z ich lokálnej kópie. **Zmazanie sa teda nikdy nepropaguje** a navyše sa vracia.

Klient má pritom `syncState` s bázou per path (`version`+`checksum`) a aj `removeSyncBase`, ale compare ho na detekciu delete nepoužíva — `removeSyncBase` sa volá len pri **manuálnom** delete z UI (`SyncPage.tsx:184`), nie pri sync diffe.

**Overené (2026-06-14) — diera je silnejšia, ruší aj single-user manuálny delete.**
`CompareResult` (`src/types/index.ts:125`) má presne 6 tried (`new_local`, `modified_local`, `behind`, `conflict`, `new_remote`, `synced`) — žiadnu delete kategóriu. `compare_project` má dva cykly: cez lokálne súbory (chýba na serveri → `new_local`, `main.py:303`) a cez serverové súbory (`if path not in local_map` → `new_remote`, `main.py:339`). Báza sa použije **iba** vo vetve „existuje na oboch stranách, líši sa checksum" (`main.py:312–337`) — na chýbajúci súbor nikdy. V `fs_ops.rs` navyše neexistuje príkaz na zmazanie lokálneho súboru (len `scan_dir`/`detect_unity`/`upload_file`/`download_file`), takže ani `pull` nevie zmazať lokálne.

Konkrétny prejav bez druhého člena: `handleDelete` (`SyncPage.tsx:172`) zmaže súbor zo servera (`DELETE /files`) + `removeSyncBase`, ale **lokálny súbor na disku ostane**. Reťaz:

```
manuálny delete → server: preč · disk: stále tam · báza: preč
   ↓ najbližší compare (5s poll)
disk má súbor, server nie → new_local → push → súbor sa VRÁTI na server
```

Používateľ teda zmaže súbor a o ~5 s ho jeho vlastný auto-sync nahrá späť. `removeSyncBase` v `handleDelete` rieši len účtovníctvo bázy, nie samotnú dieru.

**Náprava:** v compare rozlíšiť „nikdy som nemal" od „mal som synchronizované a teraz chýba" pomocou bázy:
- lokálne chýba **a** mám bázu (`base_version>0`) → kandidát na *pull-delete* (zmazať lokálne) **alebo** server-delete podľa toho, ktorá strana drží záznam;
- pridať triedy `deleted_local` / `deleted_remote` do `CompareResult` a obslúžiť ich v push/pull (resp. `DELETE`).
Toto je priamy pokračovateľ K1 — báza existuje, len sa neaplikuje na mazanie.

---

## M — Stredné

### M1: `revert_file` blokuje async event-loop pri kopírovaní blobu
`server/main.py:1062` volá `shutil.copy2(...)` synchrónne priamo v async handleri. Pri reverte multi-GB assetu sa zablokuje celý event-loop (všetky ostatné requesty čakajú). Upload to rieši správne cez `asyncio.to_thread` / streaming; revert by mal tiež (`await asyncio.to_thread(shutil.copy2, ...)`).

### M2: Rate-limit slovník `_members_hits` rastie neobmedzene
`server/main.py:138` — `defaultdict(list)` má jednu položku na každú videnú IP a nikdy sa nečistí (čistia sa len časové pečiatky vnútri zoznamu, nie samotné kľúče). Pri dlhom behu / striedaní IP je to pomalý memory leak. Stačí periodicky odstrániť prázdne kľúče (napr. v `_auto_unlock_loop`) alebo použiť `OrderedDict` s capom.

### M3: WebSocket auth nemá rate-limit
`POST /members` je rate-limitované (10/60 s), ale prvá WS správa s `{"type":"auth", api_key}` (`main.py:1206`) nie je — útočník môže cez WS skúšať kľúče bez throttlingu. Riziko je nízke (128-bit keyspace + `compare_digest`), ale konzistentnosť by neuškodila. Informatívne.

---

## N — Nízke / drift

| # | Nález | Kde |
|---|---|---|
| N1 | **CLAUDE.md je zastaraná**: tvrdí „There is **no test runner configured** — don't claim tests pass", pritom existuje plná sada (`server/tests/`, `src/__tests__/`, `conftest.py`, `vitest.config.ts`) a **97 testov prechádza**. Sekcia „Known issues" je k 2026-06-13. Treba aktualizovať. | `CLAUDE.md` |
| N2 | `storage.create_version` je teraz **mŕtvy kód** — všade ho nahradil atomický `commit_new_version`, nikto ho už nevolá. | `server/storage.py:469` |
| N3 | Settings UI (`App.tsx`) edituje len `storage_root`; `auto_unlock_hours` a `max_file_size_mb` síce `PUT /settings` aj `SettingsUpdate` podporujú, ale z UI sa nedajú meniť (len cez API). | `src/App.tsx:128` |
| N4 | `project.root_path` (stĺpec + `ProjectCreate.root_path` + `ProjectUpdate`) ostáva na drôte, ale server ho už pre sync nečíta (lokálna cesta je klient-side v localStorage). Legacy pole. | `schema.sql:6`, `main.py:158` |
| N5 | `.claude/` (agent `risograph-ui-auditor` + `agent-memory/`) referencuje `C:\unity\CrowForge` — skopírované z iného projektu, tu nemá čo auditovať. Kozmetické. | `.claude/agents/` |

---

## S — Bezpečnosť (prevádzkové, vedome odložené)

- **S-TLS:** `X-Member-Name`/`X-Api-Key` idú v hlavičkách v plaintexte; WS kľúč v prvej správe. Pred ostrým nasadením **povinne** za reverse proxy — repo má pripravený `Caddyfile` + `docker-compose.tls.yml`. Deployment-level, nie kód.
- **S-admin-master-key:** `CROWSYNC_ADMIN_TOKEN` je master kľúč ku všetkým účtom (re-POST `/members` vydá nový kľúč ktorémukoľvek členovi cez `reset_member_key`). Zámerný recovery mechanizmus — token treba držať v tajnosti. Zdokumentované.
- *Informatívne:* MD5 checksumy slúžia na detekciu zmien, nie ako integrita proti útočníkovi.

---

## Pozitíva

- **Atomicita:** `commit_new_version`/`try_acquire_lock`/`try_release_lock` cez `with_transaction()` (write-lock + `BEGIN IMMEDIATE`) — race pri upload/lock správne ošetrený vrátane cleanupu blobu v každej vetve zlyhania.
- **Streaming všade** (8 MB chunky, FastAPI aj reqwest aj Rust scan) — multi-GB assety nesedia v RAM; 413 fail-fast cez Content-Length + mid-stream `UploadTooLarge`.
- **Resumable upload:** offset = on-disk veľkosť `.part` (autoritatívny), 409 resync, cross-restart cez klientom persistované `upload_id`, GC stale sessions.
- **Download** do `.crowsync-part` + atomický rename — žiadne polovičné assety.
- **Bezpečnosť:** `normalize_rel_path` na každom file endpointe, `secrets.compare_digest` na všetky porovnania kľúčov/tokenov, hash-only kľúče, WS auth mimo logov.
- **Unity-aware** vrstva sú čisté pure funkcie (`unity.py`) s vlastnými testami; GUID scan má cap (`_META_SCAN_CAP`).
- **Testovacia sada:** 86 pytest + 11 vitest, všetky zelené.

---

## Odporúčané poradie prác

1. **D1** — delete-propagácia v sync modeli (jediná vecná diera; báza už existuje, treba ju aplikovať na mazanie).
2. **M1** — revert cez `asyncio.to_thread` (drobná, ale reálne blokuje server).
3. **M2 + M3** — GC rate-limit dictu, prípadne throttle WS auth.
4. **N1** — aktualizovať CLAUDE.md (testy existujú, prejsť „Known issues").
5. Upratať N2–N5 (mŕtvy kód, legacy `root_path`, `.claude/` zvyšky), doplniť `auto_unlock_hours`/`max_file_size_mb` do Settings UI (N3).
6. Pred produkciou: TLS proxy (S-TLS).
