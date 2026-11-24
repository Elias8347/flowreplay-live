import type { IChartApi } from 'lightweight-charts';

let active: IChartApi | null = null;

export function registerChart(chart: IChartApi | null) {
  active = chart;
}

/** Saves the active chart as a PNG. */
export function takeChartSnapshot(name: string) {
  if (!active) return;
  const canvas = active.takeScreenshot();
  const link = document.createElement('a');
  link.download = `flowreplay-${name.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
