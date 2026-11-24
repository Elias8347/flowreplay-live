import { useEffect, useState } from 'react';
import { Keyboard, LayoutTemplate } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Round trip to the local backend, refreshed every 10 seconds. */
function useLatency(connected: boolean) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!connected) {
      setMs(null);
      return;
    }
    let active = true;
    const probe = async () => {
      const start = performance.now();
      try {
        const response = await fetch('/api/info', { cache: 'no-store' });
        if (active && response.ok) setMs(Math.round(performance.now() - start));
      } catch {
        if (active) setMs(null);
      }
    };
    probe();
    const timer = setInterval(probe, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connected]);
  return ms;
}

const textButton = 'h-6 gap-1.5 px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground [&_svg]:size-3.5';

export function StatusBar({ connected, onOpenShortcuts }: { connected: boolean; onOpenShortcuts: () => void }) {
  const latency = useLatency(connected);
  return (
    <footer className="flex h-7 items-center gap-3 border-t border-line bg-surface-panel px-2 text-[11px] text-muted-foreground" style={{ gridArea: 'status' }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button variant="ghost" size="xs" disabled className={textButton}>
              <LayoutTemplate />
              Templates
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Coming soon</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="xs" className={textButton} onClick={onOpenShortcuts}>
        <Keyboard />
        Shortcuts
      </Button>

      <span className="mx-auto">Binance perpetual tape through the MFP market stream</span>

      <span className={cn('flex items-center gap-1.5', connected ? 'text-buy' : 'text-destructive')}>
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-buy' : 'bg-destructive')} />
        {connected ? `Connected${latency !== null ? ` ${latency}ms` : ''}` : 'Reconnecting…'}
      </span>
      <span>v0.2</span>
      <span>Not affiliated with MyFundedPerps</span>
    </footer>
  );
}
