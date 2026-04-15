const MAX_TICKER_LEN = 32;
const MAX_LEGS = 32;

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function sanitizeLeg(raw) {
  if (!isPlainObject(raw)) return null;
  const type = raw.type === "put" || raw.type === "call" ? raw.type : null;
  const dir = raw.dir === "long" || raw.dir === "short" ? raw.dir : null;
  if (!type || !dir) return null;
  const qty = Number(raw.qty);
  const strikePct = Number(raw.strikePct);
  if (!Number.isFinite(qty) || !Number.isFinite(strikePct)) return null;
  const id = Number.isFinite(Number(raw.id)) ? Number(raw.id) : undefined;
  return {
    ...raw,
    id: id ?? 0,
    type,
    dir,
    qty: Math.max(1, Math.min(1000, Math.round(qty))),
    strikePct: Math.max(1, Math.min(500, strikePct)),
    iv: raw.iv != null && Number.isFinite(+raw.iv) ? +raw.iv : 25,
    bidPrice: raw.bidPrice != null && Number.isFinite(+raw.bidPrice) ? +raw.bidPrice : null,
    askPrice: raw.askPrice != null && Number.isFinite(+raw.askPrice) ? +raw.askPrice : null,
  };
}

/**
 * Normalise a saved watchlist entry from cloud or localStorage.
 * @returns {object | null}
 */
export function normalizeWatchlistSnapshot(raw) {
  if (!isPlainObject(raw)) return null;
  const ticker =
    typeof raw.ticker === "string" && raw.ticker.trim()
      ? raw.ticker.trim().slice(0, MAX_TICKER_LEN)
      : null;
  if (!ticker) return null;

  const spot = Number(raw.spot);
  const safeSpot = Number.isFinite(spot) && spot > 0 && spot < 1e8 ? spot : 100;

  let legs = [];
  if (Array.isArray(raw.legs)) {
    legs = raw.legs.map(sanitizeLeg).filter(Boolean).slice(0, MAX_LEGS);
  }

  return {
    ticker,
    spot: safeSpot,
    expiryDate: typeof raw.expiryDate === "string" ? raw.expiryDate : "",
    legs,
    strategy: typeof raw.strategy === "string" ? raw.strategy : "Custom",
    rv20: Number.isFinite(+raw.rv20) ? +raw.rv20 : 0,
    rv60: Number.isFinite(+raw.rv60) ? +raw.rv60 : 0,
    rv1y: Number.isFinite(+raw.rv1y) ? +raw.rv1y : 0,
    iv1yPct: Number.isFinite(+raw.iv1yPct) ? +raw.iv1yPct : 0,
    margin: Number.isFinite(+raw.margin) ? Math.max(1, Math.min(100, +raw.margin)) : 20,
    surfaceEnabled: Boolean(raw.surfaceEnabled),
    surfacePoints: Array.isArray(raw.surfacePoints) ? raw.surfacePoints : [],
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : undefined,
  };
}

/**
 * Payload from Screener → Options Model (symbol, spot, surfacePoints, rv20, …).
 * @returns {object | null}
 */
export function normalizeLoadedTickerForModel(raw) {
  if (!isPlainObject(raw)) return null;
  const symbol =
    typeof raw.symbol === "string" && raw.symbol.trim()
      ? raw.symbol.trim().slice(0, MAX_TICKER_LEN).toUpperCase()
      : null;
  if (!symbol) return null;

  const spot = Number(raw.spot);
  const surfacePoints = Array.isArray(raw.surfacePoints) ? raw.surfacePoints : [];

  return {
    symbol,
    spot: Number.isFinite(spot) && spot > 0 && spot < 1e8 ? spot : null,
    surfacePoints,
    rv20: raw.rv20 != null && Number.isFinite(+raw.rv20) ? +raw.rv20 : null,
    atm_iv_30d: raw.atm_iv_30d != null && Number.isFinite(+raw.atm_iv_30d) ? +raw.atm_iv_30d : null,
  };
}
