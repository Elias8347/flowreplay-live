import { useEffect, useState } from 'react';
import { Camera, ChevronDown, Maximize, Minimize2, PanelBottom, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMfpLeverage, useMfpSymbols } from '@/hooks/useMfpSymbols';
import { getCurrentTicker } from '@/services/dataBuffer';
import { cn } from '@/lib/utils';
import { takeChartSnapshot } from '@/chart/chartRegistry';
import { IconButton } from './IconButton';
import type { LayoutPreset } from './useShellLayout';

interface Derivatives {
  openInterestUsd: number | null;
  fundingRate: number | null;
}

const compactUsd = (n: number) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};

function priceDecimals(price: number) {
  if (price >= 1000) return 1;
  if (price >= 1) return 2;
  return 5;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'buy' | 'sell' }) {
  return (
    <div className="flex flex-col justify-center gap-0.5">
      <span className="text-[11px] leading-none text-muted-foreground">{label}</span>
      <span className={cn('font-mono text-[13px] leading-none font-medium tabular-nums', tone === 'buy' && 'text-buy', tone === 'sell' && 'text-sell')}>{value}</span>
    </div>
  );
}

function useDerivatives(symbol: string | null): Derivatives {
  const [data, setData] = useState<Derivatives>({ openInterestUsd: null, fundingRate: null });
  useEffect(() => {
    if (!symbol) return;
    let active = true;
    const load = async () => {
      try {
        const [oi, premium] = await Promise.all([
          fetch(`/api/binance/openInterest?symbol=${symbol}`).then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/binance/premiumIndex?symbol=${symbol}`).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!active) return;
        const mark = Number(premium?.markPrice);
        const openInterest = Number(oi?.openInterest) * mark;
        const funding = Number(premium?.lastFundingRate);
        // Keep the previous values when a refresh is rate limited or incomplete
        setData((previous) => ({
          openInterestUsd: Number.isFinite(openInterest) ? openInterest : previous.openInterestUsd,
          fundingRate: Number.isFinite(funding) ? funding : previous.fundingRate,
        }));
      } catch {
        // Leave the last values in place on a failed refresh
      }
    };
    setData({ openInterestUsd: null, fundingRate: null });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [symbol]);
  return data;
}

interface MarketHeaderProps {
  symbol: string | null;
  onSymbolChange: (symbol: string) => void;
  preset: LayoutPreset;
  narrow: boolean;
  onPresetChange: (preset: LayoutPreset) => void;
}

export function MarketHeader({ symbol, onSymbolChange, preset, narrow, onPresetChange }: MarketHeaderProps) {
  const symbols = useMfpSymbols();
  const leverage = useMfpLeverage(symbol);
  const derivatives = useDerivatives(symbol);
  const [ticker, setTicker] = useState(() => (symbol ? getCurrentTicker(symbol) : null));
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    if (!symbol) return;
    setTicker(getCurrentTicker(symbol));
    const timer = setInterval(() => setTicker(getCurrentTicker(symbol)), 1000);
    return () => clearInterval(timer);
  }, [symbol]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  const change = ticker?.priceChangePercent ?? null;
  const decimals = ticker ? priceDecimals(ticker.lastPrice) : 2;
  const compact = preset === 'compact';

  return (
    <div className="flex h-12 items-center gap-4 border-b border-line bg-surface-panel px-4" style={{ gridArea: 'hdr' }}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-2 text-base font-semibold hover:bg-surface-hover">
            {symbol ? symbol.replace(/USDT$/, '') : 'Select market'}
            <span className="text-xs font-medium text-muted-foreground">PERP</span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 p-0">
          <ScrollArea className="h-80">
            <DropdownMenuRadioGroup value={symbol ?? ''} onValueChange={onSymbolChange} className="p-1">
              {symbols.map((s) => (
                <DropdownMenuRadioItem key={s} value={s} className="font-mono text-xs">
                  {s.replace(/USDT$/, '')}
                  <span className="ml-auto text-muted-foreground">USDT</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>

      {leverage && (
        <span className="rounded-sm bg-[var(--fr-color-market-buy-tint)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground">{leverage}×</span>
      )}

      <div className="flex h-8 items-center gap-4">
        <Stat label="Last" value={ticker ? ticker.lastPrice.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '–'} />
        <Separator orientation="vertical" className="h-6 bg-line" />
        <Stat label="24h change" value={change === null ? '–' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`} tone={change === null ? undefined : change >= 0 ? 'buy' : 'sell'} />
        {!compact && (
          <>
            <Separator orientation="vertical" className="h-6 bg-line" />
            <Stat label="24h volume" value={ticker ? compactUsd(ticker.quoteVolume) : '–'} />
            <Separator orientation="vertical" className="h-6 bg-line" />
            <Stat label="Open interest" value={derivatives.openInterestUsd === null ? '–' : compactUsd(derivatives.openInterestUsd)} />
            <Separator orientation="vertical" className="h-6 bg-line" />
            <Stat label="Funding" value={derivatives.fundingRate === null ? '–' : `${(derivatives.fundingRate * 100).toFixed(4)}%`} />
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        <ToggleGroup type="single" value={preset} onValueChange={(v) => v && onPresetChange(v as LayoutPreset)} className="gap-0.5 rounded-md bg-surface-inset p-0.5">
          {([
            ['scalper', 'Scalper layout', PanelRight],
            ['review', 'Review layout', PanelBottom],
            ['compact', 'Compact layout', Minimize2],
          ] as const).map(([value, label, Icon]) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <ToggleGroupItem
                    value={value}
                    aria-label={label}
                    disabled={narrow && value !== 'compact'}
                    className="size-7 rounded-[5px] text-muted-foreground data-[state=on]:bg-surface-raised data-[state=on]:text-foreground [&_svg]:size-4"
                  >
                    <Icon />
                  </ToggleGroupItem>
                </span>
              </TooltipTrigger>
              <TooltipContent>{narrow && value !== 'compact' ? `${label} needs a wider window` : label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <Separator orientation="vertical" className="mx-1 h-5 bg-line" />
        <IconButton label="Snapshot of the chart" onClick={() => takeChartSnapshot(symbol ?? 'chart')}>
          <Camera />
        </IconButton>
        <IconButton label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}
