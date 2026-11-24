// Recent perpetual candles with exact bar delta. Binance klines include taker-buy volume,
// so delta = taker buys - taker sells = 2 * takerBuy - volume. One request covers hours.

const KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const CACHE_MS = 10_000;

export const CANDLE_INTERVALS = ['1m', '3m', '5m'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** [open time ms, open, high, low, close, volume, delta, trades] */
export type CandleRow = [number, number, number, number, number, number, number, number];

const cache = new Map<string, { at: number; rows: Promise<CandleRow[]> }>();

export function toCandleRow(k: unknown[]): CandleRow {
  const volume = Number(k[5]);
  const takerBuy = Number(k[9]);
  return [Number(k[0]), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), volume, 2 * takerBuy - volume, Number(k[8])];
}

async function fetchCandles(symbol: string, interval: CandleInterval, limit: number): Promise<CandleRow[]> {
  const url = new URL(KLINES_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('Unexpected response from Binance');
  return body.map(toCandleRow);
}

/** Cached for a few seconds so several panels and reloads share one request. */
export function getCandles(symbol: string, interval: CandleInterval, limit: number): Promise<CandleRow[]> {
  const key = `${symbol}:${interval}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = fetchCandles(symbol, interval, limit);
  cache.set(key, { at: Date.now(), rows });
  rows.catch(() => cache.delete(key));
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return rows;
}
