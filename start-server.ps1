# CrowSync server launcher (open LAN mode)
#
# OPEN_REGISTRATION = ktokolvek na sieti sa pripoji len menom (ziadny token).
#   Vhodne pre lokalny/firewallom chraneny tim. NEPOUZIVAJ na verejnom internete.
#
# ADMIN_TOKEN = stale potrebny len pre DESTRUKTIVNE operacie z UI
#   (mazanie projektov/clenov, zmena nastaveni). Na bezne pripojenie ho netreba.
#   Zmen si hodnotu na vlastne tajne heslo, alebo riadok zakomentuj ak ho nechces.

$env:CROWSYNC_OPEN_REGISTRATION = "1"
$env:CROWSYNC_ADMIN_TOKEN = "moj-tajny-token-123"

# Volitelne: odkomentuj a uprav, ak chces ine cesty/port
# $env:CROWSYNC_PORT = "8001"
# $env:CROWSYNC_DB_PATH = "./crowsync.db"
# $env:CROWSYNC_STORAGE_ROOT = "./storage"

Write-Host "Spustam CrowSync server (open LAN mode)..." -ForegroundColor Green
python -m server.main
