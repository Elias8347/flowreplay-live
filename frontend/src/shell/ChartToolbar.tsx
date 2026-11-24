import { ChevronDown, Layers, LayoutTemplate, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IconButton } from './IconButton';

export type ChartType = 'footprint' | 'candles';

export const TIMEFRAMES = [
  { id: '1m', ms: 60_000, historyMinutes: 30 },
  { id: '3m', ms: 180_000, historyMinutes: 60 },
  { id: '5m', ms: 300_000, historyMinutes: 60 },
] as const;
export type TimeframeId = (typeof TIMEFRAMES)[number]['id'];

const segment = 'h-7 rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-surface-raised data-[state=on]:text-foreground';

function Divider() {
  return <Separator orientation="vertical" className="mx-1 h-5 bg-line" />;
}

function SoonMenu({ icon: Icon, label, note }: { icon: typeof Layers; label: string; note: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground">
          <Icon className="size-3.5" />
          {label}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
        <DropdownMenuItem disabled className="text-xs">
          {note}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ChartToolbarProps {
  timeframe: TimeframeId;
  onTimeframeChange: (tf: TimeframeId) => void;
  chartType: ChartType;
  onChartTypeChange: (type: ChartType) => void;
}

export function ChartToolbar({ timeframe, onTimeframeChange, chartType, onChartTypeChange }: ChartToolbarProps) {
  return (
    <div className="flex h-9 items-center gap-1 border-b border-line bg-surface-panel px-2" style={{ gridArea: 'tool' }}>
      <ToggleGroup type="single" value={timeframe} onValueChange={(v) => v && onTimeframeChange(v as TimeframeId)} className="gap-0.5">
        {TIMEFRAMES.map((tf) => (
          <ToggleGroupItem key={tf.id} value={tf.id} className={segment}>
            {tf.id}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Divider />
      <ToggleGroup type="single" value={chartType} onValueChange={(v) => v && onChartTypeChange(v as ChartType)} className="gap-0.5">
        <ToggleGroupItem value="footprint" className={segment}>
          Footprint
        </ToggleGroupItem>
        <ToggleGroupItem value="candles" className={segment}>
          Candles
        </ToggleGroupItem>
      </ToggleGroup>
      <Divider />
      <span className="px-1.5 text-xs text-muted-foreground">
        Rows <span className="font-medium text-foreground">Auto</span>
      </span>
      <Divider />
      <SoonMenu icon={Layers} label="Studies" note="Studies arrive with the open studies platform" />
      <SoonMenu icon={LayoutTemplate} label="Templates" note="Saved study templates are coming soon" />

      <div className="ml-auto flex items-center gap-1">
        <ToggleGroup type="single" value="live" className="gap-0.5 rounded-md bg-surface-inset p-0.5">
          <ToggleGroupItem value="live" className={`${segment} h-6 gap-1.5`}>
            <span className="size-1.5 rounded-full bg-buy" />
            Live
          </ToggleGroupItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <ToggleGroupItem value="replay" disabled className={`${segment} h-6`}>
                  Replay
                </ToggleGroupItem>
              </span>
            </TooltipTrigger>
            <TooltipContent>Footprint replay is coming soon</TooltipContent>
          </Tooltip>
        </ToggleGroup>
        <Divider />
        <IconButton label="Undo (needs drawings)" disabled>
          <Undo2 />
        </IconButton>
        <IconButton label="Redo (needs drawings)" disabled>
          <Redo2 />
        </IconButton>
      </div>
    </div>
  );
}
