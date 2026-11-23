import type { Trade } from '../types';

export const HISTORY_MINUTES = 30;

type TapeRow = [number, number, number, number, 1 | -1];

export interface TapeHistory {
  trades: Trade[];
  from: number;
  to: number;
  complete: boolean;
}

export type HistoryStatus =
  | { state: 'loading' }
  | { state: 'ready'; trades: number; minutes: number; complete: boolean }
  | { state: 'unavailable' };

/** Fetches rebuilt perpetual trades through the local backend. */
export async function fetchTapeHistory(symbol: string, signal?: AbortSignal): Promise<TapeHistory> {
  const upper = symbol.toUpperCase();
  const response = await fetch(`/api/mfp/history?symbol=${encodeURIComponent(upper)}&minutes=${HISTORY_MINUTES}`, { signal });
  if (!response.ok) throw new Error(`History request failed with HTTP ${response.status}`);
  const body: { trades: TapeRow[]; from: number; to: number; complete: boolean } = await response.json();
  return {
    from: body.from,
    to: body.to,
    complete: body.complete,
    trades: body.trades.map(([id, timestamp, price, volume, side]) => ({
      id: String(id),
      symbol: upper,
      assetType: 'crypto',
      timestamp,
      price,
      volume,
      side: side === 1 ? 'buy' : 'sell',
      exchange: 'MFP',
    })),
  };
}

/** Remembers recent trade IDs with bounded memory. */
export class RecentTradeIds {
  private current = new Set<string>();
  private previous = new Set<string>();

  constructor(private readonly limit: number = 60_000) {}

  /** Returns true the first time an ID is seen. */
  add(id: string): boolean {
    if (this.current.has(id) || this.previous.has(id)) return false;
    if (this.current.size >= this.limit) {
      this.previous = this.current;
      this.current = new Set();
    }
    this.current.add(id);
    return true;
  }
}

/** Joins history and live trades once each, in time order. Liquidations are already in the tape. */
export function mergeTape(history: Trade[], live: Trade[], seen: RecentTradeIds): Trade[] {
  const merged: Trade[] = [];
  for (const trade of history) if (seen.add(trade.id)) merged.push(trade);
  for (const trade of live) if (!trade.isLiquidation && seen.add(trade.id)) merged.push(trade);
  return merged.sort((a, b) => a.timestamp - b.timestamp || Number(a.id) - Number(b.id));
}
