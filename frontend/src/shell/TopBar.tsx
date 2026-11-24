import { CircleHelp, Settings, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { IconButton } from './IconButton';

function Mark() {
  return (
    <span className="grid size-7 place-items-center rounded-md bg-brand">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M2 11h2.5l2-6 3 8 2-4H14" stroke="#04110b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const NAV = [
  { id: 'terminal', label: 'Terminal', ready: true },
  { id: 'replay', label: 'Replay', ready: false },
  { id: 'studies', label: 'Studies', ready: false },
];

interface TopBarProps {
  dataLabel: string;
  dataState: 'live' | 'loading' | 'offline';
  onOpenShortcuts: () => void;
}

export function TopBar({ dataLabel, dataState, onOpenShortcuts }: TopBarProps) {
  return (
    <header className="flex h-[52px] items-center gap-6 border-b border-line bg-surface-panel px-4" style={{ gridArea: 'top' }}>
      <div className="flex items-center gap-2.5">
        <Mark />
        <span className="text-[15px] font-semibold tracking-tight">
          FlowReplay <span className="font-medium text-muted-foreground">Live</span>
        </span>
      </div>

      <nav className="flex items-center gap-5 text-[13px] font-medium">
        {NAV.map((item) =>
          item.ready ? (
            <span key={item.id} className="text-brand" aria-current="page">
              {item.label}
            </span>
          ) : (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <span className="cursor-default text-muted-foreground/70">{item.label}</span>
              </TooltipTrigger>
              <TooltipContent>Coming soon</TooltipContent>
            </Tooltip>
          ),
        )}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <span className="inline-flex h-7 items-center gap-2 rounded-full bg-surface-raised px-3 text-xs font-medium text-text-secondary">
          <span
            className={cn(
              'size-1.5 rounded-full',
              dataState === 'live' && 'bg-buy',
              dataState === 'loading' && 'bg-own',
              dataState === 'offline' && 'bg-destructive',
            )}
          />
          {dataLabel}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button variant="outline" size="sm" disabled className="h-7 rounded-full border-line bg-transparent px-3 text-xs">
                <Wallet className="size-3.5" />
                Connect account
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Read-only account view is coming soon</TooltipContent>
        </Tooltip>

        <IconButton label="Settings (coming soon)" disabled>
          <Settings />
        </IconButton>
        <IconButton label="Keyboard shortcuts" onClick={onOpenShortcuts}>
          <CircleHelp />
        </IconButton>
      </div>
    </header>
  );
}
