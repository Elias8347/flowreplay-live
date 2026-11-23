import { useEffect, useState } from 'react';

const PRIORITY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT'];
const FALLBACK = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

let cached: string[] | null = null;
let pending: Promise<string[]> | null = null;

function rank(symbol: string): number {
  const index = PRIORITY.indexOf(symbol);
  return index === -1 ? PRIORITY.length : index;
}

function loadSymbols(): Promise<string[]> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch('/api/mfp/markets')
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((body: { symbols: string[] }) => {
      if (body.symbols.length === 0) throw new Error('No markets returned');
      cached = [...body.symbols].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      return cached;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** MFP markets with a real trade tape, most-traded names first. */
export function useMfpSymbols(): string[] {
  const [symbols, setSymbols] = useState<string[]>(cached ?? FALLBACK);

  useEffect(() => {
    let active = true;
    loadSymbols()
      .then((loaded) => {
        if (active) setSymbols(loaded);
      })
      .catch((error) => console.warn('[Markets] Could not load MFP markets:', error));
    return () => {
      active = false;
    };
  }, []);

  return symbols;
}
