/**
 * Interpolated US Treasury-style curve (% per annum). Update as markets move.
 * @param {number} dte calendar days
 * @returns {number} annualised rate in percent (e.g. 4.25)
 */
export function getRiskFreeRate(dte) {
  const curve = [
    [7, 4.3],
    [30, 4.25],
    [60, 4.2],
    [90, 4.15],
    [180, 4.1],
    [365, 4.05],
    [730, 4.0],
  ];
  if (dte <= curve[0][0]) return curve[0][1];
  if (dte >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    if (dte >= curve[i][0] && dte <= curve[i + 1][0]) {
      const t = (dte - curve[i][0]) / (curve[i + 1][0] - curve[i][0]);
      return +(curve[i][1] + t * (curve[i + 1][1] - curve[i][1])).toFixed(3);
    }
  }
  return 4.15;
}
