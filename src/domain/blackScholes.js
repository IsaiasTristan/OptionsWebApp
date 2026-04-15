function erf(x) {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

export function normCDF(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

export function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function bs(S, K, T, r, sigma, type = "call") {
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return {
      price: intrinsic,
      delta: type === "call" ? (S > K ? 1 : 0) : S < K ? -1 : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
      charm: 0,
      vomma: 0,
      rho: 0,
    };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const Nd1 = normCDF(d1),
    Nd2 = normCDF(d2);
  const nd1 = normPDF(d1);

  let price, delta;
  if (type === "call") {
    price = S * Nd1 - K * Math.exp(-r * T) * Nd2;
    delta = Nd1;
  } else {
    price = K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    delta = Nd1 - 1;
  }
  const gamma = nd1 / (S * sigma * Math.sqrt(T));
  const vega = (S * nd1 * Math.sqrt(T)) / 100;
  const theta =
    (-(S * nd1 * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * (type === "call" ? Nd2 : 1 - Nd2)) / 365;
  const rho =
    type === "call" ? (K * T * Math.exp(-r * T) * Nd2) / 100 : (-K * T * Math.exp(-r * T) * normCDF(-d2)) / 100;
  const charm =
    type === "call"
      ? (-nd1 * (2 * r * T - d2 * sigma * Math.sqrt(T))) / (2 * T * sigma * Math.sqrt(T))
      : (nd1 * (2 * r * T - d2 * sigma * Math.sqrt(T))) / (2 * T * sigma * Math.sqrt(T));
  const vomma = vega * ((d1 * d2) / sigma);

  return { price, delta, gamma, vega, theta, rho, charm, vomma, d1, d2, Nd1, Nd2 };
}

export function computeIV(price, S, K, T, r, type, tol = 0.0001, maxIter = 200) {
  let lo = 0.001,
    hi = 5,
    mid = 0.25;
  for (let i = 0; i < maxIter; i++) {
    const p = bs(S, K, T, r, mid, type).price;
    if (Math.abs(p - price) < tol) return mid;
    if (p < price) lo = mid;
    else hi = mid;
    mid = (lo + hi) / 2;
  }
  return mid;
}
