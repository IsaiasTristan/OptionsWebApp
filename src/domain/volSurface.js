// Fit a quadratic in log-moneyness for a single tenor slice
// returns {a, b, c} such that IV(K) = a + b*m + c*m^2, m = ln(K/S)
export function fitSlice(points, S) {
  if (!points || points.length === 0) return null;
  if (points.length === 1) return { a: points[0].iv, b: 0, c: 0 };

  const ms = points.map((p) => Math.log(p.strike / S));
  const ivs = points.map((p) => p.iv);

  if (points.length === 2) {
    const dm = ms[1] - ms[0];
    const b = dm !== 0 ? (ivs[1] - ivs[0]) / dm : 0;
    const a = ivs[0] - b * ms[0];
    return { a, b, c: 0 };
  }

  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    t0 = 0,
    t1 = 0,
    t2 = 0;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i],
      v = ivs[i];
    s0 += 1;
    s1 += m;
    s2 += m * m;
    s3 += m * m * m;
    s4 += m * m * m * m;
    t0 += v;
    t1 += m * v;
    t2 += m * m * v;
  }
  const M = [
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ];
  const T = [t0, t1, t2];
  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    [T[col], T[maxRow]] = [T[maxRow], T[col]];
    for (let row = col + 1; row < 3; row++) {
      const f = M[col][col] !== 0 ? M[row][col] / M[col][col] : 0;
      for (let k = col; k < 3; k++) M[row][k] -= f * M[col][k];
      T[row] -= f * T[col];
    }
  }
  const c3 = M[2][2] !== 0 ? T[2] / M[2][2] : 0;
  const c2 = M[1][1] !== 0 ? (T[1] - M[1][2] * c3) / M[1][1] : 0;
  const c1 = M[0][0] !== 0 ? (T[0] - M[0][1] * c2 - M[0][2] * c3) / M[0][0] : 0;
  return { a: c1, b: c2, c: c3 };
}

export function surfaceIV(surfacePoints, S, strike, targetDte) {
  if (!surfacePoints || surfacePoints.length === 0) return null;

  const tenorMap = {};
  surfacePoints.forEach((p) => {
    const k = p.dte;
    if (!tenorMap[k]) tenorMap[k] = [];
    tenorMap[k].push(p);
  });
  const tenors = Object.keys(tenorMap)
    .map(Number)
    .sort((a, b) => a - b);
  if (tenors.length === 0) return null;

  const fits = tenors.map((t) => ({ dte: t, fit: fitSlice(tenorMap[t], S) }));

  const m = Math.log(strike / S);
  const evalAt = (fit) => (fit ? Math.max(0.5, fit.a + fit.b * m + fit.c * m * m) : null);

  if (fits.length === 1) return evalAt(fits[0].fit);

  if (targetDte <= tenors[0]) return evalAt(fits[0].fit);
  if (targetDte >= tenors[tenors.length - 1]) return evalAt(fits[fits.length - 1].fit);

  let lo = fits[0],
    hi = fits[1];
  for (let i = 0; i < fits.length - 1; i++) {
    if (fits[i].dte <= targetDte && fits[i + 1].dte >= targetDte) {
      lo = fits[i];
      hi = fits[i + 1];
      break;
    }
  }

  const sqLo = Math.sqrt(lo.dte),
    sqHi = Math.sqrt(hi.dte),
    sqT = Math.sqrt(targetDte);
  const wHi = sqHi > sqLo ? (sqT - sqLo) / (sqHi - sqLo) : 0;
  const wLo = 1 - wHi;
  const ivLo = evalAt(lo.fit),
    ivHi = evalAt(hi.fit);
  if (ivLo == null || ivHi == null) return ivLo ?? ivHi;
  return wLo * ivLo + wHi * ivHi;
}

export function expiryToDte(expiryStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiryStr);
  exp.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((exp - today) / 86400000));
}
