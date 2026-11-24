// Main chart: footprint (or candles) with delta and CVD panes.
// Loads in two stages so it appears at once: candles with exact bar delta first (one request),
// then footprint cells from the rebuilt tape. Live trades keep everything current.

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { subscribeToTrades } from '@/services/dataBuffer';
import { RecentTradeIds } from '@/services/tapeHistory';
import { FootprintSeries, type FootprintBar, type FootprintOptions } from './footprintSeries';
import { registerChart } from './chartRegistry';
import type { Trade } from '@/types';

const C = {
  bg: '#0e1116',
  grid: '#1d2127',
  border: '#2b2e32',
  muted: '#949ca6',
  raised: '#1d222a',
  buy: '#36cf8f',
  sell: '#fa6f5f',
  cvd: '#f2a618',
};

const CANDLE_COUNT = 360;

export type ChartStatus =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; cells: 'loading' | 'rebuilt' | 'partial' | 'live-only'; minutes: number };

interface Acc {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  levels: Map<number, { bid: number; ask: number }>;
}

type TapeRow = [number, number, number, number, 1 | -1];
type CandleRow = [number, number, number, number, number, number, number, number];

function autoTick(price: number): number {
  const target = price * 0.00015;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((m) => m * power >= target)! * power;
  return Number(step.toPrecision(1));
}

/** Accumulates trades into footprint bars, one per time bucket. */
class BarBuilder {
  readonly bars = new Map<number, Acc>();
  constructor(readonly tick: number, readonly bucketMs: number) {}

  bucketOf(time: number) {
    return Math.floor(time / this.bucketMs) * this.bucketMs;
  }

  add(time: number, price: number, size: number, side: 'buy' | 'sell'): number {
    const start = this.bucketOf(time);
    let bar = this.bars.get(start);
    if (!bar) {
      bar = { open: price, high: price, low: price, close: price, volume: 0, delta: 0, levels: new Map() };
      this.bars.set(start, bar);
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += size;
    bar.delta += side === 'buy' ? size : -size;
    const key = Math.round(Math.floor(price / this.tick + 1e-9) * this.tick * 1e8) / 1e8;
    const level = bar.levels.get(key) ?? { bid: 0, ask: 0 };
    if (side === 'buy') level.ask += size;
    else level.bid += size;
    bar.levels.set(key, level);
    return start;
  }

  toBar(start: number): FootprintBar {
    const a = this.bars.get(start)!;
    const levels = [...a.levels.entries()].map(([price, v]) => ({ price, bid: v.bid, ask: v.ask })).sort((x, y) => x.price - y.price);
    const poc = levels.reduce((best, l) => (l.bid + l.ask > best.bid + best.ask ? l : best), levels[0]).price;
    return { time: (start / 1000) as UTCTimestamp, open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume, delta: a.delta, poc, levels };
  }
}

const candleToBar = (r: CandleRow): FootprintBar => ({
  time: (r[0] / 1000) as UTCTimestamp,
  open: r[1],
  high: r[2],
  low: r[3],
  close: r[4],
  volume: r[5],
  delta: r[6],
  poc: Number.NaN,
  levels: [],
});

const deltaPoint = (b: FootprintBar) => ({ time: b.time, value: b.delta, color: b.delta >= 0 ? 'rgba(54,207,143,0.6)' : 'rgba(250,111,95,0.6)' });
const ohlc = (b: FootprintBar) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });

interface ChartAreaProps {
  symbol: string;
  timeframe: '1m' | '3m' | '5m';
  bucketMs: number;
  historyMinutes: number;
  chartType: 'footprint' | 'candles';
  onStatus?: (status: ChartStatus) => void;
}

export function ChartArea({ symbol, timeframe, bucketMs, historyMinutes, chartType, onStatus }: ChartAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [status, setStatus] = useState<ChartStatus>({ state: 'loading' });
  const [legend, setLegend] = useState<FootprintBar | null>(null);

  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  // Create the chart once
  useEffect(() => {
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      layout: {
        background: { color: C.bg },
        textColor: C.muted,
        fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
        fontSize: 11,
        panes: { separatorColor: C.border, separatorHoverColor: '#3a3f46', enableResize: true },
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: C.muted, labelBackgroundColor: C.raised },
        horzLine: { color: C.muted, labelBackgroundColor: C.raised },
      },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, barSpacing: 96, minBarSpacing: 2, rightOffset: 2 },
    });
    chartRef.current = chart;
    registerChart(chart);
    return () => {
      registerChart(null);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Load and stream the current market and timeframe
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !symbol) return;
    const controller = new AbortController();
    const seen = new RecentTradeIds();
    const held: Trade[] = [];
    const candleBars = new Map<number, FootprintBar>();
    const cvdByStart = new Map<number, number>();
    const dirty = new Set<number>();
    let order: number[] = [];
    let builder: BarBuilder | null = null;
    // Footprint cells are exact from this bucket on: the first full live bucket, then the start of the rebuilt tape
    let exactFrom = Infinity;
    let footprint: ISeriesApi<'Custom', Time, FootprintBar | WhitespaceData<Time>, FootprintOptions> | null = null;
    let candles: ISeriesApi<'Candlestick'> | null = null;
    let delta: ISeriesApi<'Histogram'> | null = null;
    let cvd: ISeriesApi<'Line'> | null = null;

    setStatus({ state: 'loading' });
    setLegend(null);

    const barFor = (start: number): FootprintBar | undefined => {
      const live = builder?.bars.has(start) ? builder : null;
      if (live && (start >= exactFrom || !candleBars.has(start))) return live.toBar(start);
      return candleBars.get(start);
    };

    const addTrade = (t: Trade) => {
      if (!builder || !seen.add(t.id)) return;
      const start = builder.add(t.timestamp, t.price, t.volume, t.side === 'buy' ? 'buy' : 'sell');
      // The bucket a live stream joins mid-way is incomplete, so exact cells start with the next one
      if (exactFrom === Infinity) exactFrom = start + bucketMs;
      dirty.add(start);
    };

    const unsubscribe = subscribeToTrades((trade) => {
      if (trade.symbol !== symbol || trade.isLiquidation) return;
      if (builder) addTrade(trade);
      else held.push(trade);
    });

    const renderAll = () => {
      order = [...new Set([...candleBars.keys(), ...(builder?.bars.keys() ?? [])])].sort((a, b) => a - b);
      const bars = order.map(barFor).filter((b): b is FootprintBar => Boolean(b));
      let running = 0;
      for (const b of bars) {
        running += b.delta;
        cvdByStart.set((b.time as number) * 1000, running);
      }
      footprint?.setData(bars);
      candles?.setData(bars.map(ohlc));
      delta?.setData(bars.map(deltaPoint));
      cvd?.setData(bars.map((b) => ({ time: b.time, value: cvdByStart.get((b.time as number) * 1000)! })));
      setLegend(bars[bars.length - 1] ?? null);
    };

    const flush = setInterval(() => {
      if (!builder || dirty.size === 0 || !footprint) return;
      const starts = [...dirty].sort((a, b) => a - b);
      dirty.clear();
      // The chart can only update its newest bar; a late trade for an older bar needs a full redraw
      const newest = order.length ? order[order.length - 1] : -Infinity;
      if (starts[0] < newest) {
        renderAll();
        return;
      }
      let last: FootprintBar | undefined;
      for (const s of starts) {
        if (!order.includes(s)) order.push(s);
        const bar = barFor(s);
        if (!bar) continue;
        const index = order.indexOf(s);
        const previous = index > 0 ? cvdByStart.get(order[index - 1]) ?? 0 : 0;
        cvdByStart.set(s, previous + bar.delta);
        footprint.update(bar);
        candles?.update(ohlc(bar));
        delta?.update(deltaPoint(bar));
        cvd?.update({ time: bar.time, value: previous + bar.delta });
        last = bar;
      }
      if (last) setLegend(last);
    }, 150);

    (async () => {
      // Stage 1: candles with exact bar delta, so the chart appears immediately
      try {
        const response = await fetch(`/api/mfp/candles?symbol=${symbol}&interval=${timeframe}&limit=${CANDLE_COUNT}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Candles request failed (HTTP ${response.status})`);
        const body: { candles: CandleRow[] } = await response.json();
        if (controller.signal.aborted) return;
        if (body.candles.length === 0) throw new Error('No candles available');
        for (const row of body.candles) candleBars.set(row[0], candleToBar(row));

        const tick = autoTick(body.candles[body.candles.length - 1][4]);
        const decimals = Math.max(0, -Math.floor(Math.log10(tick)));
        const priceFormat = { type: 'price' as const, precision: decimals, minMove: tick };
        footprint = chart.addCustomSeries(new FootprintSeries(), { tickSize: tick, imbalanceRatio: 3, priceFormat, priceLineColor: C.buy, visible: chartType === 'footprint' });
        candles = chart.addSeries(CandlestickSeries, {
          priceFormat,
          upColor: C.buy,
          downColor: C.sell,
          borderUpColor: C.buy,
          borderDownColor: C.sell,
          wickUpColor: C.buy,
          wickDownColor: C.sell,
          visible: chartType === 'candles',
        });
        delta = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1);
        cvd = chart.addSeries(LineSeries, { color: C.cvd, lineWidth: 2, priceFormat: { type: 'volume' }, priceLineVisible: false }, 2);
        chart.panes()[1]?.setHeight(90);
        chart.panes()[2]?.setHeight(90);

        builder = new BarBuilder(tick, bucketMs);
        for (const t of held.splice(0)) addTrade(t);
        renderAll();
        chart.timeScale().scrollToRealTime();
        setStatus({ state: 'ready', cells: 'loading', minutes: historyMinutes });
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({ state: 'error', message: (error as Error).message });
        return;
      }

      // Stage 2: footprint cells from the rebuilt tape. The backend rations Binance requests,
      // so busy markets arrive in parts: ask again about once a minute until the window is full.
      const wait = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      const fetchTape = async () => {
        const url = `/api/mfp/history?symbol=${symbol}&minutes=${historyMinutes}`;
        let response = await fetch(url, { signal: controller.signal });
        if (response.status === 503) {
          await wait(Math.min(Number(response.headers.get('Retry-After')) || 10, 60) * 1000);
          response = await fetch(url, { signal: controller.signal });
        }
        if (!response.ok) throw new Error(`History request failed (HTTP ${response.status})`);
        return (await response.json()) as { trades: TapeRow[]; from: number; to: number; complete: boolean };
      };

      let loadedAny = false;
      for (let round = 0; round < 6; round++) {
        try {
          if (round > 0) await wait(65_000);
          const body = await fetchTape();
          if (controller.signal.aborted || !builder) return;
          for (const [id, time, price, size, side] of body.trades) {
            if (!seen.add(String(id))) continue;
            builder.add(time, price, size, side === 1 ? 'buy' : 'sell');
          }
          if (body.trades.length > 0) {
            const firstFull = Math.ceil(body.trades[0][1] / bucketMs) * bucketMs;
            exactFrom = Math.min(exactFrom, body.complete ? Math.ceil(body.from / bucketMs) * bucketMs : firstFull);
          }
          renderAll();
          loadedAny = true;
          const minutes = Math.max(1, Math.round((body.to - body.from) / 60_000));
          setStatus({ state: 'ready', cells: body.complete ? 'rebuilt' : 'partial', minutes });
          if (body.complete) return;
        } catch {
          if (controller.signal.aborted) return;
          // Candles and live cells keep working; only older footprint cells are missing
          if (!loadedAny) setStatus({ state: 'ready', cells: 'live-only', minutes: 0 });
          if (round > 0) return;
        }
      }
    })();

    return () => {
      controller.abort();
      unsubscribe();
      clearInterval(flush);
      // On unmount the chart itself is removed first, so only clean up while it still exists
      if (chartRef.current !== chart) return;
      for (const s of [footprint, candles, delta, cvd]) if (s) chart.removeSeries(s as unknown as ISeriesApi<SeriesType>);
      // Remove the now-empty panes so the next market starts clean
      while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    };
  }, [symbol, timeframe, bucketMs, historyMinutes]);

  // Switch between footprint and candles without reloading
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const series of chart.panes()[0]?.getSeries() ?? []) {
      const isFootprint = series.seriesType() === 'Custom';
      series.applyOptions({ visible: chartType === 'footprint' ? isFootprint : !isFootprint });
    }
  }, [chartType, status]);

  const qualityLabel =
    status.state === 'loading'
      ? 'Loading…'
      : status.state === 'error'
        ? 'Unavailable'
        : status.cells === 'loading'
          ? 'Candles ready · footprint loading…'
          : status.cells === 'live-only'
            ? 'Footprint from live trades only'
            : `${status.cells === 'rebuilt' ? 'Footprint rebuilt' : 'Footprint partial'} ${status.minutes}m · Live`;

  return (
    <div className="relative min-h-0 bg-surface-inset" style={{ gridArea: 'chart' }}>
      <div ref={containerRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-2 left-3 z-10 flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
        <span className="font-sans text-xs font-semibold text-foreground">{symbol.replace(/USDT$/, '')}-PERP</span>
        {legend && (
          <>
            <span>O <span className="text-foreground">{legend.open}</span></span>
            <span>H <span className="text-foreground">{legend.high}</span></span>
            <span>L <span className="text-foreground">{legend.low}</span></span>
            <span>C <span className="text-foreground">{legend.close}</span></span>
            <span>Vol <span className="text-foreground">{legend.volume.toFixed(2)}</span></span>
            <span>
              Δ <span className={legend.delta >= 0 ? 'text-buy' : 'text-sell'}>{legend.delta >= 0 ? '+' : ''}{legend.delta.toFixed(2)}</span>
            </span>
          </>
        )}
        <span className="rounded-full bg-surface-raised/90 px-2 py-0.5 font-sans text-[11px] text-text-secondary">{qualityLabel}</span>
      </div>
      {status.state !== 'ready' && (
        <div className="absolute inset-0 z-10 grid place-items-center">
          <div className="rounded-lg border border-line bg-surface-panel/95 px-4 py-3 text-center text-sm">
            {status.state === 'loading' ? (
              <div className="font-medium">Loading {symbol.replace(/USDT$/, '')} candles…</div>
            ) : (
              <>
                <div className="font-medium text-warning">{status.message}</div>
                <div className="mt-1 text-xs text-muted-foreground">Retrying when you switch market or timeframe</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
