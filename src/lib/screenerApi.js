/**
 * Supabase query layer for the ScreenerDashboard.
 *
 * IMPORTANT: Never hard-code "today" as the query date. The pipeline runs
 * end-of-day (or manually), so "today" from the browser's perspective is often
 * a day ahead of the most recent data in the DB.  All date-sensitive queries
 * first resolve the latest available date from each table.
 */
import { supabase } from "./supabase.js";

// ── Date resolution ───────────────────────────────────────────────────────────

const _dateCache = {};

async function latestDate(table, dateCol = "as_of_date") {
  if (_dateCache[table]) return _dateCache[table];
  if (!supabase) return null;
  const { data } = await supabase
    .from(table)
    .select(dateCol)
    .order(dateCol, { ascending: false })
    .limit(1)
    .single();
  _dateCache[table] = data?.[dateCol] ?? null;
  return _dateCache[table];
}

// ── Tab 1: Universe screener table ────────────────────────────────────────────

export async function fetchUniverseData() {
  if (!supabase) return { rows: [], asOfDate: null };

  const [latestSurface, latestScreener] = await Promise.all([
    latestDate("vol_surfaces"),
    latestDate("screener_output"),
  ]);
  const d = latestSurface ?? latestScreener;

  const [screenerRes, surfaceRes, tickersRes, historyRes] = await Promise.all([
    supabase.from("screener_output").select("*").eq("as_of_date", latestScreener ?? d),
    supabase.from("vol_surfaces").select("*").eq("as_of_date", latestSurface ?? d),
    supabase.from("tickers").select("*").eq("active", true),
    supabase
      .from("vol_surfaces")
      .select("symbol, as_of_date, atm_iv_30d")
      .order("as_of_date", { ascending: false })
      .limit(50 * 252),
  ]);

  const screener  = screenerRes.data  || [];
  const surfaces  = surfaceRes.data   || [];
  const tickers   = tickersRes.data   || [];
  const history   = historyRes.data   || [];

  const histBySymbol = {};
  history.forEach((h) => {
    if (!histBySymbol[h.symbol]) histBySymbol[h.symbol] = [];
    if (h.atm_iv_30d != null) histBySymbol[h.symbol].push(h.atm_iv_30d);
  });

  const surfaceMap  = Object.fromEntries(surfaces.map((s) => [s.symbol, s]));
  const screenerMap = Object.fromEntries(screener.map((s) => [s.symbol, s]));

  const rows = tickers.map((tk) => {
    const sym = tk.symbol;
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
  return { rows, asOfDate: d };
}

// ── Tab 2: Chart grid ─────────────────────────────────────────────────────────

export async function fetchSurfaceHistory(days = 90) {
  if (!supabase) return [];
  const { data } = await supabase
    .from("vol_surfaces")
    .select("symbol, as_of_date, atm_iv_30d, atm_iv_60d, atm_iv_90d, atm_iv_180d, rv_20d, term_slope, skew_25d_30d")
    .order("as_of_date", { ascending: true })
    .limit(50 * days);
  return data || [];
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
export async function fetchEquityHistory(symbol, days = 120) {
  if (!supabase) return [];
  const { data } = await supabase
    .from("equity_daily")
    .select("trade_date, close")
    .eq("symbol", symbol)
    .order("trade_date", { ascending: true })
    .limit(days);
  return data || [];
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
      .single(),
    supabase
      .from("vol_surfaces")
      .select("atm_iv_30d, rv_20d, as_of_date")
      .eq("symbol", symbol)
      .order("as_of_date", { ascending: false })
      .limit(1)
      .single(),
  ]);

  const spot    = equityRow.data?.close ?? null;
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
      if (r.implied_vol < 0.03 || r.implied_vol > 3.0) return false;
      if ((r.bid ?? 0) < 0.05) return false;
      if ((r.open_interest ?? 0) < 5) return false;
      const mid = ((r.bid ?? 0) + (r.ask ?? 0)) / 2;
      if (mid > 0.10 && (r.ask - r.bid) / mid > 0.60) return false; // wide spread
      if (spot && (r.strike < spot * 0.70 || r.strike > spot * 1.40)) return false;
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

  const [surfaceRes, tickersRes, chainRes, equityRes] = await Promise.all([
    supabase.from("vol_surfaces").select("*").eq("as_of_date", d),
    supabase.from("tickers").select("*").eq("active", true),
    // Full chain for all tickers on latest chain date — for gap + parity checks
    // Do NOT filter by bid > 0 here; we need all rows for accurate row counts
    (async () => {
      // Query directly to avoid stale _dateCache from prior calls
      const { data: dateData } = await supabase
        .from("options_chains")
        .select("as_of_date")
        .order("as_of_date", { ascending: false })
        .limit(1)
        .single();
      const chainDate = dateData?.as_of_date;
      if (!chainDate) return { data: [] };
      return supabase
        .from("options_chains")
        .select("symbol, strike, expiry, option_type, implied_vol, bid, ask, dte, as_of_date")
        .eq("as_of_date", chainDate)
        .order("symbol").order("expiry").order("strike")
        .limit(60000);
    })(),
    // Latest close per ticker for parity computation
    supabase
      .from("equity_daily")
      .select("symbol, close, trade_date")
      .order("trade_date", { ascending: false })
      .limit(50),
  ]);

  const surfaces   = surfaceRes.data || [];
  const tickers    = tickersRes.data || [];
  const chainRows  = chainRes.data   || [];
  const equityRows = equityRes.data  || [];

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
      const iv = r.implied_vol * 100;
      return iv < 5 || iv > 500;
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
    const R = 0.0525;
    const callMap = {};
    const putMap  = {};
    rows.forEach((r) => {
      const key = `${r.expiry}|${r.strike}`;
      const mid = (r.bid + r.ask) / 2;
      if (r.option_type === "call") callMap[key] = { mid, dte: r.dte };
      else putMap[key] = { mid, dte: r.dte };
    });
    const parityViolations = [];
    Object.keys(callMap).forEach((key) => {
      if (!putMap[key] || spot == null) return;
      const [expiry, strikeStr] = key.split("|");
      const K = parseFloat(strikeStr);
      const T = callMap[key].dte / 365;
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
      if (s.atm_iv_30d != null && (s.atm_iv_30d < 5 || s.atm_iv_30d > 500))
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
