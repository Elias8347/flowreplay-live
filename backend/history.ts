// Rebuilds recent perpetual trades from Binance's public aggregate trade history.
// MFP passes these aggregate trade IDs through unchanged, so history and live trades can be joined exactly.

const AGG_TRADES_URL = 'https://fapi.binance.com/fapi/v1/aggTrades';
const PAGE_SIZE = 1000;
// At most half the per-minute budget per load, so switching markets right after still works
const MAX_PAGES = 15;
const PAGE_DELAY_MS = 50;
const MAX_WINDOW_MS = 60 * 60_000;
const MAX_CACHED_SYMBOLS = 6;
const MAX_TOP_UP_AGE_MS = 5 * 60_000;

/** [aggregate trade ID, time ms, price, size, aggressor: 1 buy or -1 sell] */
export type TapeRow = [number, number, number, number, 1 | -1];

export interface TapeResult {
  symbol: string;
  source: 'binance-perpetual';
  quality: 'rebuilt';
  from: number;
  to: number;
  complete: boolean;
  trades: TapeRow[];
}

interface CacheEntry {
  rows: TapeRow[];
  coveredFrom: number;
}

interface AggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

class UpstreamLimitError extends Error {}

const cache = new Map<string, CacheEntry>();
const queues = new Map<string, Promise<unknown>>();
let cooldownUntil = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function toRow(t: AggTrade): TapeRow {
  return [t.a, t.T, Number(t.p), Number(t.q), t.m ? -1 : 1];
}

/** Index of the first row at or after a time. Rows must be in ascending order. */
export function firstIndexAtOrAfter(rows: TapeRow[], time: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid][1] < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Binance allows 2,400 request weight per minute per IP, and each trade page costs 20.
// Stay well under that so busy markets return partial history instead of getting the IP blocked.
const PAGES_PER_MINUTE = 30;
const BACK_OFF_ABOVE_WEIGHT = 1500;
const pageTimes: number[] = [];

function takePageBudget() {
  const now = Date.now();
  while (pageTimes.length && pageTimes[0] < now - 60_000) pageTimes.shift();
  if (pageTimes.length >= PAGES_PER_MINUTE) throw new UpstreamLimitError('Local Binance request budget used up for this minute');
  pageTimes.push(now);
}

async function fetchPage(symbol: string, fromId?: number): Promise<AggTrade[]> {
  if (Date.now() < cooldownUntil) throw new UpstreamLimitError('Binance rate limit cooldown');
  takePageBudget();
  const url = new URL(AGG_TRADES_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (fromId !== undefined) url.searchParams.set('fromId', String(fromId));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (response.status === 429 || response.status === 418) {
    const retryAfter = Number(response.headers.get('retry-after')) || 30;
    cooldownUntil = Date.now() + retryAfter * 1000;
    throw new UpstreamLimitError(`Binance rate limit, retry in ${retryAfter}s`);
  }
  if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}`);
  // Back off for the rest of the minute when the IP's shared weight is getting high
  const usedWeight = Number(response.headers.get('x-mbx-used-weight-1m'));
  if (usedWeight > BACK_OFF_ABOVE_WEIGHT) cooldownUntil = Math.ceil(Date.now() / 60_000) * 60_000;
  const page = await response.json();
  if (!Array.isArray(page)) throw new Error('Unexpected response from Binance');
  return page;
}

/**
 * Walks backward by trade ID so that a capped result always keeps the newest trades.
 * With `beforeId`, it extends an existing cache further back instead of starting from now.
 */
async function rebuild(symbol: string, cutoff: number, beforeId: number | null = null): Promise<CacheEntry & { complete: boolean }> {
  const pages: TapeRow[][] = [];
  let firstId: number | null = beforeId;
  let reachedCutoff = false;

  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const fromId: number | undefined = firstId === null ? undefined : Math.max(0, firstId - PAGE_SIZE);
      const raw = await fetchPage(symbol, fromId);
      const page: TapeRow[] = (firstId === null ? raw : raw.filter((t) => t.a < firstId!)).map(toRow);
      if (page.length === 0) {
        reachedCutoff = true;
        break;
      }
      pages.unshift(page);
      firstId = page[0][0];
      if (page[0][1] <= cutoff || firstId === 0) {
        reachedCutoff = true;
        break;
      }
      await sleep(PAGE_DELAY_MS);
    }
  } catch (error) {
    if (pages.length === 0) throw error;
    console.warn(`[History] Partial rebuild for ${symbol}: ${(error as Error).message}`);
  }

  const rows = pages.flat();
  const start = firstIndexAtOrAfter(rows, cutoff);
  const kept = rows.slice(start);
  return {
    rows: kept,
    coveredFrom: reachedCutoff ? cutoff : kept[0]?.[1] ?? Date.now(),
    complete: reachedCutoff,
  };
}

/** Adds trades newer than the cache. Returns false if it could not fully catch up. */
async function topUp(symbol: string, entry: CacheEntry): Promise<boolean> {
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const lastId: number = entry.rows[entry.rows.length - 1][0];
      const page = await fetchPage(symbol, lastId + 1);
      for (const trade of page) entry.rows.push(toRow(trade));
      if (page.length < PAGE_SIZE) return true;
      await sleep(PAGE_DELAY_MS);
    }
  } catch (error) {
    console.warn(`[History] Could not update ${symbol}: ${(error as Error).message}`);
  }
  return false;
}

async function loadTape(symbol: string, windowMs: number): Promise<TapeResult> {
  const now = Date.now();
  const cutoff = now - windowMs;
  let entry = cache.get(symbol);
  let complete: boolean;

  const newest = entry?.rows[entry.rows.length - 1]?.[1] ?? 0;
  if (entry && entry.rows.length > 0 && now - newest <= MAX_TOP_UP_AGE_MS) {
    const caughtUp = await topUp(symbol, entry);
    // A partial cache grows further back with each request, as the request budget allows
    if (entry.coveredFrom > cutoff) {
      try {
        const older = await rebuild(symbol, cutoff, entry.rows[0][0]);
        entry.rows = [...older.rows, ...entry.rows];
        entry.coveredFrom = older.complete ? cutoff : older.rows[0]?.[1] ?? entry.coveredFrom;
      } catch (error) {
        console.warn(`[History] Could not extend ${symbol}: ${(error as Error).message}`);
      }
    }
    complete = caughtUp && entry.coveredFrom <= cutoff;
  } else {
    const rebuilt = await rebuild(symbol, cutoff);
    complete = rebuilt.complete;
    entry = { rows: rebuilt.rows, coveredFrom: rebuilt.coveredFrom };
  }

  // Keep the cache bounded, and move this symbol to the most recently used position.
  const keepFrom = now - MAX_WINDOW_MS;
  const trim = firstIndexAtOrAfter(entry.rows, keepFrom);
  if (trim > 0) {
    entry.rows = entry.rows.slice(trim);
    entry.coveredFrom = Math.max(entry.coveredFrom, keepFrom);
  }
  cache.delete(symbol);
  cache.set(symbol, entry);
  while (cache.size > MAX_CACHED_SYMBOLS) cache.delete(cache.keys().next().value as string);

  const trades = entry.rows.slice(firstIndexAtOrAfter(entry.rows, cutoff));
  return {
    symbol,
    source: 'binance-perpetual',
    quality: 'rebuilt',
    from: trades[0]?.[1] ?? cutoff,
    to: trades[trades.length - 1]?.[1] ?? now,
    complete,
    trades,
  };
}

/** Requests for one symbol run in order, so they share the cache instead of refetching it. */
export function getTapeHistory(symbol: string, minutes: number): Promise<TapeResult> {
  const windowMs = Math.min(minutes * 60_000, MAX_WINDOW_MS);
  const previous = queues.get(symbol) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => loadTape(symbol, windowMs));
  queues.set(symbol, next);
  const clear = () => {
    if (queues.get(symbol) === next) queues.delete(symbol);
  };
  next.then(clear, clear);
  return next;
}

export function isHistoryRateLimit(error: unknown): boolean {
  return error instanceof UpstreamLimitError;
}

/** Seconds until history requests can succeed again. */
export function historyRetryAfterSeconds(): number {
  const now = Date.now();
  if (now < cooldownUntil) return Math.ceil((cooldownUntil - now) / 1000);
  while (pageTimes.length && pageTimes[0] < now - 60_000) pageTimes.shift();
  if (pageTimes.length >= PAGES_PER_MINUTE) return Math.ceil((pageTimes[0] + 60_000 - now) / 1000) + 1;
  return 1;
}
