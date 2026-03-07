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

## Summary

| Step | What you did |
|------|----------------|
| 1 | Created a Supabase project. |
| 2 | Created `strategies` table (name, snapshot, timestamps). |
| 3 | Copied Project URL and anon key from Settings → API. |
| 4 | Created `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. |
| 5 | Ran `npm install` and `npm run dev`; confirmed ☁ and sync. |

If you skip Supabase, the app still works with **localStorage** only (local to that browser). Once keys and the table are set, the watchlist is **cloud-backed** and shared across devices.
