// Spike page: footprint on Lightweight Charts with real history, live trades, a delta pane,
// and a stress mode. Open /spike-footprint.html, add ?stress or ?symbol=ETHUSDT.

import { createChart, CrosshairMode, HistogramSeries, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { drawStats, FootprintSeries, type FootprintBar } from './footprintSeries';

const params = new URLSearchParams(location.search);
const symbol = (params.get('symbol') || 'BTCUSDT').toUpperCase();
const stress = params.has('stress');
const MINUTE = 60_000;

interface Accumulator {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  levels: Map<number, { bid: number; ask: number }>;
}

function autoTick(price: number): number {
  const target = price * 0.00015;
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].find((m) => m * power >= target)! * power;
  return Number(step.toPrecision(1));
}

class BarBuilder {
  readonly bars = new Map<number, Accumulator>();
  constructor(readonly tick: number) {}

  add(time: number, price: number, size: number, side: 'buy' | 'sell'): number {
    const start = Math.floor(time / MINUTE) * MINUTE;
    let bar = this.bars.get(start);
    if (!bar) {
      bar = { start, open: price, high: price, low: price, close: price, volume: 0, delta: 0, levels: new Map() };
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

  sorted(): number[] {
    return [...this.bars.keys()].sort((a, b) => a - b);
  }
}

const chartEl = document.getElementById('chart')!;
const statsEl = document.getElementById('stats')!;
const legendEl = document.getElementById('legend')!;

const chart = createChart(chartEl, {
  autoSize: true,
  layout: {
    background: { color: '#0e1116' },
    textColor: '#949ca6',
    fontFamily: '"Geist Mono", ui-monospace, monospace',
    fontSize: 11,
    panes: { separatorColor: '#2b2e32', separatorHoverColor: '#3a3f46', enableResize: true },
  },
  grid: { vertLines: { color: '#1d2127' }, horzLines: { color: '#1d2127' } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#949ca6', labelBackgroundColor: '#1d222a' }, horzLine: { color: '#949ca6', labelBackgroundColor: '#1d222a' } },
  rightPriceScale: { borderColor: '#2b2e32' },
  timeScale: { borderColor: '#2b2e32', timeVisible: true, secondsVisible: false, barSpacing: 96, minBarSpacing: 4, rightOffset: 2 },
});

// Exposed for the benchmark script only
(window as any).__chart = chart;
(window as any).__drawStats = drawStats;

let footprint: ISeriesApi<'Custom', any, any, any, any>;
let delta: ISeriesApi<'Histogram'>;
let updates = 0;
let trades = 0;

function setupSeries(tick: number, decimals: number) {
  footprint = chart.addCustomSeries(new FootprintSeries(), {
    tickSize: tick,
    imbalanceRatio: 3,
    priceFormat: { type: 'price', precision: decimals, minMove: tick },
    lastValueVisible: true,
    priceLineVisible: true,
    priceLineColor: '#36cf8f',
  });
  delta = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1);
  chart.panes()[1]?.setHeight(120);
}

const deltaPoint = (b: FootprintBar) => ({ time: b.time, value: b.delta, color: b.delta >= 0 ? 'rgba(54,207,143,0.6)' : 'rgba(250,111,95,0.6)' });

chart.subscribeCrosshairMove((param) => {
  const bar = param.seriesData.get(footprint) as FootprintBar | undefined;
  if (!bar || bar.close === undefined) {
    legendEl.textContent = `${symbol} · footprint spike`;
    return;
  }
  const levels = bar.levels.length;
  legendEl.textContent = `${symbol}  O ${bar.open}  H ${bar.high}  L ${bar.low}  C ${bar.close}  Vol ${bar.volume.toFixed(2)}  Δ ${bar.delta >= 0 ? '+' : ''}${bar.delta.toFixed(2)}  ${levels} rows`;
});

let frames = 0;
const countFrames = () => {
  frames++;
  requestAnimationFrame(countFrames);
};
requestAnimationFrame(countFrames);

let lastReport = performance.now();
setInterval(() => {
  const now = performance.now();
  const seconds = (now - lastReport) / 1000;
  const avg = drawStats.frames ? drawStats.totalMs / drawStats.frames : 0;
  const range = chart.timeScale().getVisibleLogicalRange();
  const visibleBars = range ? Math.round(range.to - range.from) : 0;
  const summary = {
    mode: stress ? 'stress' : 'live',
    fps: Math.round(frames / seconds),
    draws: drawStats.frames,
    drawAvgMs: +avg.toFixed(2),
    drawMaxMs: +drawStats.maxMs.toFixed(2),
    cells: drawStats.lastCells,
    updatesPerSec: Math.round(updates / seconds),
    tradesPerSec: Math.round(trades / seconds),
    visibleBars,
  };
  (window as any).__spike = summary;
  statsEl.textContent = Object.entries(summary).map(([k, v]) => `${k} ${v}`).join('   ');
  frames = 0;
  updates = 0;
  trades = 0;
  lastReport = now;
  drawStats.reset();
}, 1000);

async function runLive() {
  const response = await fetch(`/api/mfp/history?symbol=${symbol}&minutes=30`);
  if (!response.ok) throw new Error(`History HTTP ${response.status}`);
  const history: { trades: [number, number, number, number, 1 | -1][] } = await response.json();
  const firstPrice = history.trades[0]?.[2] ?? 1;
  const tick = autoTick(firstPrice);
  const decimals = Math.max(0, -Math.floor(Math.log10(tick)));
  const builder = new BarBuilder(tick);
  const seen = new Set<string>();
  for (const [id, time, price, size, side] of history.trades) {
    seen.add(String(id));
    builder.add(time, price, size, side === 1 ? 'buy' : 'sell');
  }
  setupSeries(tick, decimals);
  const bars = builder.sorted().map((s) => builder.toBar(s));
  footprint.setData(bars);
  delta.setData(bars.map(deltaPoint));

  const dirty = new Set<number>();
  const ws = new WebSocket('ws://localhost:3001');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', symbol }));
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== 'trade' || msg.data.isLiquidation || msg.data.symbol !== symbol) return;
    if (seen.has(msg.data.id)) return;
    seen.add(msg.data.id);
    trades++;
    dirty.add(builder.add(msg.data.timestamp, msg.data.price, msg.data.volume, msg.data.side));
  };
  setInterval(() => {
    for (const start of [...dirty].sort((a, b) => a - b)) {
      const bar = builder.toBar(start);
      footprint.update(bar);
      delta.update(deltaPoint(bar));
      updates++;
    }
    dirty.clear();
  }, 100);
}

function runStress() {
  const tick = 10;
  setupSeries(tick, 0);
  const builder = new BarBuilder(tick);
  let price = 60_000;
  let time = Date.now() - 600 * MINUTE;
  const random = (() => {
    let seed = 42;
    return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  })();
  const trade = () => {
    price += (random() - 0.5) * 12;
    time += 60;
    return builder.add(time, price, random() * 2, random() > 0.5 ? 'buy' : 'sell');
  };
  // About 600 one-minute bars, roughly 1,000 trades each
  for (let i = 0; i < 600_000; i++) trade();
  const bars = builder.sorted().map((s) => builder.toBar(s));
  footprint.setData(bars);
  delta.setData(bars.map(deltaPoint));
  setInterval(() => {
    let start = 0;
    for (let i = 0; i < 50; i++) start = trade();
    trades += 50;
    const bar = builder.toBar(start);
    footprint.update(bar);
    delta.update(deltaPoint(bar));
    updates++;
  }, 50);
}

(stress ? Promise.resolve(runStress()) : runLive()).catch((error) => {
  statsEl.textContent = `Error: ${error.message}`;
});
