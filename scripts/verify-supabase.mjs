/**
 * Verify reachability of Supabase REST from this machine (same env as Vite).
 * Run from project root: npm run verify:supabase
 *
 * Requires Node 20+ for --env-file, or set VITE_* in the environment manually.
 */
const urlRaw = (process.env.VITE_SUPABASE_URL ?? "").trim();
const key = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

const base = urlRaw.replace(/\/+$/, "");
if (!base || !key) {
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.");
  console.error("Create .env from .env.example and restart, or export the variables.");
  process.exit(1);
}

const endpoint = `${base}/rest/v1/tickers?select=symbol&limit=1`;
console.log("GET", endpoint);

try {
  const res = await fetch(endpoint, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  const body = await res.text();
  console.log("HTTP status:", res.status, res.statusText);
  console.log("Body (first 400 chars):", body.slice(0, 400));
  if (res.ok) {
    console.log("\nOK: network path to Supabase works. If the browser still fails, try disabling extensions or another browser.");
  } else if (res.status === 401 || res.status === 403) {
    console.log("\nAuth/RLS: request reached Supabase but was rejected. Check anon key and RLS policies.");
  } else {
    console.log("\nUnexpected status — check project URL and that the project is not paused.");
  }
} catch (e) {
  console.error("\nFetch failed (same class of error as the browser):", e.message);
  console.error("\nCheck: VPN/firewall, correct https URL, project not paused (Supabase dashboard), DNS.");
  process.exit(1);
}
