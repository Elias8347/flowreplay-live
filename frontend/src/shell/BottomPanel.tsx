import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IconButton } from './IconButton';

const TABS = [
  ['positions', 'Positions'],
  ['orders', 'Orders'],
  ['fills', 'Fills'],
  ['review', 'Trade Review'],
] as const;

export function BottomPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section className="flex min-h-0 flex-col border-t border-line bg-surface-panel" style={{ gridArea: 'bottom' }}>
      <Tabs defaultValue="positions" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-10 shrink-0 items-center gap-6 px-4">
          <TabsList variant="line" className="h-10 gap-6 p-0">
            {TABS.map(([id, label]) => (
              <TabsTrigger key={id} value={id} className="h-10 flex-none px-0 text-[13px] font-medium" onClick={() => !open && onToggle()}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <span className="flex items-center gap-1.5 rounded-full bg-surface-raised px-2.5 py-1 text-xs text-text-secondary">
            <Lock className="size-3" />
            Read-only
          </span>
          <div className="ml-auto">
            <IconButton label={open ? 'Collapse panel' : 'Expand panel'} onClick={onToggle}>
              {open ? <ChevronDown /> : <ChevronUp />}
            </IconButton>
          </div>
        </div>
        {open &&
          TABS.map(([id, label]) => (
            <TabsContent key={id} value={id} className="grid min-h-0 place-items-center border-t border-line">
              <div className="max-w-md px-6 text-center">
                <div className="text-base font-semibold">No account connected</div>
                <div className="mt-2 text-sm leading-relaxed text-text-secondary">
                  {label} will appear here once a read-only MFP key is connected. This view never places or changes orders. Coming soon.
                </div>
              </div>
            </TabsContent>
          ))}
      </Tabs>
    </section>
  );
}
