/**
 * Supabase client and strategies API for cloud-backed watchlist.
 * If VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set, watchlist syncs to Supabase.
 * Otherwise the app falls back to localStorage (local only).
 */
import { createClient } from "@supabase/supabase-js";
import { reportError } from "./reportError.js";

const supabaseUrlRaw = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** Normalize URL so the JS client does not hit malformed endpoints (common cause of Failed to fetch). */
function normalizeSupabaseUrl(url) {
  if (!url) return "";
  let u = url.trim().replace(/\/+$/, "");
  if (u.startsWith("http://") && u.includes(".supabase.co")) {
    u = "https://" + u.slice("http://".length);
  }
  return u;
}

const supabaseUrl = normalizeSupabaseUrl(supabaseUrlRaw);

/** Unreplaced .env.example values create a client that always fails — treat as off. */
function isPlaceholderSupabaseEnv(url, key) {
  if (!url || !key) return true;
  if (/your-project-id\.supabase\.co/i.test(url)) return true;
  if (/^your-anon-key$/i.test(key)) return true;
  return false;
}

const envOk = supabaseUrl && supabaseAnonKey && !isPlaceholderSupabaseEnv(supabaseUrl, supabaseAnonKey);

export const supabase = envOk ? createClient(supabaseUrl, supabaseAnonKey) : null;

const TABLE = "strategies";

/** Fetch all saved strategies. Returns { list, error } so caller can fall back to localStorage on error. */
export async function fetchStrategies() {
  if (!supabase) return { list: [], error: false };
  const { data, error } = await supabase
    .from(TABLE)
    .select("name, snapshot, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    reportError("Supabase fetchStrategies", error);
    return { list: [], error: true };
  }
  const list = (data || []).map((row) => ({
    ticker: row.name,
    ...row.snapshot,
    savedAt: row.snapshot?.savedAt || row.created_at,
  }));
  return { list, error: false };
}

/** Save or overwrite one strategy by name. snapshot = full currentSnapshot-style object. */
export async function saveStrategy(name, snapshot) {
  if (!supabase) return false;
  const row = { name, snapshot, updated_at: new Date().toISOString() };
  const { error } = await supabase.from(TABLE).upsert(row, { onConflict: "name" });
  if (error) {
    reportError("Supabase saveStrategy", error);
    return false;
  }
  return true;
}

/** Delete one strategy by name. */
export async function deleteStrategy(name) {
  if (!supabase) return false;
  const { error } = await supabase.from(TABLE).delete().eq("name", name);
  if (error) {
    reportError("Supabase deleteStrategy", error);
    return false;
  }
  return true;
}

export function isCloudEnabled() {
  return !!supabase;
}
