/**
 * Centralised numeric policy for chain quality, model surface filters, and QC thresholds.
 */

/** Implied vol from DB as decimal (e.g. 0.25 = 25%) */
export const CHAIN_IV_DECIMAL_MIN = 0.03;
export const CHAIN_IV_DECIMAL_MAX = 3.0;

export const CHAIN_MIN_BID = 0.05;
export const CHAIN_MIN_OPEN_INTEREST = 5;
/** Max (ask − bid) / mid when mid > $0.10 */
export const CHAIN_MAX_SPREAD_RATIO = 0.6;
export const CHAIN_MONEYNESS_LOW = 0.7;
export const CHAIN_MONEYNESS_HIGH = 1.4;

/** QC / sanity: IV as percentage (OptionsModel surface uses %) */
export const QC_IV_PCT_MIN = 5;
export const QC_IV_PCT_MAX = 500;

/** Flat rate used only for rough put–call parity check in QC */
export const QC_PARITY_RISK_FREE = 0.0525;
