# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A two-person shared "memory book": photo + title + date + description entries, with notes on each,
syncing live between devices. Deployed as a static site on GitHub Pages, backed by Supabase.

## Running it

There is no build step, no package manager, no test suite, and no dependencies to install.
`index.html` loads supabase-js from a CDN `<script>` tag, then `config.js`, then `app.js`.

Serve the directory over HTTP (not `file://` — OAuth redirects need a real origin):

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

Local sign-in also requires `http://localhost:8000` to be listed under
**Authentication > URL Configuration > Redirect URLs** in the Supabase dashboard —
`signInWithOAuth` passes `redirectTo: window.location.href`.

Deploy = push to `main`; GitHub Pages serves the repo root.

## Architecture

Four files matter:

- `index.html` — every screen and both modals are in the static markup, toggled via the `hidden`
  attribute. There is no router and no template engine; adding UI means adding markup here plus a
  `getElementById` ref at the top of `app.js`.
- `app.js` — one IIFE, no modules. Sections in order: DOM refs, auth, add-memory form, load/render,
  detail modal + notes, realtime, escaping helpers.
- `config.js` — `window.MEMORY_BOOK_CONFIG` with the Supabase URL and anon key. Intentionally
  committed; the anon key grants nothing on its own (see below).
- `supabase/schema.sql` — the authoritative security model. Run manually in the Supabase SQL editor;
  it is not applied by any migration tool, so schema changes need a hand-run. Every statement is
  written to be safely re-runnable — keep it that way when adding to it, or a partial re-run will
  abort partway and leave the project half-configured.

### Security model (read before touching data access)

There is no server and no application-level authorization code. All access control lives in the
Postgres RLS policies in `schema.sql`, which gate every table on `is_allowed_user()` — a
`security definer` function checking `auth.email()` against the `allowed_emails` table. Client code
can be assumed hostile; do not add client-side checks as if they were the enforcement layer, and do
not weaken a policy to make a feature work.

Delete is author-only (`author_email = auth.email()`); notes have no delete or update policy at all.
`author_email` is never sent from the client — it defaults to `auth.email()` in the column
definition *and* the insert policies pin it with `author_email = auth.email()`. Both halves matter:
a column default only applies when the client omits the field, so without the policy check either
allowed user could forge rows as the other. Keep both.

Photos live in a **private** bucket (`memory-photos`). The app never builds a public URL; it calls
`createSignedUrl(path, 3600)` per render via `getSignedUrl()`. Any new place that shows an image
must go through that helper. Object lifetime is managed by hand — `deleteMemory` removes the object
after the row, and a failed save removes what it uploaded — since nothing cascades from the table to
storage.

### State and rendering

Rendering is full-refresh, not incremental. `loadMemories()` refetches all memories into
`memoriesCache` and calls `memoriesList.replaceChildren(...)`; `loadNotes()` reassigns
`notesList.innerHTML`. Use `replaceChildren`/assignment rather than appending — a past bug
duplicated cards by appending on realtime events.

`memoriesCache` is what the detail modal reads from (`openDetail` looks up by id, it does not
refetch), so anything that mutates a memory must go through `loadMemories()` to keep the cache
honest.

The realtime channel (`subscribeRealtime`, guarded by `realtimeSubscribed` so it only ever runs
once) subscribes to `postgres_changes` on both tables and simply re-runs the loaders. Notes only
reload when the changed row belongs to the currently open memory (`currentMemoryId`).

Auth state is driven entirely by `sb.auth.onAuthStateChange` → `showApp()` / `showAuth()`; there is
no separate session-restore path.

### Escaping

All rendering is string-concatenated `innerHTML`, so every interpolated value must pass through
`escapeHtml()` (text nodes) or `escapeAttr()` (attribute values — quotes only). This is easy to
forget when adding a field; there is no framework doing it for you.
