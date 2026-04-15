# Supabase setup (Step 3 – cloud watchlist)

**What this does:** Your saved tickers/strategies are stored in Supabase instead of only in the browser. Open the app at home or work and you see the same list.

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in (or create a free account).
2. Click **New project**.
3. Pick an organization (or create one), a **project name** (e.g. `options-web`), a **database password** (save it somewhere), and a region. Click **Create project** and wait until it’s ready.

---

## 2. Create the `strategies` table

1. In the Supabase dashboard, open **Table Editor** (left sidebar).
2. Click **New table**.
3. Use:
   - **Name:** `strategies`
   - **Columns:** add these (leave “id” as the default first column if present, and add the rest):
     - `name` – type **text**, check **Unique**, **Nullable** off (required).
     - `snapshot` – type **jsonb**, **Nullable** on.
     - `created_at` – type **timestamptz**, **Default:** `now()`.
     - `updated_at` – type **timestamptz**, **Nullable** on.
   - If the table already has an `id` (uuid) primary key, keep it. Otherwise add **id** as **uuid**, **primary key**, **default:** `gen_random_uuid()`.
4. Under **Constraints**, ensure there is a **unique** constraint on `name` (so “Save” with the same name overwrites).
5. Click **Save**.

**Optional – run as SQL instead:** In **SQL Editor**, run:

```sql
create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  snapshot jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz
);
```

---

## 3. Get your API keys

1. In Supabase, go to **Settings** (gear) → **API**.
2. Copy:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **anon public** key (under “Project API keys”).

---

## 4. Add keys to your app

1. In the project folder `options-model-web`, copy the example env file:
   - **Windows (Command Prompt):**  
     `copy .env.example .env`
   - **Mac/Linux:**  
     `cp .env.example .env`
2. Open `.env` in an editor and set:
   - `VITE_SUPABASE_URL` = your Project URL (no trailing slash).
   - `VITE_SUPABASE_ANON_KEY` = your anon public key.
3. Save the file. **Do not commit `.env`** (it’s in `.gitignore`); only `.env.example` is shared.

---

## 5. Install dependency and run

In Command Prompt, in `options-model-web`:

```bat
npm install
npm run dev
```

Open the app; save a ticker and open the Watchlist. You should see a small cloud icon (☁) next to “Watchlist” when Supabase is connected. Saves and deletes will sync to the cloud, and the same list will appear from any computer once the app is deployed (e.g. Vercel) and uses the same `.env` in production.

---

## 6. Row Level Security (RLS) — required for production

The browser uses the **anon** key. Anyone can open your deployed site, so **Postgres RLS** must define who may read/write each table.

**`strategies` (watchlist)**  
Without policies, anon may be denied everything or (worse) allowed everything depending on defaults. For a **single shared team list** (simplest), you can allow all anon read/write:

```sql
alter table public.strategies enable row level security;

create policy "strategies_select_anon"
  on public.strategies for select
  using (true);

create policy "strategies_insert_anon"
  on public.strategies for insert
  with check (true);

create policy "strategies_update_anon"
  on public.strategies for update
  using (true)
  with check (true);

create policy "strategies_delete_anon"
  on public.strategies for delete
  using (true);
```

Tighten these policies when you add **auth** (e.g. `auth.uid()` per user). Market tables (`vol_surfaces`, `options_chains`, etc.) should typically be **read-only** for anon and writable only by the pipeline service role.

---

## 7. Troubleshooting: `TypeError: Failed to fetch` (browser)

That message means the **browser never got a normal HTTP response** from your project URL (network/DNS/TLS/extension), **not** a PostgREST “RLS denied” JSON error (those usually still complete the request).

Work through this list:

1. **Confirm `.env`** — `VITE_SUPABASE_URL` is exactly `https://<ref>.supabase.co` with **no** trailing slash, no spaces, and **https** (not `http://`). Restart `npm run dev` after every `.env` change.
2. **Paused project** — In [Supabase Dashboard](https://supabase.com/dashboard), open the project. If it was paused, **Restore** it and wait until it is ready.
3. **Extensions** — Disable **ad blockers / privacy** extensions for `localhost` (they often block `*.supabase.co`).
4. **Network** — Try another network or turn VPN off/on; corporate firewalls sometimes block outbound API calls.
5. **Verify outside the browser** (Node 20+), from the project root with a real `.env`:

   ```bash
   npm run verify:supabase
   ```

   If this fails too, the problem is environmental (URL, key, firewall, or project state), not React. If it succeeds but the browser fails, focus on extensions or mixed content.

After connectivity works, if you then see **empty data** or **401/403** in the verify script body, add **RLS** `SELECT` policies for `anon` on `tickers`, `vol_surfaces`, and `screener_output` (see section 6).

---

## Summary

| Step | What you did |
|------|----------------|
| 1 | Created a Supabase project. |
| 2 | Created `strategies` table (name, snapshot, timestamps). |
| 3 | Copied Project URL and anon key from Settings → API. |
| 4 | Created `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. |
| 5 | Ran `npm install` and `npm run dev`; confirmed ☁ and sync. |
| 6 | (Production) Enabled RLS and policies on `strategies` (and read-only policies on market tables as needed). |

If you skip Supabase, the app still works with **localStorage** only (local to that browser). Once keys and the table are set, the watchlist is **cloud-backed** and shared across devices.
