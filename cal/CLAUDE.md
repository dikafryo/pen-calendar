# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`/var/services/web/sw4u/cal` is a multi-tenant department calendar web app (부서 일정표) served live by the vm1 docker stack. It has no build step, no package manager, and no test suite. Saving a PHP file is immediately live.

The app is three PHP files:

| File | Role |
|---|---|
| `index.php` | Single entry point — dispatches JSON API requests and renders the full HTML+JS frontend |
| `lib.php` | All shared functions and constants (loaded first via `require_once`) |
| `admin.php` | Admin panel — only included when the request path starts with `/admin` |

## Routing

Requests hit `index.php` via the nginx vhost. Routing is done purely by query string and request method:

- `/admin` or `/admin/*` → `is_admin_path()` → includes `admin.php` and calls `render_admin_page()`
- `?api=meta&doc=<hash>` (GET/POST) → read or update document metadata
- `?api=events&doc=<hash>&month=<YYYY-MM>` (GET/POST/DELETE) → read, write, or delete events
- `?api=sheet-push&doc=<hash>` (POST) → push all events to Google Sheets (or return CSV if `GOOGLE_SHEET_PUSH_URL` is empty)
- Anything else without `?api=` → renders the calendar HTML page

The `doc` param (or bare query string value, e.g. `/?digital_future`) is the **document hash** — the namespace key for a tenant. `query_hash()` in `lib.php` parses it and falls back to `'default'`.

## Data storage

All data lives under `data/<hash>/`:

```
data/
  <hash>/
    meta.json          # { hash, title, teams[], updatedAt }
    2026-05.json       # array of event objects for that month
    2026-06.json
    audit.log          # one JSON line per mutation (create/update/delete)
  .htaccess            # Deny all — protects raw data from direct HTTP access
```

Events are stored per-month. An event object has: `id`, `date` (YYYY-MM-DD), `start`, `end` (HH:MM or empty), `title`, `place`, `targets[]`, `team`, `manager`, `modifiedBy`, `updatedAt`.

`write_json_file()` always writes to a `.tmp` then renames atomically. `read_json_file()` uses `flock(LOCK_SH)`.

## Constants (lib.php top)

```php
const DATA_DIR = __DIR__ . '/data';
const ADMIN_PASSWORD = 'elwlxjf';
const GOOGLE_SHEET_PUSH_URL = '';      // empty = CSV fallback
const GOOGLE_SHEET_ID = '1fXlUHo_...';
const GOOGLE_SHEET_GID = '769698193';
```

## Multi-tenancy

Each calendar document is identified by its hash (e.g. `digital_future`, `default`). The hash becomes a directory name under `data/`. Creating a new tenant = posting to `/admin` → `create_doc` action, or just hitting `/?<newhash>` which auto-creates the directory on first API write.

Teams (up to 4) are stored in `meta.json` and map to color slots `team-color-1` through `team-color-4` in the CSS. Targets are hardcoded: 교육감, 부교육감, 국장, 과장.

## Frontend

The entire frontend is inline JS in `index.php` (~700 lines). It uses vanilla JS with no framework. `state` is the single global object. Key patterns:

- All API calls go through `request(api, params, options)` which constructs `?api=<x>&doc=<hash>&...`
- Calendar view and list view are toggled via CSS class `full-view` on `.app`
- List view uses infinite scroll: `extendList('up'/'down')` loads 14-day chunks via `Promise.all` on multiple month requests
- Event rendering: `renderEvent()` produces HTML strings; click/dblclick delegation handles event selection and modal open
- Time input: digits-only (e.g. `1100`) normalized to `HH:MM` on blur by `normalizeTimeInput()`

## Admin panel

`/admin` is password-protected (plain-text compare via `hash_equals`). Actions:
- `create_doc` — create a new document hash + initial meta
- `update_doc` — update title/teams for an existing document
- `download_csv` — stream a CSV for a date range (sends `Content-Disposition: attachment`)

## Validation / testing

No test suite. Validate by hitting the live URL or:

```bash
# PHP syntax check
docker exec phpfpm php -l /var/www/html/sw4u/cal/index.php
docker exec phpfpm php -l /var/www/html/sw4u/cal/lib.php
docker exec phpfpm php -l /var/www/html/sw4u/cal/admin.php

# Quick HTTP check
docker exec nginx curl -sI -H 'Host: <vhost>' http://127.0.0.1/
```

## File permissions

New files must be readable by `www-data` (UID 33). The `data/` directory has setgid (`2775`) so new subdirs inherit the group. If PHP returns 500, check `/home/dikafryo/docker/WebServer/phpfpm/logs/php_errors.log`.
