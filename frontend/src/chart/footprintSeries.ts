// Footprint drawn as a Lightweight Charts custom series, so it shares the chart's
// zoom, scroll, crosshair, price scale and panes.

import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from 'lightweight-charts';
import type { BitmapCoordinatesRenderingScope, CanvasRenderingTarget2D } from 'fancy-canvas';

// Approved design tokens (design/tokens/tokens.json v0.1.0)
const COLOR = {
  buy: '#36cf8f',
  sell: '#fa6f5f',
  poc: '#f2a618',
  text: '#eef2f5',
  textStrong: '#ffffff',
};
const FILL_MIN = 0.08;
const FILL_MAX = 0.42;
const CANDLE_GUTTER = 8;

export interface FootprintLevel {
  price: number;
  bid: number;
  ask: number;
}

export interface FootprintBar extends CustomData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  poc: number;
  /** Sorted by price, lowest first */
  levels: FootprintLevel[];
}

export interface FootprintOptions extends CustomSeriesOptions {
  tickSize: number;
  imbalanceRatio: number;
}

export const drawStats = {
  frames: 0,
  totalMs: 0,
  maxMs: 0,
  lastMs: 0,
  lastCells: 0,
  reset() {
    this.frames = 0;
    this.totalMs = 0;
    this.maxMs = 0;
  },
};

function formatVolume(v: number): string {
  if (v === 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

class FootprintRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, FootprintBar> | null = null;
  options: FootprintOptions | null = null;

  draw(target: CanvasRenderingTarget2D, priceToY: PriceToCoordinateConverter): void {
    const start = performance.now();
    target.useBitmapCoordinateSpace((scope) => this.drawBars(scope, priceToY));
    const ms = performance.now() - start;
    drawStats.frames++;
    drawStats.totalMs += ms;
    drawStats.lastMs = ms;
    drawStats.maxMs = Math.max(drawStats.maxMs, ms);
  }

  private drawBars(scope: BitmapCoordinatesRenderingScope, priceToY: PriceToCoordinateConverter): void {
    const { data, options } = this;
    if (!data || !options || !data.visibleRange) return;
    const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope;
    const { from, to } = data.visibleRange;
    const tick = options.tickSize;
    const ratio = options.imbalanceRatio;
    const columnWidth = Math.max(1, data.barSpacing * data.conflationFactor * 0.92);

    let maxVolume = 0;
    let sampleRow = 0;
    for (let i = from; i < to; i++) {
      const bar = data.bars[i]?.originalData;
      if (!bar) continue;
      for (const level of bar.levels) maxVolume = Math.max(maxVolume, level.bid + level.ask);
      if (!sampleRow && bar.levels.length) {
        const top = priceToY(bar.levels[0].price + tick);
        const bottom = priceToY(bar.levels[0].price);
        if (top !== null && bottom !== null) sampleRow = bottom - top;
      }
    }
    if (maxVolume === 0) maxVolume = 1;

    const cellWidth = columnWidth - CANDLE_GUTTER;
    const showText = sampleRow >= 11 && cellWidth >= 52;
    const fontCss = Math.max(8, Math.min(11, sampleRow - 3));
    const regularFont = `500 ${Math.round(fontCss * vr)}px "Geist Mono", ui-monospace, monospace`;
    const boldFont = `700 ${Math.round(fontCss * vr)}px "Geist Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    let cells = 0;

    for (let i = from; i < to; i++) {
      const item = data.bars[i];
      const bar = item?.originalData;
      if (!bar) continue;
      const left = Math.round((item.x - columnWidth / 2) * hr);
      const cellsLeft = left + Math.round(CANDLE_GUTTER * hr);
      const cellsWidth = Math.max(1, Math.round(cellWidth * hr));
      const middle = cellsLeft + cellsWidth / 2;

      for (let j = 0; j < bar.levels.length; j++) {
        const level = bar.levels[j];
        const topY = priceToY(level.price + tick);
        const bottomY = priceToY(level.price);
        if (topY === null || bottomY === null) continue;
        const top = Math.round(topY * vr);
        const height = Math.max(1, Math.round(bottomY * vr) - top - 1);
        const total = level.bid + level.ask;

        ctx.globalAlpha = FILL_MIN + (FILL_MAX - FILL_MIN) * Math.sqrt(total / maxVolume);
        ctx.fillStyle = level.ask >= level.bid ? COLOR.buy : COLOR.sell;
        ctx.fillRect(cellsLeft, top, cellsWidth, height);
        ctx.globalAlpha = 1;
        cells++;

        if (level.price === bar.poc) {
          ctx.strokeStyle = COLOR.poc;
          ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
          ctx.strokeRect(cellsLeft + 0.5, top + 0.5, cellsWidth - 1, height - 1);
        }

        if (showText) {
          // Diagonal imbalances: ask against the bid one row below, bid against the ask one row above
          const below = bar.levels[j - 1];
          const above = bar.levels[j + 1];
          const bidBelow = below && Math.abs(below.price + tick - level.price) < tick / 2 ? below.bid : 0;
          const askAbove = above && Math.abs(above.price - tick - level.price) < tick / 2 ? above.ask : 0;
          const buyImbalance = level.ask > 0 && level.ask >= ratio * Math.max(bidBelow, Number.EPSILON);
          const sellImbalance = level.bid > 0 && level.bid >= ratio * Math.max(askAbove, Number.EPSILON);
          const textY = top + height / 2;

          ctx.textAlign = 'right';
          ctx.font = sellImbalance ? boldFont : regularFont;
          ctx.fillStyle = sellImbalance ? COLOR.sell : COLOR.text;
          ctx.fillText(formatVolume(level.bid), middle - 3 * hr, textY);

          ctx.textAlign = 'left';
          ctx.font = buyImbalance ? boldFont : regularFont;
          ctx.fillStyle = buyImbalance ? COLOR.buy : COLOR.text;
          ctx.fillText(formatVolume(level.ask), middle + 3 * hr, textY);
        }
      }

      const highY = priceToY(bar.high);
      const lowY = priceToY(bar.low);
      const openY = priceToY(bar.open);
      const closeY = priceToY(bar.close);
      if (highY === null || lowY === null || openY === null || closeY === null) continue;
      ctx.fillStyle = bar.close >= bar.open ? COLOR.buy : COLOR.sell;
      const bodyTop = Math.round(Math.min(openY, closeY) * vr);
      const bodyHeight = Math.max(Math.round(2 * vr), Math.round(Math.abs(closeY - openY) * vr));
      const wickTop = Math.round(highY * vr);
      const wickHeight = Math.max(1, Math.round((lowY - highY) * vr));
      const wickWidth = Math.max(1, Math.round(hr));

      if (bar.levels.length === 0) {
        // Bars older than the rebuilt tape have no cells, so draw them as full candles
        const bodyWidth = Math.max(wickWidth, Math.round(Math.min(columnWidth * 0.6, 12) * hr));
        const center = Math.round(item.x * hr);
        ctx.fillRect(center - Math.floor(wickWidth / 2), wickTop, wickWidth, wickHeight);
        ctx.fillRect(center - Math.floor(bodyWidth / 2), bodyTop, bodyWidth, bodyHeight);
        continue;
      }

      // Candle in the left gutter beside the cells
      const wickX = left + Math.round(3 * hr);
      ctx.fillRect(wickX, wickTop, wickWidth, wickHeight);
      ctx.fillRect(wickX - Math.round(2 * hr), bodyTop, Math.round(5 * hr), bodyHeight);
    }
    drawStats.lastCells = cells;
  }
}

export class FootprintSeries implements ICustomSeriesPaneView<Time, FootprintBar, FootprintOptions> {
  private readonly view = new FootprintRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this.view;
  }

  update(data: PaneRendererCustomData<Time, FootprintBar>, options: FootprintOptions): void {
    this.view.data = data;
    this.view.options = options;
  }

  priceValueBuilder(bar: FootprintBar): CustomSeriesPricePlotValues {
    return [bar.low, bar.high, bar.close];
  }

  isWhitespace(data: FootprintBar | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return (data as Partial<FootprintBar>).close === undefined;
  }

  defaultOptions(): FootprintOptions {
    return { ...customSeriesDefaultOptions, tickSize: 10, imbalanceRatio: 3 };
  }

  destroy(): void {
    this.view.data = null;
  }
}
