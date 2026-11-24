/**
 * Read-only DOM ladder, laid out like a clean order-flow DOM:
 * @Bid (sold at the bid) · Bid (resting) · Price · Ask (resting) · @Ask (bought at the ask).
 * Traded columns count the live tape since this view opened. Nothing here places orders.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';
import { getCurrentOrderBook, subscribeToTrades } from '../services/dataBuffer';
import type { OrderBook, Trade } from '../types';

interface DOMLadderProps {
  symbol: string;
  className?: string;
  levels?: number;
}

const TICK_OPTIONS = ['auto', '0.01', '0.1', '1', '5', '10', '50', '100'];

function formatSize(size: number): string {
  if (size === 0) return '';
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`;
  if (size >= 1000) return `${(size / 1000).toFixed(2)}K`;
  if (size >= 1) return size.toFixed(2);
  return size.toFixed(4);
}

function autoTick(price: number): number {
  if (price >= 10_000) return 1;
  if (price >= 1000) return 0.1;
  if (price >= 10) return 0.01;
  if (price >= 1) return 0.001;
  return 0.00001;
}

const decimalsOf = (tick: number) => Math.max(0, -Math.floor(Math.log10(tick)));

interface Row {
  price: number;
  bid: number;
  ask: number;
  soldAtBid: number;
  boughtAtAsk: number;
}

const DOMRow = memo(function DOMRow({ row, maxBook, maxTraded, isLast, decimals }: { row: Row; maxBook: number; maxTraded: number; isLast: boolean; decimals: number }) {
  const bar = (value: number, max: number) => `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`;
  return (
    <div className={cn('grid h-[22px] grid-cols-[1fr_1fr_76px_1fr_1fr] items-center border-b border-line-subtle text-[11px] tabular-nums', isLast && 'bg-surface-raised')}>
      <div className="relative flex h-full items-center justify-end pr-2 text-sell">
        <span className="absolute inset-y-[3px] right-0 bg-sell/15" style={{ width: bar(row.soldAtBid, maxTraded) }} />
        <span className="relative">{formatSize(row.soldAtBid)}</span>
      </div>
      <div className="relative flex h-full items-center justify-end pr-2 text-text-secondary">
        <span className="absolute inset-y-[3px] right-0 bg-buy/20" style={{ width: bar(row.bid, maxBook) }} />
        <span className="relative">{formatSize(row.bid)}</span>
      </div>
      <div className={cn('h-full border-x border-line-subtle px-1 text-center leading-[22px] font-medium', isLast ? 'text-foreground' : 'text-muted-foreground')}>
        {row.price.toFixed(decimals)}
      </div>
      <div className="relative flex h-full items-center pl-2 text-text-secondary">
        <span className="absolute inset-y-[3px] left-0 bg-sell/20" style={{ width: bar(row.ask, maxBook) }} />
        <span className="relative">{formatSize(row.ask)}</span>
      </div>
      <div className="relative flex h-full items-center pl-2 text-buy">
        <span className="absolute inset-y-[3px] left-0 bg-buy/15" style={{ width: bar(row.boughtAtAsk, maxTraded) }} />
        <span className="relative">{formatSize(row.boughtAtAsk)}</span>
      </div>
    </div>
  );
});

export const DOMLadder = memo(function DOMLadder({ symbol, className, levels = 20 }: DOMLadderProps) {
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [lastPrice, setLastPrice] = useState(0);
  const [tickChoice, setTickChoice] = useState('auto');
  const [tradedVersion, setTradedVersion] = useState(0);
  // Traded volume keyed by price, stored at the finest resolution and grouped when drawn
  const tradedRef = useRef(new Map<number, { sold: number; bought: number }>());

  useEffect(() => {
    tradedRef.current = new Map();
    setOrderBook(null);
    setLastPrice(0);
    const unsubscribe = subscribeToTrades((trade: Trade) => {
      if (trade.symbol !== symbol || trade.isLiquidation) return;
      setLastPrice(trade.price);
      const entry = tradedRef.current.get(trade.price) ?? { sold: 0, bought: 0 };
      if (trade.side === 'buy') entry.bought += trade.volume;
      else entry.sold += trade.volume;
      tradedRef.current.set(trade.price, entry);
    });
    const poll = setInterval(() => {
      const book = getCurrentOrderBook(symbol);
      if (book) setOrderBook(book);
      setTradedVersion((v) => v + 1);
    }, 150);
    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [symbol]);

  const reference = lastPrice || (orderBook ? ((orderBook.bids[0]?.price ?? 0) + (orderBook.asks[0]?.price ?? 0)) / 2 : 0);
  const tick = tickChoice === 'auto' ? autoTick(reference || 1) : Number(tickChoice);
  const decimals = decimalsOf(tick);

  const rows = useMemo<Row[]>(() => {
    if (!orderBook || !reference) return [];
    const group = (price: number) => Math.round(Math.round(price / tick) * tick * 1e8) / 1e8;
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    for (const l of orderBook.bids) bids.set(group(l.price), (bids.get(group(l.price)) ?? 0) + l.size);
    for (const l of orderBook.asks) asks.set(group(l.price), (asks.get(group(l.price)) ?? 0) + l.size);
    const traded = new Map<number, { sold: number; bought: number }>();
    for (const [price, v] of tradedRef.current) {
      const key = group(price);
      const t = traded.get(key) ?? { sold: 0, bought: 0 };
      t.sold += v.sold;
      t.bought += v.bought;
      traded.set(key, t);
    }
    const top = group(reference) + Math.floor(levels / 2) * tick;
    return Array.from({ length: levels }, (_, i) => {
      const price = Math.round((top - i * tick) * 1e8) / 1e8;
      const t = traded.get(price);
      return { price, bid: bids.get(price) ?? 0, ask: asks.get(price) ?? 0, soldAtBid: t?.sold ?? 0, boughtAtAsk: t?.bought ?? 0 };
    });
    // tradedVersion re-runs this as the tape grows
  }, [orderBook, reference, tick, levels, tradedVersion]);

  const maxBook = rows.reduce((m, r) => Math.max(m, r.bid, r.ask), 0);
  const maxTraded = rows.reduce((m, r) => Math.max(m, r.soldAtBid, r.boughtAtAsk), 0);
  const lastRow = reference ? Math.round(Math.round(reference / tick) * tick * 1e8) / 1e8 : null;
  const bidTotal = orderBook?.bids.reduce((s, l) => s + l.size, 0) ?? 0;
  const askTotal = orderBook?.asks.reduce((s, l) => s + l.size, 0) ?? 0;
  const imbalance = bidTotal + askTotal > 0 ? ((bidTotal - askTotal) / (bidTotal + askTotal)) * 100 : 0;

  return (
    <div className={cn('flex h-full flex-col overflow-hidden bg-surface-panel font-mono', className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 font-sans text-[11px] text-muted-foreground">
        <span>Rows</span>
        <select
          value={tickChoice}
          onChange={(e) => setTickChoice(e.target.value)}
          className="h-6 rounded-sm border border-line bg-surface-inset px-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none"
          aria-label="Price row size"
        >
          {TICK_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v === 'auto' ? 'Auto' : v}
            </option>
          ))}
        </select>
        <span className={cn('ml-auto whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono', imbalance > 20 ? 'bg-buy/15 text-buy' : imbalance < -20 ? 'bg-sell/15 text-sell' : 'bg-surface-raised text-text-secondary')}>
          Book {imbalance > 0 ? '+' : ''}
          {imbalance.toFixed(0)}%
        </span>
        <button
          type="button"
          onClick={() => {
            tradedRef.current = new Map();
            setTradedVersion((v) => v + 1);
          }}
          className="grid size-6 place-items-center rounded-sm hover:bg-surface-hover hover:text-foreground"
          title="Reset traded volume"
          aria-label="Reset traded volume"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>

      <div className="grid shrink-0 grid-cols-[1fr_1fr_76px_1fr_1fr] border-b border-line py-1.5 font-sans text-[10.5px] text-muted-foreground">
        <span className="pr-2 text-right" title="Volume sold at the bid">@Bid</span>
        <span className="pr-2 text-right">Bid</span>
        <span className="text-center">Price</span>
        <span className="pl-2">Ask</span>
        <span className="pl-2" title="Volume bought at the ask">@Ask</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length > 0 ? (
          rows.map((row) => <DOMRow key={row.price} row={row} maxBook={maxBook} maxTraded={maxTraded} isLast={row.price === lastRow} decimals={decimals} />)
        ) : (
          <div className="grid h-full place-items-center font-sans text-xs text-muted-foreground">Waiting for the order book…</div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-1.5 font-sans text-[10.5px] text-muted-foreground">
        @Bid and @Ask count the live tape since this view opened. Read-only.
      </div>
    </div>
  );
});
