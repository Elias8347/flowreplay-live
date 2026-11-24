import { useEffect, useState } from 'react';

const PRIORITY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT'];
const FALLBACK = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

interface MarketInfo {
  symbols: string[];
  leverage: Record<string, number>;
}

let cached: MarketInfo | null = null;
let pending: Promise<MarketInfo> | null = null;

function rank(symbol: string): number {
  const index = PRIORITY.indexOf(symbol);
  return index === -1 ? PRIORITY.length : index;
}

function loadMarkets(): Promise<MarketInfo> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch('/api/mfp/markets')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((body: { symbols: string[]; leverage?: Record<string, number> }) => {
      if (body.symbols.length === 0) throw new Error('No markets returned');
      cached = {
        symbols: [...body.symbols].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)),
        leverage: body.leverage ?? {},
      };
      return cached;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

function useMarketInfo(): MarketInfo {
  const [info, setInfo] = useState<MarketInfo>(cached ?? { symbols: FALLBACK, leverage: {} });

  useEffect(() => {
    let active = true;
    loadMarkets()
      .then((loaded) => {
        if (active) setInfo(loaded);
      })
      .catch((error) => console.warn('[Markets] Could not load MFP markets:', error));
    return () => {
      active = false;
    };
  }, []);

  return info;
}

/** MFP markets with a real trade tape, most-traded names first. */
export function useMfpSymbols(): string[] {
  return useMarketInfo().symbols;
}

/** MFP's maximum leverage for a market, if listed. */
export function useMfpLeverage(symbol: string | null): number | null {
  const { leverage } = useMarketInfo();
  return symbol ? leverage[symbol] ?? null : null;
}
