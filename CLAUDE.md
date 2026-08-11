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

### Responsive layout

Sizing is fluid first (`clamp()` for gutters, headings, card gaps) with breakpoints reserved for
actual layout changes: 600px (phone), 601–1024px (tablet), 1200px+ (wider content column), plus a
short-landscape query for modal heights. Grid tracks use `minmax(min(260px, 100%), 1fr)` — the
`min()` is load-bearing, since a bare 260px track overflows viewports narrower than that.

Things that will bite if changed casually:

- **Inputs must stay ≥16px.** Below that, iOS Safari zooms the page in on focus and doesn't zoom back out.
- **Safe-area insets are applied per-region** (`.app-header`, `.app-main`, `#auth-screen`, the mobile
  modal), never on `body` — padding there stacks on top of the `100dvh` screens and forces the page
  to scroll by the inset amount. They only resolve to non-zero because of `viewport-fit=cover` in
  the viewport meta.
- **`dvh` with a `vh` line above it** for viewport heights, so mobile browser chrome doesn't clip.
- **Hover effects live under `@media (hover: hover) and (pointer: fine)`** — on touch they latch
  after a tap and leave cards looking stuck.
- On phones the modals become bottom sheets (`align-items: flex-end`, top-rounded, full width) and
  `.modal-actions` is `column-reverse` so the primary button sits on top, under the thumb.
- **The header menu is one DOM node in two presentations, not two copies.** `#header-menu` is a
  plain inline flex row above 600px (where `.menu-btn` is `display: none`); below it, the same
  element becomes an absolutely-positioned dropdown shown by the `.open` class. Don't duplicate the
  email/sign-out markup for mobile — the ids are queried once in `app.js`, and a second copy would
  give you duplicate ids and a dead `#sign-out-btn` listener.

To check a layout change, `tools/` has no harness — render it with headless Chrome over CDP
(`--window-size` is ignored; use `Emulation.setDeviceMetricsOverride`) and assert
`document.documentElement.scrollWidth <= clientWidth` at 320/375/744/1024/1440.

### PWA layer

`manifest.webmanifest` + `sw.js` + `icons/` make the site installable. Two rules matter:

**The service worker cache is an allowlist, not a denylist.** `sw.js` handles only same-origin
requests and the one pinned CDN library; everything else — Supabase REST, auth, realtime, and the
signed photo URLs — returns from the `fetch` handler untouched and goes straight to network. Those
responses carry session tokens and private photos, and signed URLs expire after an hour, so caching
them would write private data to disk *and* serve dead image links. Don't invert this into a
"skip Supabase" denylist; a new Supabase subdomain would then be silently cached.

**Bump `VERSION` in `sw.js` whenever a shell file changes.** The cache name derives from it, and
`activate` deletes every `memory-book-*` cache that isn't the current one. Adding a file to the
shell also means adding it to `SHELL_ASSETS` — and every entry must resolve, since `cache.addAll`
rejects the entire install if one 404s. Without a bump the worker is byte-identical, so no update
is detected: the HTML still refreshes (network-first) but CSS/JS arrive a launch late via
stale-while-revalidate, and the two are briefly mismatched.

The update prompt has two triggers, and both are needed. `updatefound` catches a worker installing
right now; the `registration.waiting` check at startup catches one that finished installing during
an earlier visit, where `updatefound` has already fired and will never fire again. Dropping the
latter silently loses the prompt. Because the browser only looks for a new `sw.js` on navigation —
and an installed PWA can go days without one — `registration.update()` is also called on
foreground/online/focus, throttled to once a minute.

Registration lives in its own IIFE at the bottom of `app.js`, outside the main one, because the main
IIFE returns early when Supabase or `config.js` is missing — the shell should still register and
report connectivity in that state. Paths are relative (`./sw.js`, `start_url: "./"`) so scope
follows the deploy directory; GitHub project pages serve from `/<repo-name>/`, not the domain root.

Icons are generated by `python3 tools/make-icons.py` (standard library only — it writes PNGs via
`zlib`). It reads its palette from the values in `style.css`; regenerate after a colour change. The
maskable variant keeps the heart inside the 80%-diameter safe zone, since Android crops to its own
shape.

### Escaping

All rendering is string-concatenated `innerHTML`, so every interpolated value must pass through
`escapeHtml()` (text nodes) or `escapeAttr()` (attribute values — quotes only). This is easy to
forget when adding a field; there is no framework doing it for you.
