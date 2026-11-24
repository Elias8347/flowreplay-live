import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChartArea, type ChartStatus } from '@/chart/ChartArea';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useMarketStore } from '@/stores/useMarketStore';
import { BottomPanel } from './BottomPanel';
import { ChartToolbar, TIMEFRAMES, type ChartType, type TimeframeId } from './ChartToolbar';
import { DrawingRail } from './DrawingRail';
import { MarketHeader } from './MarketHeader';
import { RightDock } from './RightDock';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useShellLayout } from './useShellLayout';

const SYMBOL_KEY = 'flowreplay.symbol';

function readSymbol(): string {
  try {
    return localStorage.getItem(SYMBOL_KEY) || 'BTCUSDT';
  } catch {
    return 'BTCUSDT';
  }
}

const SHORTCUTS = [
  ['?', 'Open this list'],
  ['Esc', 'Close dialogs and menus'],
];

export function AppShell() {
  const layout = useShellLayout();
  const { isConnected } = useWebSocket();
  const [symbol, setSymbol] = useState(readSymbol);
  const [timeframe, setTimeframe] = useState<TimeframeId>('1m');
  const [chartType, setChartType] = useState<ChartType>('footprint');
  const [chartStatus, setChartStatus] = useState<ChartStatus>({ state: 'loading' });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Keep the store subscribed to exactly the market on screen
  useEffect(() => {
    const store = useMarketStore.getState();
    store.subscribe(symbol, 'crypto');
    store.addTab({ symbol, assetType: 'crypto' });
    store.selectSymbol(symbol);
    try {
      localStorage.setItem(SYMBOL_KEY, symbol);
    } catch {
      // Ignore storage failures
    }
    return () => useMarketStore.getState().unsubscribe(symbol);
  }, [symbol]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '?') setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleStatus = useCallback((status: ChartStatus) => setChartStatus(status), []);
  const tf = TIMEFRAMES.find((t) => t.id === timeframe)!;

  const dataState = !isConnected ? 'offline' : chartStatus.state === 'loading' ? 'loading' : 'live';
  const dataLabel = !isConnected
    ? 'Offline'
    : chartStatus.state === 'loading'
      ? 'Loading'
      : chartStatus.state === 'error'
        ? 'Live · chart unavailable'
        : chartStatus.cells === 'loading'
          ? 'Live · footprint loading'
          : chartStatus.cells === 'live-only'
            ? 'Live · footprint from now'
            : `Live · ${chartStatus.cells === 'rebuilt' ? 'Rebuilt' : 'Partial'} ${chartStatus.minutes}m`;

  const dockWidth = layout.dockOpen ? (window.innerWidth < 1440 ? 300 : 340) : 44;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="grid h-screen w-screen overflow-hidden bg-surface-app text-foreground"
        style={{
          gridTemplateColumns: `44px minmax(0, 1fr) ${dockWidth}px`,
          gridTemplateRows: `52px 48px 36px minmax(0, 1fr) ${layout.bottomOpen ? 260 : 40}px 28px`,
          gridTemplateAreas: `"top top top" "hdr hdr hdr" "rail tool dock" "rail chart dock" "bottom bottom bottom" "status status status"`,
        }}
      >
        <TopBar dataLabel={dataLabel} dataState={dataState} onOpenShortcuts={() => setShortcutsOpen(true)} />
        <MarketHeader symbol={symbol} onSymbolChange={setSymbol} preset={layout.preset} narrow={layout.narrow} onPresetChange={layout.applyPreset} />
        <DrawingRail />
        <ChartToolbar timeframe={timeframe} onTimeframeChange={setTimeframe} chartType={chartType} onChartTypeChange={setChartType} />
        <ChartArea symbol={symbol} timeframe={timeframe} bucketMs={tf.ms} historyMinutes={tf.historyMinutes} chartType={chartType} onStatus={handleStatus} />
        <RightDock symbol={symbol} open={layout.dockOpen} onToggle={layout.toggleDock} />
        <BottomPanel open={layout.bottomOpen} onToggle={layout.toggleBottom} />
        <StatusBar connected={isConnected} onOpenShortcuts={() => setShortcutsOpen(true)} />
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>More shortcuts arrive with drawings and replay.</DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-line text-sm">
            {SHORTCUTS.map(([key, action]) => (
              <div key={key} className="flex items-center justify-between py-2">
                <span className="text-muted-foreground">{action}</span>
                <kbd className="rounded-sm border border-line bg-surface-inset px-1.5 font-mono text-xs">{key}</kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
