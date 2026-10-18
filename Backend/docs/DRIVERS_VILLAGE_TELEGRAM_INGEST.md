# Driver's Village — 1C exports from Telegram (automatic import)

1C sends the Driver's Village export to Telegram three times a day. The ingest
picks the file up from that one chat and hands it to the existing importer
([DRIVERS_VILLAGE_IMPORT.md](DRIVERS_VILLAGE_IMPORT.md)). It has no import logic
of its own.

```
1C ──► 1C's Telegram bot ──► chat with the receiving account
                                  │  drivers-village:telegram-sync   (systemd timer, every 10 min)
                                  │    TDLib (MTProto, user account) · one allowed chat · filter
                                  ▼
            <state>/inbox/<message>-dv_parts_….txt
                                  │  the importer CLI, unchanged:
                                  │  ts-node … scripts/import-drivers-village.ts <file> --report-dir=…
                                  ▼
            Product · Stock · CatalogPart        (same rules as a manual import)
```

Code: `src/imports/drivers-village/telegram-ingest/`, commands
`scripts/drivers-village-telegram-login.ts` and
`scripts/drivers-village-telegram-sync.ts`, lock `src/imports/drivers-village/import-lock.ts`.
The ingest is **not** part of the HTTP app: `AppModule` never imports it, the
mobile API never touches Telegram credentials, and `ecosystem.config.js` (PM2)
does not start it.

## 1. Why a user account, and why TDLib

Checked on 2026-10-18:

- A bot cannot see messages of another bot, and Bot API downloads stop at
  20 MB. Reading the chat 1C's bot posts into therefore takes a **user**
  account speaking MTProto, with its own `api_id` from my.telegram.org.
- **TDLib** — Telegram's own client library — is used through `tdl` **8.1.0** and
  `prebuilt-tdlib` **0.1008067.0** (TDLib 1.8.67), both pinned exactly. tdl is
  CommonJS like this backend. The node addon ships prebuilt in the package and
  libtdjson comes from `@prebuilt-tdlib/<platform>`, built in GitHub Actions
  and published with npm provenance. No compiler is needed. Supported:
  Linux x86_64/arm64 (glibc ≥ 2.22 or musl), macOS ≥ 14, Windows x86_64;
  Node ≥ 16.14.
- Not used: **GramJS** (`telegram`) — its repository was archived on
  2026-07-14 and points to the **teleproto** fork, which is young and has one
  maintainer. **mtcute** 0.32 — active, but its CommonJS builds are deprecated
  ("will be removed completely"); it would also bring a native SQLite build.
- Telegram's terms: accounts that log in through third-party API clients are
  monitored for abuse. Use your own `api_id`, an established account (not a
  freshly registered one), and keep the request rate low. One pass makes one
  history request (plus a download when there is a new export).

What TDLib does here: `getChatHistory` on the one configured chat (newest
first, from the server — the message cache is off), then `downloadFile` with
`synchronous: true` for an accepted document. The file is copied into `inbox/`
and TDLib's copy is deleted.

## 2. Security model

| Secret | Where it lives | Never |
|---|---|---|
| `DV_TELEGRAM_API_ID`, `DV_TELEGRAM_API_HASH` | `Backend/.env` (0600) or a systemd `EnvironmentFile` | in git, in logs (the logger also redacts the hash) |
| **Session** = TDLib database `<state>/tdlib/db` (`td.binlog`) — full access to the account | `DV_TELEGRAM_STATE_DIR`, outside the repository | copied to another machine, backed up into shared storage, readable by other users |
| Phone number, login code, 2FA password | typed by the operator into the login command **on the server** | command-line arguments, environment, files, logs; the code and password are typed with no echo |

Enforced at every start (the commands refuse to run otherwise):

- `DV_TELEGRAM_STATE_DIR` is absolute and a real directory (not a symlink),
  owned by the user that runs the command, mode `0700`, and outside the
  project and every directory that contains `.git` or `package.json`.
- An existing `tdlib/`, `tdlib/db/`, `td.binlog` and ledger have no
  group/other access. The process umask is `0077`, so everything created is
  `0600` (files) / `0700` (directories).
- The login command runs only in an interactive terminal.
- tdl's `debug` logging is switched off whatever `DEBUG` says. With
  `DEBUG=tdl*` it would print every request, the login code included. TDLib
  logs at verbosity 1 (errors only).
- The importer child process gets the environment **without** any
  `DV_TELEGRAM_*` variable.

Only the configured chat is ever read. A message becomes an import only if all
of these hold (`document-filter.ts`):

1. It is in `DV_TELEGRAM_CHAT_ID`.
2. It is incoming (not sent by this account) and original (not forwarded or
   imported).
3. The sender is in `DV_TELEGRAM_SENDER_IDS`. For a private chat (positive id)
   the default is the chat's peer, i.e. the bot itself.
4. It is a document (not text, a photo, a sticker…).
5. The file name matches `DV_TELEGRAM_FILE_PATTERN` and the extension is
   `.txt`, `.tsv` or `.csv` (tab- or `;`-delimited text — what the importer
   reads).
6. The MIME type is in `DV_TELEGRAM_ALLOWED_MIME_TYPES`.
7. The size is known and at most `DV_TELEGRAM_MAX_FILE_BYTES` (never above the
   importer's 20 MB).
8. It is no older than `DV_TELEGRAM_MAX_AGE_HOURS`.

After the download, the file must match the announced size and contain no NUL
byte. The importer then checks the encoding, the header and every row itself.

## 3. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DV_TELEGRAM_API_ID` | — (required) | api_id from my.telegram.org → API development tools |
| `DV_TELEGRAM_API_HASH` | — (required) | api_hash from the same page (32 hex characters). Secret. |
| `DV_TELEGRAM_STATE_DIR` | — (required) | e.g. `/var/lib/mator-dv-telegram` (§4) |
| `DV_TELEGRAM_CHAT_ID` | — (required for sync) | chat the 1C bot posts to; for the bot's private chat this is the bot's user id. Find it with `--list-chats`. |
| `DV_TELEGRAM_SENDER_IDS` | peer of a private chat | comma-separated user/chat ids allowed to post exports; **required** for a group or channel (negative id) |
| `DV_TELEGRAM_FILE_PATTERN` | `^dv_parts_[A-Za-z0-9_.-]*\.txt$` | regular expression on the file name, case-insensitive |
| `DV_TELEGRAM_ALLOWED_MIME_TYPES` | `text/plain,text/tab-separated-values` | declared MIME types accepted |
| `DV_TELEGRAM_MAX_FILE_BYTES` | `20971520` | at most the importer's limit |
| `DV_TELEGRAM_MAX_AGE_HOURS` | `24` | older messages are never imported (protects against importing old history) |
| `DV_TELEGRAM_SCAN_LIMIT` | `50` | recent messages read per pass |
| `DV_TELEGRAM_MAX_ATTEMPTS` | `6` | attempts per export before it is `failed` |
| `DV_TELEGRAM_IMPORT_TIMEOUT_MINUTES` | `30` | the importer is stopped after this |
| `DV_TELEGRAM_RETENTION_DAYS` | `30` | how long archived/failed files, reports and finished ledger entries are kept |
| `DV_TELEGRAM_LOG_LEVEL` | `info` | `debug` also lists skipped old/outgoing documents |
| `DV_IMPORT_LOCK_FILE` | `/tmp/mator-drivers-village-import.lock` | the importer's host-wide lock (§5); the same value for manual runs and the timer |

The commands load `Backend/.env` themselves (already-set variables win), so a
systemd `EnvironmentFile=` works as well. The variables are listed here, not in
`.env.example`.

## 4. State directory

```
/var/lib/mator-dv-telegram/          0700, owner = the user running the backend
  tdlib/db/            the session (TDLib database, td.binlog) — SECRET
  tdlib/files/         TDLib's download cache, emptied after each download
  inbox/               downloaded, not imported yet (waiting for a retry)
  archive/             imported exports
  failed/              exports that will not be retried (operator review)
  reports/             one importer report directory per run (JSON + issues CSV)
  ledger-<chat>.json   what happened to every accepted message
  sync.lock            held during a sync or login
```

## 5. Processing rules

- **Order:** exports are imported oldest first — by the time the message was
  sent, then by message id. An export waiting for a retry holds the newer ones
  back, because an older export applied after a newer one would bring back
  older prices.
- **Idempotency:** the ledger keys every accepted message by its id. `imported`,
  `duplicate`, `failed` and `baseline` entries are never processed again. An
  export with the same SHA-256 as the last import is `duplicate` (1C re-sent an
  unchanged file). Re-running the importer on one file is safe anyway: it
  resumes after a failed batch.
- **Retries:** after 10, 20, 40 and 80 minutes, then every 2 hours, until
  `DV_TELEGRAM_MAX_ATTEMPTS`; the downloaded file is reused. An export that
  stops passing the filter while unfinished (older than the age limit) is
  `failed`.
- **Locks:** `sync.lock` allows one sync or login at a time. The import lock
  (`DV_IMPORT_LOCK_FILE`) is taken by `scripts/import-drivers-village.ts`
  itself for every real import, manual or from the ingest. A second import
  exits `3` and writes nothing; for the ingest that is a postponement, not an
  attempt. A lock is **never removed because of its age**. It is replaced only
  when its holder is provably gone — its process is dead, it was taken before
  the last reboot, or its pid now belongs to another process (Linux start
  time). A lock from another host, or one that cannot be read, stays until an
  operator removes it; the error says so.

| Importer result | Meaning | Ingest |
|---|---|---|
| exit 0, or exit 2 with rejected rows only | imported (rejected rows are data errors, listed in the report) | `imported` → `archive/` |
| exit 2 with projection failures | supply data written, some catalog rows missing | retry (a re-run re-projects them) |
| exit 1, aborted while writing | a batch failed and was rolled back | retry (re-run resumes) |
| exit 1, aborted with a database setup error | e.g. no linked BUSINESS seller | retry; fix the setup (DRIVERS_VILLAGE_IMPORT.md §1) |
| exit 1, aborted before any write without a setup error | the file itself: header, encoding, limits | `failed` at once → `failed/` |
| exit 3 | another import holds the lock | postponed 5 min, not counted |
| no report, crash, timeout | — | retry |

Exit codes of `drivers-village:telegram-sync`: `0` pass completed (also: nothing
new, another pass running, an export waiting for its retry); `1` aborted
(configuration, session, Telegram, local files); `2` an export failed for good
in this pass. A non-zero exit marks the systemd unit failed.

## 6. Deployment — in separate phases

Each phase ends with a check, and the next starts only when it passes. The
schedule is switched on in the **last** phase, by hand: nothing in the
repository, `npm ci` or `npm run build` installs or enables a timer, and
installing the unit files does not start them.

Prerequisites: the backend runs on the server per [DEPLOYMENT.md](DEPLOYMENT.md),
and the importer prerequisites of DRIVERS_VILLAGE_IMPORT.md §1 (migrations,
catalog seller, linked BUSINESS seller) are met. The examples use the backend
user `deploy` and the checkout `/home/deploy/mator.uz/Backend`; adjust both.

### Phase A — install (no Telegram access, no schedule)

1. **Code and dependencies** (as `deploy`, in the Backend directory):
   ```bash
   git pull                 # the branch with this change
   npm ci                   # installs tdl, prebuilt-tdlib and @prebuilt-tdlib/<platform>
   npm run build
   # Loads the native TDLib offline (no network, no session) — fails here if
   # the platform / glibc is not supported:
   node -e "const tdl=require('tdl');tdl.configure({tdjson:require('prebuilt-tdlib').getTdjson()});console.log(tdl.execute({_:'getOption',name:'version'}))"
   # → { _: 'optionValueString', value: '1.8.67' }
   ```
2. **State directory** (once, as root):
   ```bash
   sudo install -d -m 0700 -o deploy -g deploy /var/lib/mator-dv-telegram
   ```
3. **Configuration.** Add to `Backend/.env` (keep it `chmod 600`):
   ```bash
   DV_TELEGRAM_API_ID=…
   DV_TELEGRAM_API_HASH=…
   DV_TELEGRAM_STATE_DIR=/var/lib/mator-dv-telegram
   ```

Check: `ls -ld /var/lib/mator-dv-telegram` shows `drwx------ deploy deploy`.

### Phase B — Telegram authorization

4. **Telegram account and api_id.** Use the account that receives the 1C bot's
   files (for a private chat it must have pressed *Start* in that bot).
   Logged in as that account, open https://my.telegram.org → *API development
   tools* and create an application. Put `api_id` / `api_hash` only on the
   server (step 3). Never send them, or any login code, through a chat.
5. **Log in** — interactively, as `deploy`, in the Backend directory, in an SSH
   session (not via a script):
   ```bash
   npm run drivers-village:telegram-login -- --list-chats
   ```
   Enter the phone number, then the code Telegram sends to the app (hidden),
   then the 2FA password if set (hidden). The command prints only the account's
   user id and the chat list.
6. **Choose the chat.** From the list, put the 1C bot's id into `.env`:
   `DV_TELEGRAM_CHAT_ID=…`. For a group or channel, also set
   `DV_TELEGRAM_SENDER_IDS`. If 1C names its files differently, set
   `DV_TELEGRAM_FILE_PATTERN`.

Check: `ls -la /var/lib/mator-dv-telegram/tdlib` shows `drwx------`; in
Telegram → Settings → Devices the session appears as *Mator · Driver's Village
import*.

### Phase C — dry run

7. ```bash
   npm run drivers-village:telegram-sync -- --dry-run
   ```
   It reads the chat, downloads the newest eligible export into `dry-run/`
   (deleted afterwards) and runs the importer with `--dry-run`, which reads the
   database and writes nothing to it (proven by `drivers-village-dry-run.spec.ts`).
   The ledger is not touched. The log lists every document that was skipped
   and why.

### Phase D — review the report (sign-off before any write)

8. Open the importer's report under
   `/var/lib/mator-dv-telegram/reports/dry-run-*/` (`drivers-village-dry-run-*.json`
   and `…-issues.csv`) and check:
   - `meta.aborted` is `false`, `meta.delimiter` is `semicolon`,
     `meta.numberFormat` is `thousands-comma`;
   - `environment.issues` is empty (migrations, catalog seller, BUSINESS seller);
   - `summary.totalRows` matches the export; the rejected rows in the CSV have
     the expected reasons only (`invalid_code_1c` for codes with spaces or `&`,
     `placeholder_code_1c`, `invalid_quantity` for fractional/negative counts,
     `invalid_price` for 0, `unknown_unit` for `1` / `комп.`);
   - `prices.examples`: `1,100,000` → 1100000, a price below 1000 → ×1000;
   - `duplicates` and the `duplicate_quantities_differ` /
     `duplicate_names_differ` warnings: the chosen line and its price and
     quantity are the intended ones;
   - `rowsWithPartNumberChange` and the rows' `partNumber: { from, to }`: the
     part numbers that `code_1c` will replace;
   - `positionsNotInFile`: listed only, never changed or deleted.

   Continue only when this is right. Otherwise correct the 1C export or the
   settings and repeat Phase C.

### Phase E — first real pass, by hand

9. Decide about history. Without further action a pass imports the eligible
   exports of the last `DV_TELEGRAM_MAX_AGE_HOURS`, oldest first. To start only
   with the next export instead (nothing is downloaded or imported):
   ```bash
   npm run drivers-village:telegram-sync -- --baseline
   ```
10. Run one pass by hand and watch it:
    ```bash
    npm run drivers-village:telegram-sync
    jq '.lastImported, [.entries[] | {messageId, fileName, status, attempts, lastError}]' \
      /var/lib/mator-dv-telegram/ledger-<chat id>.json
    ```
    Spot-check a few positions in the admin console (price, quantity, part
    number). A wrong result here is the last moment to stop before anything
    runs unattended.

### Phase F — install the schedule, switched off

11. As root, write the two unit files. Use the node/npm the backend uses (as
    `deploy`, `command -v npm` gives the directory for `PATH`).
    ```ini
    # /etc/systemd/system/mator-dv-telegram-sync.service
    [Unit]
    Description=Mator: import Driver's Village 1C exports from Telegram (one pass)
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=oneshot
    User=deploy
    Group=deploy
    WorkingDirectory=/home/deploy/mator.uz/Backend
    Environment=PATH=/home/deploy/.nvm/versions/node/v22.16.0/bin:/usr/local/bin:/usr/bin:/bin
    ExecStart=/usr/bin/env npm run --silent drivers-village:telegram-sync
    UMask=0077
    TimeoutStartSec=2h
    NoNewPrivileges=yes
    PrivateDevices=yes
    ProtectKernelTunables=yes
    ProtectControlGroups=yes
    RestrictSUIDSGID=yes
    # No PrivateTmp=: the import lock in /tmp is shared with manual imports.
    ```
    ```ini
    # /etc/systemd/system/mator-dv-telegram-sync.timer
    [Unit]
    Description=Driver's Village Telegram sync every 10 minutes

    [Timer]
    OnCalendar=*:0/10
    RandomizedDelaySec=60
    Persistent=true

    [Install]
    WantedBy=timers.target
    ```
12. Load them **without enabling**, and confirm that nothing is scheduled:
    ```bash
    sudo systemctl daemon-reload
    systemctl is-enabled mator-dv-telegram-sync.timer   # → disabled
    systemctl is-active  mator-dv-telegram-sync.timer   # → inactive
    ```

### Phase G — switch the schedule on (separate, manual decision)

13. Only after Phases C–E were signed off:
    ```bash
    sudo systemctl enable --now mator-dv-telegram-sync.timer
    systemctl list-timers mator-dv-telegram-sync.timer
    journalctl -u mator-dv-telegram-sync -n 100 --no-pager
    ```
    `systemctl --failed` lists the unit after an exit 1 or 2; watch it, or add
    `OnFailure=` to the service.
14. Switch it off again at any time:
    `sudo systemctl disable --now mator-dv-telegram-sync.timer`.

Without systemd, the equivalent of step 13 is adding this crontab line (and of
step 14, removing it): `*/10 * * * * cd /home/deploy/mator.uz/Backend && npm run --silent drivers-village:telegram-sync >> logs/dv-telegram.log 2>&1`.
The locks prevent overlapping passes either way.

## 7. Operations

- **A failed export** is kept in `failed/`, with its report under `reports/`
  (path in the log and in the ledger's `reportDir`). Fix the cause (1C export
  or database setup). Re-import it by hand
  (`npm run import:drivers-village -- /var/lib/mator-dv-telegram/failed/<file>`)
  **only if no newer export has been imported since**; otherwise wait for the
  next export.
- **Manual imports** may run at any time: the import lock serializes them with
  the timer. A manual run that finds the lock busy exits `3`.
- **Pause:** `sudo systemctl stop mator-dv-telegram-sync.timer` (`disable` to
  keep it off after a reboot).
- **Log in again / other account:** stop the timer, then
  `npm run drivers-village:telegram-login -- --logout` (ends the session at
  Telegram and destroys the local database), then log in again.
- **Revoke from outside** (lost server, suspected leak): Telegram → Settings →
  Devices → terminate *Mator · Driver's Village import*, then `--logout` or
  delete `tdlib/` on the server. Rotate the api_hash on my.telegram.org if it
  leaked.
- **New server:** never copy `tdlib/`. Log in on the new server and end the old
  session.
- **Upgrading TDLib:** change the exact versions of `prebuilt-tdlib` (and `tdl`
  if needed), run `npm ci`, then the dry run. TDLib migrates its database
  itself.

## 8. Known limitations

- The importer reads both 1C's `;` export and Excel's tab text
  (DRIVERS_VILLAGE_IMPORT.md §2). Rows it cannot trust are rejected and listed
  in the report — on the 2026-10-18 export mainly codes with spaces or `&`
  (`96273708 GMB`), placeholder codes (`1`, `3333`), fractional or negative
  quantities, price `0` and units `1` / `комп.`. Rejected rows write nothing;
  the stored values of those positions stay as they were.
- `stocks.quantity` is an integer: a fractional quantity (`12.5` л) rejects the
  row rather than being rounded.
- The TDLib adapter is tested against a scripted client; the first contact
  with the real Telegram is the operator's login and dry run (Phases B–C).

## 9. Tests

`npx jest src/imports/drivers-village` runs with no Telegram, no TDLib binary
and no database:

- `telegram-ingest/ingest.spec.ts` — the pass over a scripted chat and importer:
  filter, order by send time, idempotency, re-delivery, duplicates, retries,
  give-up, lock busy, crash recovery, dry run, baseline.
- `telegram-ingest/ingest-rules.spec.ts` — an export from the chat goes through
  the real `DriversVillageImportService` and projection (in-memory fakes):
  code_1c is the part number; a repeated code_1c is one position at its
  highest valid price.
- `import-runner.spec.ts` — the child process with a stand-in importer (the
  real CLI is never started in tests), result classification, and parity with
  `npm run import:drivers-village`.
- `../import-lock.spec.ts` — two real processes racing for the lock, a holder
  killed with SIGKILL, no takeover by age, reboot / pid-reuse detection.
- `../drivers-village-dv-parts.spec.ts`, `../drivers-village-source-format.spec.ts`,
  `../drivers-village-dry-run.spec.ts` — the `;` export (anonymized fixture),
  both number formats, and the read-only proof of the dry run.
- `config`, `document-filter`, `secure-fs` (+ ledger), `tdlib-source`,
  `terminal-prompt`.
