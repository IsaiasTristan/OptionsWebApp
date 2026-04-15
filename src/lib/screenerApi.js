/**
 * Supabase query layer for the ScreenerDashboard.
 *
 * IMPORTANT: Never hard-code "today" as the query date. The pipeline runs
 * end-of-day (or manually), so "today" from the browser's perspective is often
 * a day ahead of the most recent data in the DB.  All date-sensitive queries
 * first resolve the latest available date from each table.
 */
import { supabase } from "./supabase.js";
import {
  CHAIN_IV_DECIMAL_MIN,
  CHAIN_IV_DECIMAL_MAX,
  CHAIN_MIN_BID,
  CHAIN_MIN_OPEN_INTEREST,
  CHAIN_MAX_SPREAD_RATIO,
  CHAIN_MONEYNESS_LOW,
  CHAIN_MONEYNESS_HIGH,
  QC_IV_PCT_MIN,
  QC_IV_PCT_MAX,
  QC_PARITY_RISK_FREE,
} from "./marketPolicy.js";
import { reportError } from "./reportError.js";

/** Default calendar span for vol surface history charts and IV-rank context (~1y). */
export const SURFACE_HISTORY_CALENDAR_DAYS = 365;

// ── Date helpers (YYYY-MM-DD, UTC calendar math) ─────────────────────────────

function addCalendarDays(isoDate, deltaDays) {
  const parts = String(isoDate).split("-").map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// ── Date resolution ───────────────────────────────────────────────────────────

const _dateCache = {};

/** Drop cached dates (e.g. after tests or if you need to force refresh). */
export function clearLatestDateCache() {
  for (const k of Object.keys(_dateCache)) delete _dateCache[k];
}

async function latestDate(table, dateCol = "as_of_date") {
  if (table in _dateCache) return _dateCache[table];
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(table)
    .select(dateCol)
    .order(dateCol, { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    reportError(`latestDate(${table})`, error);
    return null;
  }
  const val = data?.[dateCol] ?? null;
  _dateCache[table] = val;
  return val;
}

// ── Tab 1: Universe screener table ────────────────────────────────────────────

export async function fetchUniverseData() {
  if (!supabase) {
    return {
      rows: [],
      asOfDate: null,
      errors: [
        "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (real project values, not the example placeholders) and restart the dev server.",
      ],
    };
  }

  const [latestSurface, latestScreener] = await Promise.all([
    latestDate("vol_surfaces"),
    latestDate("screener_output"),
  ]);
  const d = latestSurface ?? latestScreener;
  const historyMinDate = d ? addCalendarDays(d, -(SURFACE_HISTORY_CALENDAR_DAYS - 1)) : null;

  // Avoid .eq("as_of_date", null) and heavy history pulls when pipeline has not landed yet.
  if (d == null) {
    const { data: tickersOnly, error: tErr } = await supabase.from("tickers").select("*").eq("active", true);
    if (tErr) reportError("fetchUniverseData tickers (no vol date)", tErr);
    const tickers = tickersOnly || [];
    const rows = tickers.map((tk) => ({
      symbol: tk.symbol ?? tk.ticker,
      sector: tk.sector,
      atm_iv_30d: null,
      atm_iv_60d: null,
      atm_iv_90d: null,
      atm_iv_180d: null,
      term_slope: null,
      skew_25d: null,
      rv_20d: null,
      iv_rv_spread: null,
      total_opt_vol: null,
      total_oi: null,
      pc_ratio: null,
      iv_rank: null,
      iv_pct: null,
      rank: null,
      volume_ratio: null,
      skew_zscore: null,
      composite_score: null,
      flags: [],
    })).filter((r) => r.symbol);
    const errors = [];
    if (tErr) errors.push(`tickers: ${tErr.message}`);
    else if (!rows.length) errors.push("tickers: 0 active rows (empty table, filter mismatch, or RLS denied SELECT).");
    else
      errors.push(
        "No rows in vol_surfaces / screener_output yet — symbols load but IV/screener columns stay empty until the pipeline runs.",
      );
    return { rows, asOfDate: null, errors };
  }

  const [screenerRes, surfaceRes, tickersRes, historyRes] = await Promise.all([
    supabase.from("screener_output").select("*").eq("as_of_date", latestScreener ?? d),
    supabase.from("vol_surfaces").select("*").eq("as_of_date", latestSurface ?? d),
    supabase.from("tickers").select("*").eq("active", true),
    (async () => {
      const pageSize = 1000;
      let offset = 0;
      const rows = [];
      for (;;) {
        const { data, error } = await supabase
          .from("vol_surfaces")
          .select("symbol, as_of_date, atm_iv_30d")
          .gte("as_of_date", historyMinDate)
          .lte("as_of_date", d)
          .order("as_of_date", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) return { data: null, error };
        const chunk = data || [];
        rows.push(...chunk);
        if (chunk.length < pageSize) break;
        offset += pageSize;
      }
      return { data: rows, error: null };
    })(),
  ]);

  const errors = [];
  if (screenerRes.error) {
    reportError("fetchUniverseData screener_output", screenerRes.error);
    errors.push(`screener_output: ${screenerRes.error.message}`);
  }
  if (surfaceRes.error) {
    reportError("fetchUniverseData vol_surfaces", surfaceRes.error);
    errors.push(`vol_surfaces: ${surfaceRes.error.message}`);
  }
  if (tickersRes.error) {
    reportError("fetchUniverseData tickers", tickersRes.error);
    errors.push(`tickers: ${tickersRes.error.message}`);
  }
  if (historyRes.error) {
    reportError("fetchUniverseData vol_surfaces history", historyRes.error);
    errors.push(`vol_surfaces history: ${historyRes.error.message}`);
  }

  if (tickersRes.error) {
    return { rows: [], asOfDate: d, errors };
  }

  const screener = screenerRes.data || [];
  const surfaces = surfaceRes.data || [];
  const tickers = tickersRes.data || [];
  const history = historyRes.data || [];

  if (!tickers.length) {
    errors.push("tickers: 0 active rows (empty table, or RLS blocked read).");
  }

  const histBySymbol = {};
  history.forEach((h) => {
    if (!histBySymbol[h.symbol]) histBySymbol[h.symbol] = [];
    if (h.atm_iv_30d != null) histBySymbol[h.symbol].push(h.atm_iv_30d);
  });

  const surfaceMap  = Object.fromEntries(surfaces.map((s) => [s.symbol, s]));
  const screenerMap = Object.fromEntries(screener.map((s) => [s.symbol, s]));

  const rows = tickers.map((tk) => {
    const sym = tk.symbol ?? tk.ticker;
    const s   = screenerMap[sym] || {};
    const v   = surfaceMap[sym]  || {};
    const ivH = histBySymbol[sym] || [];
    const curIV = v.atm_iv_30d;

    let ivRank = null, ivPct = null;
    if (curIV != null && ivH.length >= 5) {
      const lo = Math.min(...ivH), hi = Math.max(...ivH);
      if (hi > lo) ivRank = Math.round(((curIV - lo) / (hi - lo)) * 100);
      ivPct = Math.round((ivH.filter((x) => x <= curIV).length / ivH.length) * 100);
    }

    return {
      symbol: sym, sector: tk.sector,
      atm_iv_30d: v.atm_iv_30d, atm_iv_60d: v.atm_iv_60d,
      atm_iv_90d: v.atm_iv_90d, atm_iv_180d: v.atm_iv_180d,
      term_slope: v.term_slope, skew_25d: v.skew_25d_30d,
      rv_20d: v.rv_20d, iv_rv_spread: v.iv_rv_spread,
      total_opt_vol: v.total_opt_vol, total_oi: v.total_oi,
      pc_ratio: v.pc_volume_ratio,
      iv_rank: ivRank, iv_pct: ivPct,
      rank: s.rank, volume_ratio: s.volume_ratio,
      skew_zscore: s.skew_zscore, composite_score: s.composite_score,
      flags: s.flags || [],
    };
  });

  rows.sort((a, b) => (b.composite_score ?? -999) - (a.composite_score ?? -999));
  const validRows = rows.filter((r) => r.symbol);
  return { rows: validRows, asOfDate: d, errors };
}

// ── Tab 2: Chart grid ─────────────────────────────────────────────────────────

/**
 * Vol surface rows from the latest pipeline date back through `calendarDays` (inclusive).
 * Paginates past the default PostgREST page size so a full universe × ~1y loads reliably.
 */
export async function fetchSurfaceHistory(calendarDays = SURFACE_HISTORY_CALENDAR_DAYS) {
  if (!supabase) return [];
  const latest = await latestDate("vol_surfaces");
  if (!latest) return [];
  const minDate = addCalendarDays(latest, -(calendarDays - 1));
  if (!minDate) return [];

  const pageSize = 1000;
  let offset = 0;
  const out = [];
  for (;;) {
    const { data, error } = await supabase
      .from("vol_surfaces")
      .select(
        "symbol, as_of_date, atm_iv_30d, atm_iv_60d, atm_iv_90d, atm_iv_180d, rv_20d, term_slope, skew_25d_30d",
      )
      .gte("as_of_date", minDate)
      .lte("as_of_date", latest)
      .order("as_of_date", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      reportError("fetchSurfaceHistory vol_surfaces", error);
      break;
    }
    const chunk = data || [];
    out.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/**
 * Fetch one ticker's options chain from the most recent available date.
 */
export async function fetchTickerChainToday(symbol) {
  if (!supabase) return [];
  const d = await latestDate("options_chains");
  if (!d) return [];
  const { data } = await supabase
    .from("options_chains")
    .select("strike, expiry, option_type, implied_vol, volume, open_interest, dte, bid, ask, in_the_money")
    .eq("symbol", symbol)
    .eq("as_of_date", d)
    .gt("bid", 0)
    .order("expiry")
    .order("strike")
    .limit(3000);
  return data || [];
}

/**
 * Fetch daily equity price history for one ticker.
 * Used for computing rolling 20d realized vol to backfill the IV vs RV chart.
 */
/** Most recent `maxRows` equity closes (ascending by date) for RV / merge with IV series. */
export async function fetchEquityHistory(symbol, maxRows = 120) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("equity_daily")
    .select("trade_date, close")
    .eq("symbol", symbol)
    .order("trade_date", { ascending: false })
    .limit(maxRows);
  if (error) {
    reportError(`fetchEquityHistory(${symbol})`, error);
    return [];
  }
  return (data || []).slice().reverse();
}

/**
 * Compute 20-day rolling annualised realised vol from an array of equity rows.
 * Returns [{date, rv20}] aligned to the same date format as vol_surfaces.
 */
export function computeRollingRV(equityRows, window = 20) {
  if (!equityRows || equityRows.length < window + 1) return [];
  const sorted = [...equityRows].sort((a, b) => a.trade_date.localeCompare(b.trade_date));

  const logRets = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].close, curr = sorted[i].close;
    if (prev > 0 && curr > 0) logRets.push({ date: sorted[i].trade_date, lr: Math.log(curr / prev) });
  }

  const result = [];
  for (let i = window - 1; i < logRets.length; i++) {
    const slice = logRets.slice(i - window + 1, i + 1).map((x) => x.lr);
    const mean  = slice.reduce((a, b) => a + b, 0) / slice.length;
    const vari  = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    result.push({ date: logRets[i].date, rv20: +(Math.sqrt(vari * 252) * 100).toFixed(1) });
  }
  return result;
}

/**
 * Fetch all data needed to load a ticker into the Options Model:
 *  - Latest chain data → surfacePoints format
 *  - Latest equity close → spot price
 *  - Latest vol_surface → rv20, atm_iv
 */
export async function fetchTickerForModel(symbol) {
  if (!supabase) return null;

  const [chain, equityRow, surfaceRow] = await Promise.all([
    fetchTickerChainToday(symbol),
    supabase
      .from("equity_daily")
      .select("close, trade_date")
      .eq("symbol", symbol)
      .order("trade_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("vol_surfaces")
      .select("atm_iv_30d, rv_20d, as_of_date")
      .eq("symbol", symbol)
      .order("as_of_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (equityRow.error) reportError(`fetchTickerForModel equity (${symbol})`, equityRow.error);
  if (surfaceRow.error) reportError(`fetchTickerForModel vol_surfaces (${symbol})`, surfaceRow.error);

  const spot = equityRow.data?.close ?? null;
  const surface = surfaceRow.data ?? {};

  // Convert scraped chain → surfacePoints [{id, strike, expiry, iv}]
  // iv in PERCENTAGE (e.g. 45.2 for 45.2%) to match OptionsModel convention.
  // Apply strict liquidity filters so the vol surface fit is clean:
  //   - bid > $0.05   (real market, not stale/theoretical quotes)
  //   - OI > 5        (some open interest — proves it's trading)
  //   - spread < 50%  (bid-ask not too wide relative to mid)
  //   - IV 3%-300%    (filter obviously bad back-solved IV values)
  //   - moneyness 70-140% of spot (skip deep OTM garbage)
  const surfacePoints = chain
    .filter((r) => {
      if (
        r.implied_vol == null ||
        r.implied_vol < CHAIN_IV_DECIMAL_MIN ||
        r.implied_vol > CHAIN_IV_DECIMAL_MAX
      )
        return false;
      if ((r.bid ?? 0) < CHAIN_MIN_BID) return false;
      if ((r.open_interest ?? 0) < CHAIN_MIN_OPEN_INTEREST) return false;
      const mid = ((r.bid ?? 0) + (r.ask ?? 0)) / 2;
      if (mid > 0.1 && (r.ask - r.bid) / mid > CHAIN_MAX_SPREAD_RATIO) return false;
      if (spot && (r.strike < spot * CHAIN_MONEYNESS_LOW || r.strike > spot * CHAIN_MONEYNESS_HIGH))
        return false;
      return true;
    })
    .map((r, i) => ({
      id: `chain_${i}`,
      strike: r.strike,
      expiry: r.expiry,
      iv: +(r.implied_vol * 100).toFixed(2),
    }));

  return {
    symbol,
    spot: spot ?? 100,
    surfacePoints,
    rv20: surface.rv_20d ?? null,
    atm_iv_30d: surface.atm_iv_30d ?? null,
  };
}

// ── Tab 3: Volume anomaly feed ────────────────────────────────────────────────

export async function fetchVolumeAnomalyFeed(limit = 500) {
  if (!supabase) return { rows: [], latestDate: null, historyDays: 0 };

  const d = await latestDate("options_chains");
  if (!d) return { rows: [], latestDate: null, historyDays: 0 };

  const { data: todayData } = await supabase
    .from("options_chains")
    .select("symbol, strike, expiry, option_type, volume, open_interest, implied_vol, dte, bid, ask")
    .eq("as_of_date", d)
    .gt("volume", 0)
    .order("volume", { ascending: false })
    .limit(limit);

  const todayRows = todayData || [];
  if (!todayRows.length) return { rows: [], latestDate: d, historyDays: 0 };

  const { data: dateRows } = await supabase
    .from("options_chains")
    .select("as_of_date")
    .lt("as_of_date", d)
    .order("as_of_date", { ascending: false })
    .limit(20);
  const priorDates = [...new Set((dateRows || []).map((r) => r.as_of_date))];

  let avgMap = {};
  if (priorDates.length > 0) {
    const symbols = [...new Set(todayRows.map((r) => r.symbol))];
    const { data: histData } = await supabase
      .from("options_chains")
      .select("symbol, strike, expiry, option_type, volume, as_of_date")
      .in("as_of_date", priorDates)
      .in("symbol", symbols)
      .gt("volume", 0);

    const agg = {};
    (histData || []).forEach((r) => {
      const key = `${r.symbol}|${r.expiry}|${r.strike}|${r.option_type}`;
      if (!agg[key]) agg[key] = { sum: 0, count: 0 };
      agg[key].sum   += r.volume;
      agg[key].count += 1;
    });
    Object.entries(agg).forEach(([k, v]) => { avgMap[k] = v.sum / priorDates.length; });
  }

  const enriched = todayRows.map((r) => {
    const key        = `${r.symbol}|${r.expiry}|${r.strike}|${r.option_type}`;
    const avg        = avgMap[key] ?? null;
    const vol_ratio  = avg != null && avg > 0 ? +(r.volume / avg).toFixed(2) : null;
    const vol_oi_ratio = r.open_interest > 0 ? +(r.volume / r.open_interest * 100).toFixed(1) : null;
    return { ...r, avg_vol_20d: avg != null ? Math.round(avg) : null, vol_ratio, vol_oi_ratio,
      iv_pct: r.implied_vol != null ? +(r.implied_vol * 100).toFixed(1) : null };
  });

  return { rows: enriched, latestDate: d, historyDays: priorDates.length };
}

// ── Tab 4: Data QC ────────────────────────────────────────────────────────────

/**
 * Full QC data fetch — returns everything needed for all 5 checks:
 * row count, staleness, IV ranges, gap detection, put/call parity.
 */
export async function fetchDataQC() {
  if (!supabase) return [];

  const d = await latestDate("vol_surfaces");

  const [surfaceRes, tickersRes, chainRes] = await Promise.all([
    supabase.from("vol_surfaces").select("*").eq("as_of_date", d),
    supabase.from("tickers").select("*").eq("active", true),
    (async () => {
      const { data: dateData, error: dateErr } = await supabase
        .from("options_chains")
        .select("as_of_date")
        .order("as_of_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (dateErr) {
        reportError("fetchDataQC chain date", dateErr);
        return { data: [] };
      }
      const chainDate = dateData?.as_of_date;
      if (!chainDate) return { data: [] };
      return supabase
        .from("options_chains")
        .select("symbol, strike, expiry, option_type, implied_vol, bid, ask, dte, as_of_date")
        .eq("as_of_date", chainDate)
        .order("symbol").order("expiry").order("strike")
        .limit(60000);
    })(),
  ]);

  const surfaces = surfaceRes.data || [];
  const tickers = tickersRes.data || [];
  const chainRows = chainRes.data || [];

  const symbols = tickers.map((t) => t.symbol).filter(Boolean);
  let equityRows = [];
  if (symbols.length) {
    const { data: eqDateRow, error: eqDateErr } = await supabase
      .from("equity_daily")
      .select("trade_date")
      .order("trade_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eqDateErr) reportError("fetchDataQC equity latest date", eqDateErr);
    else if (eqDateRow?.trade_date) {
      const BATCH = 500;
      for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        const { data, error } = await supabase
          .from("equity_daily")
          .select("symbol, close, trade_date")
          .eq("trade_date", eqDateRow.trade_date)
          .in("symbol", batch);
        if (error) reportError(`fetchDataQC equity batch ${i}`, error);
        else equityRows = equityRows.concat(data || []);
      }
    }
  }

  const surfaceMap = Object.fromEntries(surfaces.map((s) => [s.symbol, s]));
  // latest close per symbol
  const spotMap = {};
  equityRows.forEach((r) => { if (!spotMap[r.symbol]) spotMap[r.symbol] = r.close; });

  // Group chain by symbol
  const chainBySym = {};
  chainRows.forEach((r) => {
    if (!chainBySym[r.symbol]) chainBySym[r.symbol] = [];
    chainBySym[r.symbol].push(r);
  });

  const chainDate = chainRows[0]?.as_of_date ?? null;
  const today     = new Date().toISOString().split("T")[0];

  return tickers.map((tk) => {
    const sym   = tk.symbol;
    const s     = surfaceMap[sym];
    const rows  = chainBySym[sym] || [];
    const spot  = spotMap[sym] ?? null;
    const issues = [];

    // ── Check 1: row count
    const rowCount = rows.length;
    if (rowCount === 0) issues.push({ code: "no_chain", label: "No chain data", severity: "missing" });
    else if (rowCount < 100) issues.push({ code: "sparse", label: `Sparse: ${rowCount} rows`, severity: "warn" });

    // ── Check 2: staleness (chain date vs today)
    let dayStale = null;
    if (chainDate) {
      const msPerDay = 86400000;
      dayStale = Math.round((new Date(today) - new Date(chainDate)) / msPerDay);
      if (dayStale > 1) issues.push({ code: "stale", label: `Stale ${dayStale}d`, severity: "warn" });
    }

    // ── Check 3: IV out of range
    const badIV = rows.filter((r) => {
      if (r.implied_vol == null || !Number.isFinite(r.implied_vol)) return false;
      const iv = r.implied_vol * 100;
      return iv < QC_IV_PCT_MIN || iv > QC_IV_PCT_MAX;
    });
    if (badIV.length > 0) issues.push({ code: "bad_iv", label: `${badIV.length} bad IV rows`, severity: "warn" });

    // ── Check 4: Gap detection
    const gapsByExpiry = {};
    const expiries = [...new Set(rows.map((r) => r.expiry))];
    let totalGaps = 0, atmNearGap = false;
    expiries.forEach((exp) => {
      const strikes = [...new Set(rows.filter((r) => r.expiry === exp).map((r) => r.strike))].sort((a, b) => a - b);
      if (strikes.length < 3) return;
      const diffs = strikes.slice(1).map((s, i) => +(s - strikes[i]).toFixed(4));
      const modeDiff = diffs.reduce((best, d, _, arr) => {
        const cnt = arr.filter((x) => Math.abs(x - d) < 0.01).length;
        return cnt > (arr.filter((x) => Math.abs(x - best) < 0.01).length) ? d : best;
      }, diffs[0]);
      const gaps = [];
      strikes.slice(1).forEach((s, i) => {
        const diff = +(s - strikes[i]).toFixed(4);
        if (diff > modeDiff * 1.9) {
          const missingCount = Math.round(diff / modeDiff) - 1;
          const missingStrikes = Array.from({ length: missingCount }, (_, j) =>
            +(strikes[i] + modeDiff * (j + 1)).toFixed(2)
          );
          gaps.push({ from: strikes[i], to: s, missing: missingStrikes });
          totalGaps += missingCount;
          // Is ATM (spot) near this gap?
          if (spot && Math.abs(spot - strikes[i]) < modeDiff * 3) atmNearGap = true;
        }
      });
      if (gaps.length > 0) gapsByExpiry[exp] = gaps;
    });
    if (totalGaps > 0) issues.push({
      code: "gaps",
      label: `${totalGaps} missing strike${totalGaps > 1 ? "s" : ""}${atmNearGap ? " (near ATM)" : ""}`,
      severity: atmNearGap ? "warn" : "info",
    });

    // ── Check 5: Put/call parity
    const R = QC_PARITY_RISK_FREE;
    const callMap = {};
    const putMap = {};
    rows.forEach((r) => {
      const bid = r.bid,
        ask = r.ask;
      if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
      const mid = (bid + ask) / 2;
      if (!Number.isFinite(mid)) return;
      const key = `${r.expiry}|${r.strike}`;
      if (r.option_type === "call") callMap[key] = { mid, dte: r.dte };
      else putMap[key] = { mid, dte: r.dte };
    });
    const parityViolations = [];
    Object.keys(callMap).forEach((key) => {
      if (!putMap[key] || spot == null) return;
      const [expiry, strikeStr] = key.split("|");
      const K = parseFloat(strikeStr);
      const dte = callMap[key].dte;
      const T = Number.isFinite(dte) ? dte / 365 : NaN;
      if (!Number.isFinite(T) || T <= 0) return;
      const pv_fwd = spot - K * Math.exp(-R * T);
      const actual = callMap[key].mid - putMap[key].mid;
      const diff   = Math.abs(actual - pv_fwd);
      if (diff > 0.50) parityViolations.push({ expiry, strike: K, diff: +diff.toFixed(2) });
    });
    if (parityViolations.length > 0) {
      const worst = parityViolations.reduce((a, b) => (b.diff > a.diff ? b : a));
      issues.push({
        code: "parity",
        label: `${parityViolations.length} parity viol. (worst $${worst.diff} @ ${worst.strike})`,
        severity: parityViolations.length > 10 ? "warn" : "info",
      });
    }

    // ── Surface check
    if (!s) issues.push({ code: "no_surface", label: "No vol surface", severity: "missing" });
    else {
      if (s.atm_iv_30d == null) issues.push({ code: "no_iv30", label: "Missing 30d IV", severity: "warn" });
      if (s.atm_iv_30d != null && (s.atm_iv_30d < QC_IV_PCT_MIN || s.atm_iv_30d > QC_IV_PCT_MAX))
        issues.push({ code: "iv_range", label: "IV out of range", severity: "warn" });
    }

    const severity = issues.find((i) => i.severity === "missing")
      ? "missing"
      : issues.find((i) => i.severity === "warn")
      ? "warn"
      : issues.length > 0
      ? "info"
      : "ok";

    return {
      symbol: sym, sector: tk.sector,
      rowCount, expiries: expiries.length,
      strikesPerExpiry: expiries.length > 0 ? Math.round(rowCount / expiries.length) : 0,
      chainDate, dayStale,
      atm_iv_30d: s?.atm_iv_30d ?? null,
      rv_20d: s?.rv_20d ?? null,
      total_opt_vol: s?.total_opt_vol ?? null,
      total_oi: s?.total_oi ?? null,
      gapsByExpiry, totalGaps,
      parityViolations: parityViolations.length,
      issues, severity,
    };
  });
}
