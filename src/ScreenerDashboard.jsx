import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Label,
} from "recharts";
import {
  fetchUniverseData,
  fetchSurfaceHistory,
  fetchTickerChainToday,
  fetchVolumeAnomalyFeed,
  fetchDataQC,
  fetchEquityHistory,
  computeRollingRV,
  fetchTickerForModel,
} from "./lib/screenerApi.js";

// ── Static maps ───────────────────────────────────────────────────────────────

const COMPANY_NAMES = {
  SRPT: "Sarepta Therapeutics", ALNY: "Alnylam Pharma",    IONS: "Ionis Pharma",
  BMRN: "BioMarin Pharma",      EXAS: "Exact Sciences",    HALO: "Halozyme",
  PCVX: "Vaxcyte",              ARWR: "Arrowhead Research", RARE: "Ultragenyx",
  MRNA: "Moderna",              SMCI: "Super Micro",        PLTR: "Palantir",
  NET:  "Cloudflare",           CRWD: "CrowdStrike",        SNOW: "Snowflake",
  AFRM: "Affirm",               HOOD: "Robinhood",          RKLB: "Rocket Lab",
  IONQ: "IonQ",                 APP:  "AppLovin",            AR:   "Antero Resources",
  RRC:  "Range Resources",      CTRA: "Coterra Energy",     OVV:  "Ovintiv",
  FANG: "Diamondback Energy",   CLF:  "Cleveland-Cliffs",   MP:   "MP Materials",
  BTU:  "Peabody Energy",       TRGP: "Targa Resources",    AM:   "Antero Midstream",
  SOXL: "3× Semi ETF",          TQQQ: "3× NASDAQ ETF",      XBI:  "Biotech ETF",
  ARKK: "ARK Innovation ETF",   UVXY: "Short-VIX ETF",      TNA:  "3× Small-Cap ETF",
  LABU: "3× Biotech ETF",       JNUG: "3× Gold Miners ETF", GDXJ: "Jr Gold Miners ETF",
  XLE:  "Energy Select ETF",    USO:  "US Oil Fund ETF",    GME:  "GameStop",            AMC:  "AMC Entertainment",
  MARA: "Marathon Digital",     RIVN: "Rivian",              LCID: "Lucid Group",
  SOFI: "SoFi Technologies",    CVNA: "Carvana",             UPST: "Upstart",
  AI:   "C3.ai",                MSTR: "MicroStrategy",
};

const SECTORS = ["all", "biotech", "momentum_tech", "energy", "etf", "meme"];
const SECTOR_COLORS = {
  biotech: "#8b5cf6", momentum_tech: "#0055a5",
  energy: "#c05a00", etf: "#5a6e85", meme: "#c0182e",
};
const SECTOR_LABELS = {
  biotech: "Biotech", momentum_tech: "Momentum Tech",
  energy: "Energy", etf: "ETF", meme: "Meme / Retail",
};

// ── Generic helpers ───────────────────────────────────────────────────────────

function fmt(v, dec = 1, suffix = "") {
  if (v == null) return "—";
  return `${(+v).toFixed(dec)}${suffix}`;
}
function ivRankColor(rank) {
  if (rank == null) return "#a8b8cc";
  if (rank >= 80) return "#c0182e";
  if (rank >= 60) return "#c05a00";
  if (rank >= 40) return "#0055a5";
  return "#006b44";
}
function rowBg(row) {
  if (row.term_slope != null && row.term_slope < -2) return "#fff0f3";
  if (row.term_slope != null && row.term_slope > 5)  return "#f0fff8";
  if (row.skew_zscore != null && Math.abs(row.skew_zscore) > 1.5) return "#fffbf0";
  return "#ffffff";
}
function ivHeatColor(iv, minIV = 10, maxIV = 150) {
  if (iv == null) return null; // null = trim this cell
  const t = Math.max(0, Math.min(1, (iv - minIV) / (maxIV - minIV)));
  if (t <= 0.5) {
    const s = t * 2;
    return `rgb(${Math.round(s * 255)}, ${Math.round(s * 255)}, 255)`;
  }
  const s = (t - 0.5) * 2;
  return `rgb(255, ${Math.round((1 - s) * 255)}, ${Math.round((1 - s) * 255)})`;
}
function SortArrow({ dir }) {
  return <span style={{ marginLeft: 3, fontSize: 9, opacity: 0.7 }}>{dir === "asc" ? "▲" : "▼"}</span>;
}

const FLAG_STYLE = {
  high_vrp:      { label: "HIGH VRP",      color: "#006b44", bg: "#d4f5e9" },
  skew_rich:     { label: "SKEW RICH",     color: "#c05a00", bg: "#fff0dc" },
  skew_cheap:    { label: "SKEW CHEAP",    color: "#0055a5", bg: "#e8f3fc" },
  vol_spike:     { label: "VOL SPIKE",     color: "#c0182e", bg: "#fde8ec" },
  term_inverted: { label: "BACKWARDATION", color: "#7c3aed", bg: "#f3eeff" },
};

// ── Chart helpers ─────────────────────────────────────────────────────────────

/** ATM IV per expiry from chain — ATM = call with minimum IV (bottom of smile) */
function computeTermStructure(chainData) {
  if (!chainData || !chainData.length) return [];
  const expiries = [...new Set(chainData.map((r) => r.expiry))].sort();
  const points = [];
  for (const exp of expiries) {
    const calls = chainData.filter(
      (r) => r.expiry === exp && r.option_type === "call"
        && r.implied_vol > 0.01 && r.implied_vol < 5 && r.bid > 0
    );
    if (calls.length < 2) continue;
    const atm = calls.reduce((best, r) => r.implied_vol < best.implied_vol ? r : best);
    points.push({
      label: `${atm.dte}d\n(${exp.slice(5)})`,
      dte: atm.dte,
      date: exp.slice(5),
      iv: +(atm.implied_vol * 100).toFixed(1),
    });
  }
  return points.sort((a, b) => a.dte - b.dte);
}

const SKEW_COLORS = ["#0055a5", "#c0182e", "#006b44", "#c05a00", "#7c3aed"];

// ── Chart components ──────────────────────────────────────────────────────────

function TermStructureChart({ symbol, surfaceHistory, chainData }) {
  const data = useMemo(() => {
    if (chainData && chainData.length > 0) {
      const pts = computeTermStructure(chainData);
      if (pts.length > 0) return pts;
    }
    const latest = [...surfaceHistory.filter((r) => r.symbol === symbol)].pop();
    if (!latest) return [];
    return [
      { label: "30d",  dte: 30,  date: "30d",  iv: latest.atm_iv_30d  },
      { label: "60d",  dte: 60,  date: "60d",  iv: latest.atm_iv_60d  },
      { label: "90d",  dte: 90,  date: "90d",  iv: latest.atm_iv_90d  },
      { label: "180d", dte: 180, date: "180d", iv: latest.atm_iv_180d },
    ].filter((d) => d.iv != null);
  }, [symbol, surfaceHistory, chainData]);

  if (!data.length) return <div style={styles.chartEmpty}>No term structure data yet</div>;

  const CustomTick = ({ x, y, payload }) => {
    const parts = payload.value.split("\n");
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={8} textAnchor="middle" fill="#1a2332" fontSize={9} fontWeight={600}>{parts[0]}</text>
        {parts[1] && <text x={0} y={0} dy={18} textAnchor="middle" fill="#a8b8cc" fontSize={7}>{parts[1]}</text>}
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={175}>
      <LineChart data={data} margin={{ top: 4, right: 12, bottom: 30, left: 10 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#eee" />
        <XAxis dataKey="label" tick={<CustomTick />} height={40} interval={0}>
          <Label value="Days to Expiry (Date)" offset={-18} position="insideBottom" style={{ fontSize: 8, fill: "#a8b8cc" }} />
        </XAxis>
        <YAxis tick={{ fontSize: 9 }} unit="%" domain={["auto", "auto"]} width={44}>
          <Label value="ATM IV (%)" angle={-90} position="insideLeft" offset={10} style={{ fontSize: 8, fill: "#a8b8cc" }} />
        </YAxis>
        <Tooltip formatter={(v) => `${v}%`} labelFormatter={(l) => `DTE: ${l}`} contentStyle={{ fontSize: 10 }} />
        <Line type="monotone" dataKey="iv" stroke="#0055a5" dot={{ r: 4 }} strokeWidth={2} name="ATM IV" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function IVvsRVChart({ symbol, surfaceHistory }) {
  const [equityRows, setEquityRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchEquityHistory(symbol, 120).then((rows) => { if (!cancelled) setEquityRows(rows); });
    return () => { cancelled = true; };
  }, [symbol]);

  const { data, rvDays } = useMemo(() => {
    const ivData = surfaceHistory
      .filter((r) => r.symbol === symbol && r.atm_iv_30d != null)
      .map((r) => ({ date: r.as_of_date, iv30: r.atm_iv_30d }));

    const rvData = equityRows ? computeRollingRV(equityRows, 20) : [];

    // Merge on date
    const rvMap = Object.fromEntries(rvData.map((r) => [r.date, r.rv20]));
    const ivMap = Object.fromEntries(ivData.map((r) => [r.date, r.iv30]));
    const allDates = [...new Set([...Object.keys(ivMap), ...Object.keys(rvMap)])].sort();

    const merged = allDates.map((d) => ({
      date: d.slice(5),
      iv30: ivMap[d] ?? null,
      rv20: rvMap[d] ?? null,
    })).filter((r) => r.iv30 != null || r.rv20 != null);

    return { data: merged, rvDays: rvData.length };
  }, [symbol, surfaceHistory, equityRows]);

  if (equityRows === null) return <div style={styles.chartEmpty}>Loading…</div>;

  if (!data.length) return (
    <div style={{ ...styles.chartEmpty, flexDirection: "column", gap: 4 }}>
      <div>No price history found for {symbol}</div>
    </div>
  );

  const hasIV = data.some((d) => d.iv30 != null);
  const hasRV = data.some((d) => d.rv20 != null);

  return (
    <div>
      {!hasIV && (
        <div style={{ fontSize: 8, color: "#c05a00", background: "#fff0dc", padding: "2px 8px", borderRadius: 4, marginBottom: 4 }}>
          IV line builds as pipeline runs daily · RV backfilled from {rvDays} days of equity history
        </div>
      )}
      <ResponsiveContainer width="100%" height={175}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="2 2" stroke="#eee" />
          <XAxis dataKey="date" tick={{ fontSize: 7 }} interval="preserveStartEnd">
            <Label value="Date" offset={-8} position="insideBottom" style={{ fontSize: 8, fill: "#a8b8cc" }} />
          </XAxis>
          <YAxis tick={{ fontSize: 9 }} unit="%" domain={["auto", "auto"]} width={44}>
            <Label value="Volatility (%)" angle={-90} position="insideLeft" offset={10} style={{ fontSize: 8, fill: "#a8b8cc" }} />
          </YAxis>
          <Tooltip formatter={(v) => v != null ? `${v.toFixed(1)}%` : "—"} contentStyle={{ fontSize: 10 }} />
          <Legend iconSize={8} wrapperStyle={{ fontSize: 9, paddingTop: 4 }} />
          {hasIV && <Line type="monotone" dataKey="iv30" stroke="#0055a5" dot={false} strokeWidth={2} name="30d ATM IV" />}
          {hasRV && <Line type="monotone" dataKey="rv20" stroke="#c0182e" dot={false} strokeWidth={2} name="20d Realised Vol" />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SkewChart({ chainData }) {
  const { chartData, lines } = useMemo(() => {
    if (!chainData || !chainData.length) return { chartData: [], lines: [] };

    const allExp = [...new Set(chainData.map((r) => r.expiry))].sort().slice(0, 4);

    // Get DTE per expiry
    const dteByExp = {};
    chainData.forEach((r) => { if (!dteByExp[r.expiry]) dteByExp[r.expiry] = r.dte; });

    const strikeSet = new Set();
    const ivMap = {};
    for (const exp of allExp) {
      ivMap[exp] = {};
      const rows = chainData.filter((r) => r.expiry === exp && r.implied_vol > 0.01 && r.implied_vol < 5 && r.bid > 0);
      rows.forEach((r) => {
        strikeSet.add(r.strike);
        const existing = ivMap[exp][r.strike];
        if (existing == null) ivMap[exp][r.strike] = r.implied_vol * 100;
        else ivMap[exp][r.strike] = (existing + r.implied_vol * 100) / 2;
      });
    }

    const strikes = [...strikeSet].sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(strikes.length / 30));
    const sampled = strikes.filter((_, i) => i % step === 0);

    const chartData = sampled.map((k) => {
      const row = { strike: k };
      allExp.forEach((exp) => { row[exp] = ivMap[exp][k] != null ? +ivMap[exp][k].toFixed(1) : null; });
      return row;
    });

    // Lines labeled as "Xd (MM/DD)"
    const lines = allExp.map((exp) => ({
      key: exp,
      label: `${dteByExp[exp] ?? "?"}d (${exp.slice(5)})`,
    }));

    return { chartData, lines };
  }, [chainData]);

  if (!chartData.length) return <div style={styles.chartEmpty}>Loading skew data…</div>;

  return (
    <ResponsiveContainer width="100%" height={175}>
      <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 20, left: 10 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#eee" />
        <XAxis dataKey="strike" tick={{ fontSize: 8 }} tickCount={6}>
          <Label value="Strike" offset={-8} position="insideBottom" style={{ fontSize: 8, fill: "#a8b8cc" }} />
        </XAxis>
        <YAxis tick={{ fontSize: 9 }} unit="%" domain={["auto", "auto"]} width={44}>
          <Label value="Implied Vol (%)" angle={-90} position="insideLeft" offset={10} style={{ fontSize: 8, fill: "#a8b8cc" }} />
        </YAxis>
        <Tooltip formatter={(v) => v != null ? `${v.toFixed(1)}%` : "—"} contentStyle={{ fontSize: 10 }} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 9, paddingTop: 4 }} />
        {lines.map((l, i) => (
          <Line key={l.key} type="monotone" dataKey={l.key} stroke={SKEW_COLORS[i % SKEW_COLORS.length]}
            dot={false} strokeWidth={1.5} connectNulls name={l.label} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function HeatmapGrid({ chainData }) {
  const { expiries, strikes, grid, minIV, maxIV } = useMemo(() => {
    if (!chainData || !chainData.length)
      return { expiries: [], strikes: [], grid: {}, minIV: 10, maxIV: 150 };

    // Build IV map per expiry/strike, get DTE per expiry
    const dteByExp = {};
    const rawGrid = {};
    chainData.forEach((r) => {
      if (r.implied_vol <= 0.01 || r.implied_vol >= 5 || r.bid <= 0) return;
      if (!dteByExp[r.expiry]) dteByExp[r.expiry] = r.dte;
      if (!rawGrid[r.expiry]) rawGrid[r.expiry] = {};
      const existing = rawGrid[r.expiry][r.strike];
      rawGrid[r.expiry][r.strike] = existing == null
        ? r.implied_vol * 100
        : (existing + r.implied_vol * 100) / 2;
    });

    const exps = Object.keys(rawGrid).sort().slice(0, 8);

    // Trim strikes that are all-empty across kept expiries
    const allStrikes = [...new Set(
      exps.flatMap((exp) => Object.keys(rawGrid[exp]).map(Number))
    )].sort((a, b) => a - b);

    // Sample strikes (max 14)
    const step = Math.max(1, Math.floor(allStrikes.length / 14));
    let sampleStrikes = allStrikes.filter((_, i) => i % step === 0);

    // Trim strikes where NO expiry has data
    sampleStrikes = sampleStrikes.filter((k) =>
      exps.some((exp) => rawGrid[exp]?.[k] != null)
    );

    const ivValues = Object.values(rawGrid).flatMap((byK) => Object.values(byK));
    const minIV = ivValues.length ? Math.floor(Math.min(...ivValues) / 5) * 5 : 10;
    const maxIV = ivValues.length ? Math.ceil(Math.max(...ivValues) / 5) * 5 : 150;

    // Build final grid with DTE labels
    const grid = {};
    exps.forEach((exp) => {
      const dte = dteByExp[exp] ?? "?";
      const label = `${dte}d\n${exp.slice(5)}`;
      grid[label] = {};
      sampleStrikes.forEach((k) => {
        // Nearest available strike within half-step
        const near = Object.keys(rawGrid[exp]).map(Number).reduce(
          (best, s) => Math.abs(s - k) < Math.abs(best - k) ? s : best, Infinity
        );
        grid[label][k] = Math.abs(near - k) <= step / 2 ? rawGrid[exp][near] : null;
      });
    });

    return { expiries: Object.keys(grid), strikes: sampleStrikes, grid, minIV, maxIV };
  }, [chainData]);

  if (!expiries.length) return <div style={styles.chartEmpty}>Loading heatmap…</div>;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 8 }}>
        <thead>
          <tr>
            <th style={{ padding: "2px 4px", background: "#f0f4f8", fontWeight: 600, textAlign: "left", fontSize: 7 }}>
              DTE / Date
            </th>
            {strikes.map((k) => (
              <th key={k} style={{ padding: "2px 3px", background: "#f0f4f8", fontWeight: 600, textAlign: "center", minWidth: 28, fontSize: 7 }}>
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {expiries.map((expLabel) => {
            const parts = expLabel.split("\n");
            return (
              <tr key={expLabel}>
                <td style={{ padding: "2px 4px", whiteSpace: "nowrap", color: "#1a2332", lineHeight: 1.2 }}>
                  <div style={{ fontWeight: 700, fontSize: 8 }}>{parts[0]}</div>
                  <div style={{ fontSize: 7, color: "#a8b8cc" }}>{parts[1]}</div>
                </td>
                {strikes.map((k) => {
                  const iv = grid[expLabel]?.[k];
                  const bg = ivHeatColor(iv, minIV, maxIV);
                  if (!bg) return <td key={k} style={{ padding: "3px 2px", background: "#f8fafc" }} />;
                  const textColor = iv != null && (iv < minIV + (maxIV - minIV) * 0.25 || iv > minIV + (maxIV - minIV) * 0.75) ? "#fff" : "#1a2332";
                  return (
                    <td key={k} style={{ padding: "3px 2px", textAlign: "center", background: bg, color: textColor, fontWeight: 600 }}>
                      {iv != null ? iv.toFixed(0) : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 7, color: "#a8b8cc", marginTop: 3 }}>
        IV Color Scale: Blue = {minIV}% → Red = {maxIV}%
      </div>
    </div>
  );
}

// ── Tab 1: Universe Screener ──────────────────────────────────────────────────

function UniverseTab({ asOfDate, onLoadTicker }) {
  const [data, setData]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [sortKey, setSortKey]     = useState("composite_score");
  const [sortDir, setSortDir]     = useState("desc");
  const [sectorFilter, setSectorFilter] = useState("all");
  const [search, setSearch]       = useState("");
  const [loadingTicker, setLoadingTicker] = useState(null);

  useEffect(() => {
    fetchUniverseData().then(({ rows }) => { setData(rows); setLoading(false); });
  }, []);

  const sorted = useMemo(() => {
    let rows = [...data];
    if (sectorFilter !== "all") rows = rows.filter((r) => r.sector === sectorFilter);
    if (search) rows = rows.filter((r) => r.symbol.includes(search.toUpperCase()));
    rows.sort((a, b) => {
      const av = a[sortKey] ?? (sortDir === "desc" ? -Infinity : Infinity);
      const bv = b[sortKey] ?? (sortDir === "desc" ? -Infinity : Infinity);
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return rows;
  }, [data, sortKey, sortDir, sectorFilter, search]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const handleLoad = async (symbol) => {
    setLoadingTicker(symbol);
    const tickerData = await fetchTickerForModel(symbol);
    setLoadingTicker(null);
    if (tickerData) onLoadTicker(tickerData);
  };

  const TH = ({ label, k, title }) => (
    <th onClick={() => toggleSort(k)} title={title} style={{
      ...styles.th, cursor: "pointer", userSelect: "none",
      background: sortKey === k ? "#e8f3fc" : "#f0f4f8",
    }}>
      {label}{sortKey === k && <SortArrow dir={sortDir} />}
    </th>
  );

  if (loading) return <div style={styles.loading}>Loading universe…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol…"
          style={{ padding: "4px 8px", border: "1px solid #dde3eb", borderRadius: 4, fontSize: 11, width: 120 }} />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {SECTORS.map((s) => (
            <button key={s} onClick={() => setSectorFilter(s)} style={{
              padding: "3px 8px", fontSize: 9, fontWeight: 700, borderRadius: 4, cursor: "pointer",
              border: "1px solid " + (sectorFilter === s ? "#0055a5" : "#dde3eb"),
              background: sectorFilter === s ? "#0055a5" : "#f0f4f8",
              color: sectorFilter === s ? "#fff" : "#5a6e85",
            }}>
              {s === "all" ? "ALL" : SECTOR_LABELS[s]}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 9, color: "#a8b8cc" }}>
          {sorted.length} tickers · {asOfDate ?? "—"} &nbsp;·&nbsp;
          <span style={{ color: "#c0182e" }}>Red</span> = backwardation &nbsp;
          <span style={{ color: "#006b44" }}>Green</span> = steep contango &nbsp;
          <span style={{ color: "#c05a00" }}>Yellow</span> = skew extreme
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={styles.th}>→ Model</th>
              <TH label="Symbol"       k="symbol" />
              <th style={styles.th}>Company</th>
              <th style={styles.th}>Sector</th>
              <TH label="ATM IV"       k="atm_iv_30d"      title="Front-month ATM implied vol" />
              <TH label="IV Rank"      k="iv_rank"          title="Current IV vs 52wk range (0=low, 100=high)" />
              <TH label="IV %ile"      k="iv_pct" />
              <TH label="Term Slope"   k="term_slope"       title="90d minus 30d ATM IV. Negative = backwardation" />
              <TH label="25d Skew"     k="skew_25d" />
              <TH label="IV-RV Spread" k="iv_rv_spread" />
              <TH label="RV 20d"       k="rv_20d" />
              <TH label="P/C Ratio"    k="pc_ratio" />
              <TH label="Opt Vol"      k="total_opt_vol" />
              <TH label="Vol Ratio"    k="volume_ratio" />
              <TH label="Score"        k="composite_score" />
              <th style={styles.th}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.symbol} style={{ background: rowBg(row), borderBottom: "1px solid #f0f4f8" }}>
                <td style={{ ...styles.td, textAlign: "center" }}>
                  <button onClick={() => handleLoad(row.symbol)} disabled={loadingTicker === row.symbol} style={{
                    padding: "2px 7px", fontSize: 9, fontWeight: 700, borderRadius: 4, cursor: "pointer",
                    border: "1px solid #0055a5", background: loadingTicker === row.symbol ? "#e8f3fc" : "#fff",
                    color: "#0055a5",
                  }}>
                    {loadingTicker === row.symbol ? "…" : "→"}
                  </button>
                </td>
                <td style={{ ...styles.td, fontWeight: 700, color: "#1a2332" }}>{row.symbol}</td>
                <td style={{ ...styles.td, color: "#5a6e85", fontSize: 10 }}>{COMPANY_NAMES[row.symbol] ?? "—"}</td>
                <td style={styles.td}>
                  <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                    background: `${SECTOR_COLORS[row.sector]}22`, color: SECTOR_COLORS[row.sector] ?? "#5a6e85" }}>
                    {SECTOR_LABELS[row.sector] ?? row.sector}
                  </span>
                </td>
                <td style={{ ...styles.td, fontWeight: 700, color: ivRankColor(row.iv_rank) }}>
                  {fmt(row.atm_iv_30d, 1, "%")}
                </td>
                <td style={{ ...styles.td, fontWeight: 700, color: ivRankColor(row.iv_rank) }}>
                  {row.iv_rank ?? "—"}
                </td>
                <td style={styles.td}>{row.iv_pct != null ? `${row.iv_pct}%` : "—"}</td>
                <td style={{ ...styles.td, fontWeight: 600, color: row.term_slope == null ? "#a8b8cc" : row.term_slope < 0 ? "#c0182e" : "#006b44" }}>
                  {fmt(row.term_slope, 1, " pts")}
                </td>
                <td style={styles.td}>{fmt(row.skew_25d, 1, "%")}</td>
                <td style={{ ...styles.td, fontWeight: 600, color: row.iv_rv_spread == null ? "#a8b8cc" : row.iv_rv_spread > 3 ? "#006b44" : row.iv_rv_spread < -3 ? "#c0182e" : "#1a2332" }}>
                  {fmt(row.iv_rv_spread, 1, " pts")}
                </td>
                <td style={styles.td}>{fmt(row.rv_20d, 1, "%")}</td>
                <td style={styles.td}>{fmt(row.pc_ratio, 2)}</td>
                <td style={styles.td}>{row.total_opt_vol != null ? (+row.total_opt_vol).toLocaleString() : "—"}</td>
                <td style={{ ...styles.td, fontWeight: 600, color: row.volume_ratio == null ? "#a8b8cc" : row.volume_ratio >= 2 ? "#c0182e" : "#1a2332" }}>
                  {row.volume_ratio != null ? `${(+row.volume_ratio).toFixed(1)}×` : "—"}
                </td>
                <td style={{ ...styles.td, fontWeight: 700, color: "#0055a5" }}>{fmt(row.composite_score, 1)}</td>
                <td style={styles.td}>
                  {row.flags.map((f) => {
                    const st = FLAG_STYLE[f];
                    return st ? (
                      <span key={f} style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3, marginRight: 3, background: st.bg, color: st.color }}>
                        {st.label}
                      </span>
                    ) : null;
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab 2: Chart Grid ─────────────────────────────────────────────────────────

const CHART_TYPES = [
  { id: "term",    label: "Term Structure" },
  { id: "iv_rv",   label: "IV vs RV" },
  { id: "skew",    label: "Skew" },
  { id: "heatmap", label: "Vol Heatmap" },
];

function TickerCard({ symbol, sector, chartType, surfaceHistory, onLoadTicker }) {
  const [chainData, setChainData]   = useState(null);
  const [loadingChain, setLoadingChain] = useState(true);
  const [loadingModel, setLoadingModel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingChain(true);
    fetchTickerChainToday(symbol).then((data) => {
      if (!cancelled) { setChainData(data); setLoadingChain(false); }
    });
    return () => { cancelled = true; };
  }, [symbol]);

  const handleLoad = async () => {
    setLoadingModel(true);
    const tickerData = await fetchTickerForModel(symbol);
    setLoadingModel(false);
    if (tickerData) onLoadTicker(tickerData);
  };

  const needsChain = chartType !== "iv_rv";
  const isLoading  = needsChain && loadingChain;

  return (
    <div style={{ background: "#fff", border: "1px solid #dde3eb", borderRadius: 8, padding: "10px 12px", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#1a2332" }}>{symbol}</div>
          <div style={{ fontSize: 9, color: "#a8b8cc" }}>{COMPANY_NAMES[symbol] ?? ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={handleLoad} disabled={loadingModel} title="Load into Options Model" style={{
            padding: "2px 8px", fontSize: 9, fontWeight: 700, borderRadius: 4, cursor: "pointer",
            border: "1px solid #0055a5", background: "#fff", color: "#0055a5",
          }}>
            {loadingModel ? "…" : "→ Model"}
          </button>
          <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
            background: `${SECTOR_COLORS[sector] ?? "#5a6e85"}22`,
            color: SECTOR_COLORS[sector] ?? "#5a6e85" }}>
            {SECTOR_LABELS[sector] ?? sector}
          </span>
        </div>
      </div>
      {isLoading && <div style={styles.chartEmpty}>Loading chain data…</div>}
      {!isLoading && chartType === "term"    && <TermStructureChart symbol={symbol} surfaceHistory={surfaceHistory} chainData={chainData ?? []} />}
      {chartType === "iv_rv"                 && <IVvsRVChart symbol={symbol} surfaceHistory={surfaceHistory} />}
      {!isLoading && chartType === "skew"    && <SkewChart chainData={chainData ?? []} />}
      {!isLoading && chartType === "heatmap" && <HeatmapGrid chainData={chainData ?? []} />}
    </div>
  );
}

function ChartsTab({ tickers, onLoadTicker }) {
  const [chartType, setChartType]   = useState("term");
  const [surfaceHistory, setSurfaceHistory] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [sectorFilter, setSectorFilter] = useState("all");

  useEffect(() => {
    fetchSurfaceHistory(90).then((data) => { setSurfaceHistory(data); setLoading(false); });
  }, []);

  const filteredTickers = sectorFilter === "all" ? tickers : tickers.filter((t) => t.sector === sectorFilter);
  const bySector = SECTORS.filter((s) => s !== "all").reduce((acc, sec) => {
    const group = filteredTickers.filter((t) => t.sector === sec);
    if (group.length) acc[sec] = group;
    return acc;
  }, {});

  const rvDaysHint = surfaceHistory.filter((r) => r.symbol === tickers[0]?.symbol).length;

  if (loading) return <div style={styles.loading}>Loading surface history…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "#5a6e85", fontWeight: 700, letterSpacing: "0.1em" }}>CHART:</span>
        {CHART_TYPES.map((ct) => (
          <button key={ct.id} onClick={() => setChartType(ct.id)} style={{
            padding: "4px 10px", fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: "pointer",
            border: "1px solid " + (chartType === ct.id ? "#0055a5" : "#dde3eb"),
            background: chartType === ct.id ? "#0055a5" : "#f0f4f8",
            color: chartType === ct.id ? "#fff" : "#5a6e85",
          }}>{ct.label}</button>
        ))}
        <div style={{ width: 1, height: 20, background: "#dde3eb" }} />
        <span style={{ fontSize: 9, color: "#5a6e85", fontWeight: 700 }}>SECTOR:</span>
        {SECTORS.map((s) => (
          <button key={s} onClick={() => setSectorFilter(s)} style={{
            padding: "3px 8px", fontSize: 9, borderRadius: 4, cursor: "pointer",
            border: "1px solid " + (sectorFilter === s ? "#0055a5" : "#dde3eb"),
            background: sectorFilter === s ? "#e8f3fc" : "#f0f4f8",
            color: sectorFilter === s ? "#0055a5" : "#5a6e85",
          }}>{s === "all" ? "All" : SECTOR_LABELS[s]}</button>
        ))}
        {chartType === "iv_rv" && rvDaysHint < 5 && (
          <div style={{ marginLeft: "auto", fontSize: 9, color: "#c05a00", background: "#fff0dc", padding: "3px 8px", borderRadius: 4 }}>
            IV line builds daily · RV backfilled from equity price history
          </div>
        )}
      </div>
      {Object.entries(bySector).map(([sec, group]) => (
        <div key={sec} style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: SECTOR_COLORS[sec] ?? "#5a6e85",
            letterSpacing: "0.12em", textTransform: "uppercase",
            borderBottom: `2px solid ${SECTOR_COLORS[sec] ?? "#dde3eb"}44`,
            paddingBottom: 4, marginBottom: 10,
          }}>
            {SECTOR_LABELS[sec]}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
            {group.map((t) => (
              <TickerCard key={t.symbol} symbol={t.symbol} sector={t.sector}
                chartType={chartType} surfaceHistory={surfaceHistory} onLoadTicker={onLoadTicker} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tab 3: Volume Anomaly Feed ────────────────────────────────────────────────

function AnomaliesTab() {
  const [rows, setRows]                 = useState([]);
  const [latestDate, setLatestDate]     = useState(null);
  const [historyDays, setHistoryDays]   = useState(0);
  const [loading, setLoading]           = useState(true);
  const [minVol, setMinVol]             = useState(100);
  const [minRatio, setMinRatio]         = useState(0);
  const [optType, setOptType]           = useState("all");
  const [sortKey, setSortKey]           = useState("volume");
  const [sortDir, setSortDir]           = useState("desc");

  useEffect(() => {
    fetchVolumeAnomalyFeed(500).then(({ rows: r, latestDate: d, historyDays: h }) => {
      setRows(r); setLatestDate(d); setHistoryDays(h); setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    let r = rows.filter((x) => (x.volume ?? 0) >= minVol);
    if (optType !== "all") r = r.filter((x) => x.option_type === optType);
    if (minRatio > 0) r = r.filter((x) => (x.vol_ratio ?? 0) >= minRatio);
    r.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return r;
  }, [rows, minVol, optType, minRatio, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const TH = ({ label, k }) => (
    <th onClick={() => toggleSort(k)} style={{ ...styles.th, cursor: "pointer", background: sortKey === k ? "#e8f3fc" : "#f0f4f8" }}>
      {label}{sortKey === k && <SortArrow dir={sortDir} />}
    </th>
  );

  const hasHistory = historyDays >= 5;
  if (loading) return <div style={styles.loading}>Loading volume data (computing 20d averages)…</div>;

  return (
    <div>
      <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 6, fontSize: 9,
        background: hasHistory ? "#d4f5e9" : "#fff0dc",
        color: hasHistory ? "#006b44" : "#c05a00",
        border: `1px solid ${hasHistory ? "#006b4444" : "#c05a0044"}` }}>
        {hasHistory
          ? `✓ Vol ratio computed from ${historyDays} prior sessions · Data as of ${latestDate}`
          : `⚠ ${historyDays} prior session${historyDays !== 1 ? "s" : ""} of history · Vol/OI shown as proxy · Data as of ${latestDate}`}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 9, color: "#5a6e85" }}>MIN VOL:</span>
        {[50, 100, 500, 1000, 5000].map((v) => (
          <button key={v} onClick={() => setMinVol(v)} style={{
            padding: "3px 8px", fontSize: 9, borderRadius: 4, cursor: "pointer",
            border: "1px solid " + (minVol === v ? "#0055a5" : "#dde3eb"),
            background: minVol === v ? "#0055a5" : "#f0f4f8",
            color: minVol === v ? "#fff" : "#5a6e85",
          }}>{v.toLocaleString()}</button>
        ))}
        <div style={{ width: 1, height: 20, background: "#dde3eb" }} />
        {hasHistory && <>
          <span style={{ fontSize: 9, color: "#5a6e85" }}>VOL RATIO ≥:</span>
          {[0, 1.5, 2, 3, 5].map((v) => (
            <button key={v} onClick={() => setMinRatio(v)} style={{
              padding: "3px 8px", fontSize: 9, borderRadius: 4, cursor: "pointer",
              border: "1px solid " + (minRatio === v ? "#c0182e" : "#dde3eb"),
              background: minRatio === v ? "#fde8ec" : "#f0f4f8",
              color: minRatio === v ? "#c0182e" : "#5a6e85",
            }}>{v === 0 ? "Any" : `${v}×`}</button>
          ))}
          <div style={{ width: 1, height: 20, background: "#dde3eb" }} />
        </>}
        {["all", "call", "put"].map((t) => (
          <button key={t} onClick={() => setOptType(t)} style={{
            padding: "3px 8px", fontSize: 9, fontWeight: 700, borderRadius: 4, cursor: "pointer",
            border: "1px solid " + (optType === t ? "#0055a5" : "#dde3eb"),
            background: optType === t ? "#e8f3fc" : "#f0f4f8",
            color: optType === t ? "#0055a5" : "#5a6e85",
            textTransform: "uppercase",
          }}>{t}</button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 9, color: "#a8b8cc" }}>{filtered.length} rows</div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <thead>
            <tr>
              <TH label="Symbol"      k="symbol" />
              <TH label="Type"        k="option_type" />
              <TH label="Strike"      k="strike" />
              <TH label="Expiry"      k="expiry" />
              <TH label="DTE"         k="dte" />
              <TH label="Vol Today"   k="volume" />
              <TH label="20d Avg Vol" k="avg_vol_20d" />
              <TH label="Vol Ratio"   k="vol_ratio" />
              <TH label="Vol/OI"      k="vol_oi_ratio" />
              <TH label="Open Int."   k="open_interest" />
              <TH label="IV"          k="iv_pct" />
              <TH label="Bid"         k="bid" />
              <TH label="Ask"         k="ask" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const ratio   = r.vol_ratio;
              const isSpike = ratio != null ? ratio >= 3 : (r.vol_oi_ratio ?? 0) >= 50;
              const isMod   = ratio != null ? ratio >= 2 : (r.vol_oi_ratio ?? 0) >= 25;
              return (
                <tr key={i} style={{
                  background: isSpike ? "#fff3f0" : isMod ? "#fffbf0" : i % 2 === 0 ? "#fff" : "#f8fafc",
                  borderBottom: "1px solid #f0f4f8" }}>
                  <td style={{ ...styles.td, fontWeight: 700 }}>{r.symbol}</td>
                  <td style={{ ...styles.td, fontWeight: 700, color: r.option_type === "call" ? "#006b44" : "#c0182e" }}>
                    {r.option_type?.toUpperCase()}
                  </td>
                  <td style={styles.td}>{r.strike}</td>
                  <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 10 }}>{r.expiry}</td>
                  <td style={styles.td}>{r.dte}</td>
                  <td style={{ ...styles.td, fontWeight: 700, color: "#0055a5" }}>
                    {r.volume != null ? (+r.volume).toLocaleString() : "—"}
                  </td>
                  <td style={{ ...styles.td, color: "#5a6e85" }}>
                    {r.avg_vol_20d != null ? r.avg_vol_20d.toLocaleString() : <span style={{ color: "#a8b8cc" }}>—</span>}
                  </td>
                  <td style={{ ...styles.td, fontWeight: 700,
                    color: ratio == null ? "#a8b8cc" : ratio >= 5 ? "#c0182e" : ratio >= 3 ? "#c05a00" : ratio >= 2 ? "#c09000" : "#1a2332" }}>
                    {ratio != null
                      ? <>{ratio.toFixed(1)}× {ratio >= 5 ? "🔥" : ratio >= 3 ? "▲▲" : ratio >= 2 ? "▲" : ""}</>
                      : <span style={{ fontSize: 9, color: "#a8b8cc" }}>building…</span>}
                  </td>
                  <td style={{ ...styles.td, color: (r.vol_oi_ratio ?? 0) >= 50 ? "#c05a00" : "#5a6e85" }}>
                    {r.vol_oi_ratio != null ? `${r.vol_oi_ratio}%` : "—"}
                  </td>
                  <td style={styles.td}>{r.open_interest != null ? (+r.open_interest).toLocaleString() : "—"}</td>
                  <td style={{ ...styles.td, color: "#c05a00" }}>{r.iv_pct != null ? `${r.iv_pct}%` : "—"}</td>
                  <td style={styles.td}>{r.bid != null ? `$${(+r.bid).toFixed(2)}` : "—"}</td>
                  <td style={styles.td}>{r.ask != null ? `$${(+r.ask).toFixed(2)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab 4: Data QC ────────────────────────────────────────────────────────────

function StatusIcon({ severity }) {
  if (severity === "ok")
    return <span title="OK" style={{ fontSize: 16 }}>✅</span>;
  if (severity === "missing")
    return <span title="Missing data" style={{ fontSize: 16 }}>🔴</span>;
  return <span title="Warning" style={{ fontSize: 16 }}>⚠️</span>;
}

function QCTab() {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    fetchDataQC().then((data) => { setRows(data); setLoading(false); });
  }, []);

  const sorted = useMemo(() =>
    [...rows].sort((a, b) => {
      const ord = { missing: 0, warn: 1, info: 2, ok: 3 };
      return (ord[a.severity] ?? 4) - (ord[b.severity] ?? 4);
    }), [rows]
  );

  if (loading) return <div style={styles.loading}>Running QC checks…</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 12, fontSize: 11, color: "#5a6e85" }}>
        One row per ticker · click a row to see gap and parity details
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #1a2332" }}>
            {["Ticker", "Rows", "Expiries", "Staleness", "IV Violations", "Strike Gaps", "Parity Violations", "Status"].map((h) => (
              <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontWeight: 700, fontSize: 12, color: "#1a2332", whiteSpace: "nowrap" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const isExp = expanded === row.symbol;
            // Count each check
            const ivViolations   = row.issues.find((i) => i.code === "bad_iv")    ? parseInt(row.issues.find((i) => i.code === "bad_iv").label)    : 0;
            const strikeGaps     = row.totalGaps ?? 0;
            const parityViol     = row.parityViolations ?? 0;
            const staleLabel     = row.dayStale != null
              ? row.dayStale === 0 ? "< 1d ago"
              : row.dayStale === 1 ? "1d ago"
              : `${row.dayStale}d ago`
              : "—";
            const isStale        = (row.dayStale ?? 0) > 1;

            return (
              <React.Fragment key={row.symbol}>
                <tr
                  onClick={() => setExpanded(isExp ? null : row.symbol)}
                  style={{
                    borderBottom: isExp ? "none" : "1px solid #e8ecf0",
                    cursor: "pointer",
                    background: isExp ? "#f8fafc" : "#fff",
                  }}
                  onMouseEnter={(e) => { if (!isExp) e.currentTarget.style.background = "#f8fafc"; }}
                  onMouseLeave={(e) => { if (!isExp) e.currentTarget.style.background = "#fff"; }}
                >
                  <td style={{ padding: "9px 14px", fontWeight: 700, fontSize: 13, color: "#1a2332" }}>
                    {row.symbol}
                  </td>
                  <td style={{ padding: "9px 14px", color: row.rowCount < 100 ? "#c0182e" : "#1a2332", fontWeight: row.rowCount < 100 ? 700 : 400 }}>
                    {row.rowCount.toLocaleString()}
                  </td>
                  <td style={{ padding: "9px 14px", color: "#1a2332" }}>
                    {row.expiries}
                  </td>
                  <td style={{ padding: "9px 14px", color: isStale ? "#c05a00" : "#1a2332", fontWeight: isStale ? 700 : 400 }}>
                    {staleLabel}
                  </td>
                  <td style={{ padding: "9px 14px", color: ivViolations > 0 ? "#c05a00" : "#1a2332" }}>
                    {ivViolations}
                  </td>
                  <td style={{ padding: "9px 14px", color: strikeGaps > 0 ? "#c05a00" : "#1a2332" }}>
                    {strikeGaps}
                  </td>
                  <td style={{ padding: "9px 14px", color: parityViol > 0 ? "#c05a00" : "#1a2332" }}>
                    {parityViol}
                  </td>
                  <td style={{ padding: "9px 14px" }}>
                    <StatusIcon severity={row.severity} />
                  </td>
                </tr>

                {/* Expanded detail row */}
                {isExp && (
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e8ecf0" }}>
                    <td colSpan={8} style={{ padding: "10px 20px 14px" }}>
                      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", fontSize: 11 }}>
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 4, color: "#1a2332" }}>
                            Missing Strikes
                          </div>
                          {Object.keys(row.gapsByExpiry ?? {}).length === 0
                            ? <span style={{ color: "#006b44" }}>None detected</span>
                            : Object.entries(row.gapsByExpiry).slice(0, 4).map(([exp, gaps]) => (
                              <div key={exp} style={{ marginBottom: 3 }}>
                                <span style={{ fontWeight: 600, color: "#5a6e85" }}>{exp}: </span>
                                {gaps.map((g) => (
                                  <span key={g.from} style={{ marginRight: 8, color: "#c05a00" }}>
                                    {g.from}→{g.to} (missing {g.missing.join(", ")})
                                  </span>
                                ))}
                              </div>
                            ))}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 4, color: "#1a2332" }}>
                            Put/Call Parity
                          </div>
                          {parityViol === 0
                            ? <span style={{ color: "#006b44" }}>No violations (&gt;$0.50)</span>
                            : <span style={{ color: "#c05a00" }}>
                                {parityViol} violation{parityViol > 1 ? "s" : ""} &gt; $0.50 threshold
                              </span>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 4, color: "#1a2332" }}>Data</div>
                          <div style={{ color: "#5a6e85" }}>
                            Chain date: {row.chainDate ?? "—"} &nbsp;·&nbsp;
                            {row.strikesPerExpiry > 0 ? `~${row.strikesPerExpiry} strikes/expiry` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

const TABS = [
  { id: "universe",  label: "Universe Screener" },
  { id: "charts",    label: "Chart Grid" },
  { id: "anomalies", label: "Volume Anomalies" },
  { id: "qc",        label: "Data QC" },
];

export default function ScreenerDashboard({ onBack, onLoadTicker }) {
  const [activeTab, setActiveTab] = useState("universe");
  const [tickers, setTickers]     = useState([]);
  const [asOfDate, setAsOfDate]   = useState(null);

  useEffect(() => {
    fetchUniverseData().then(({ rows, asOfDate }) => {
      setTickers(rows.map((r) => ({ symbol: r.symbol, sector: r.sector })));
      setAsOfDate(asOfDate);
    });
  }, []);

  const handleLoad = useCallback((tickerData) => {
    if (onLoadTicker) onLoadTicker(tickerData);
  }, [onLoadTicker]);

  return (
    <div style={{ minHeight: "100vh", background: "#f0f4f8", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ background: "#1a2332", borderBottom: "1px solid #2a3548", padding: "10px 20px", display: "flex", alignItems: "center", gap: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "1px solid #3a4a60", color: "#a8b8cc", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>
          ← Options Model
        </button>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#ffffff", letterSpacing: "0.05em" }}>VOL SCREENER</div>
        <div style={{ fontSize: 9, color: "#4a9eff", letterSpacing: "0.1em" }}>{asOfDate ? `DATA: ${asOfDate}` : "LOADING…"}</div>
        <div style={{ marginLeft: "auto", fontSize: 9, color: "#3a4a60" }}>{tickers.length} active tickers</div>
      </div>
      <div style={{ background: "#fff", borderBottom: "1px solid #dde3eb", padding: "0 20px", display: "flex", gap: 0 }}>
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: "10px 18px", fontSize: 11, fontWeight: 600, cursor: "pointer",
            border: "none", borderBottom: activeTab === tab.id ? "2px solid #0055a5" : "2px solid transparent",
            background: "none", color: activeTab === tab.id ? "#0055a5" : "#5a6e85",
          }}>
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ padding: "16px 20px" }}>
        {activeTab === "universe"  && <UniverseTab asOfDate={asOfDate} onLoadTicker={handleLoad} />}
        {activeTab === "charts"    && <ChartsTab tickers={tickers} onLoadTicker={handleLoad} />}
        {activeTab === "anomalies" && <AnomaliesTab />}
        {activeTab === "qc"        && <QCTab />}
      </div>
    </div>
  );
}

const styles = {
  th: { padding: "6px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "#5a6e85", letterSpacing: "0.08em", borderBottom: "2px solid #dde3eb", whiteSpace: "nowrap" },
  td: { padding: "5px 10px", fontSize: 11, color: "#1a2332", whiteSpace: "nowrap" },
  loading: { padding: 40, textAlign: "center", color: "#a8b8cc", fontSize: 12 },
  chartEmpty: { height: 150, display: "flex", alignItems: "center", justifyContent: "center", color: "#a8b8cc", fontSize: 10, fontStyle: "italic" },
};
