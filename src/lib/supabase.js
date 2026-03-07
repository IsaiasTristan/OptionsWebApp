/**
 * Supabase client and strategies API for cloud-backed watchlist.
 * If VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set, watchlist syncs to Supabase.
 * Otherwise the app falls back to localStorage (local only).
 */
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

const TABLE = "strategies";

/** Fetch all saved strategies. Returns { list, error } so caller can fall back to localStorage on error. */
export async function fetchStrategies() {
  if (!supabase) return { list: [], error: false };
  const { data, error } = await supabase
    .from(TABLE)
    .select("name, snapshot, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("Supabase fetchStrategies error:", error.message);
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
    console.warn("Supabase saveStrategy error:", error.message);
    return false;
  }
  return true;
}

/** Delete one strategy by name. */
export async function deleteStrategy(name) {
  if (!supabase) return false;
  const { error } = await supabase.from(TABLE).delete().eq("name", name);
  if (error) {
    console.warn("Supabase deleteStrategy error:", error.message);
    return false;
  }
  return true;
}

export function isCloudEnabled() {
  return !!supabase;
}
