# Our Memory Book

A shared web app for the two of you to upload memories (photo + title + date +
description), browse them together, and leave notes on each one. Updates sync
live between both of your devices.

It's a plain static site (`index.html` / `style.css` / `app.js`) backed by
[Supabase](https://supabase.com) (free tier) for the database, photo storage,
login, and realtime sync — no server to run yourself.

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a free project.
2. In the dashboard, open **SQL Editor**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `memories` and `notes` tables, the private `memory-photos` storage bucket,
   and the security rules that restrict access to only the people you allow.
3. Open **Table Editor > allowed_emails** and add a row for each of your two
   email addresses — only these emails will be able to sign in and see
   anything.
4. Open **Project Settings > API** and copy the **Project URL** and the
   **anon public** key.

## 2. Configure the app

Edit [`config.js`](config.js) and paste in your values:

```js
window.MEMORY_BOOK_CONFIG = {
  supabaseUrl: "https://xxxxx.supabase.co",
  supabaseAnonKey: "eyJ...",
};
```

The anon key is safe to commit/expose — it only grants what the Row Level
Security policies in `schema.sql` allow (i.e. nothing, unless your email is
in `allowed_emails`).

## 3. Set the auth redirect URL

Once you know where you'll host the site (see below), go to **Authentication
> URL Configuration** in Supabase and set the **Site URL** (and add a
**Redirect URL**) to that address, e.g. `https://yourname.github.io/memory-book/`.
This is what the magic-link email will redirect back to.

## 4. Deploy

Simplest option — GitHub Pages:

1. In this repo's **Settings > Pages**, set **Source** to "Deploy from a
   branch", branch `main`, folder `/ (root)`.
2. Your site will be live at `https://<your-username>.github.io/<repo-name>/`.

(Any static host — Netlify, Vercel, Cloudflare Pages — works too; just point
it at the repo root.)

## 5. Use it

Open the site, enter your email, and click the magic link sent to your
inbox. Once signed in you can add memories and notes — your girlfriend does
the same from her own email. Both of you will see updates live.

## Notes on privacy

- Only the emails listed in `allowed_emails` can sign in and see any data —
  everyone else's requests are blocked by Row Level Security, even though
  the anon key itself is public.
- Photos live in a **private** storage bucket; the app links to them via
  short-lived signed URLs, not public links.
- Anyone can technically request a magic-link sign-in for an email not on the
  list, but Supabase will just create an inert account for them — they still
  won't be able to read or write any memories or notes.
