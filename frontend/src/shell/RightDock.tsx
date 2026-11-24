import { PanelRightClose, PanelRightOpen, Wallet } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OrderBook } from '@/components/OrderBook';
import { TapeTable } from '@/components/TapeTable';
import { DOMLadder } from '@/components/DOMLadder';
import { useSymbolData } from '@/stores/useMarketStore';
import { IconButton } from './IconButton';

interface RightDockProps {
  symbol: string;
  open: boolean;
  onToggle: () => void;
}

const tabClass = 'h-10 flex-none px-0 text-[13px] font-medium';

export function RightDock({ symbol, open, onToggle }: RightDockProps) {
  const data = useSymbolData(symbol);

  if (!open) {
    return (
      <aside className="flex flex-col items-center border-l border-line bg-surface-panel py-2" style={{ gridArea: 'dock' }}>
        <IconButton label="Show panels" side="left" onClick={onToggle}>
          <PanelRightOpen />
        </IconButton>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 flex-col gap-2 border-l border-line bg-surface-app p-2" style={{ gridArea: 'dock' }}>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-panel">
        <Tabs defaultValue="book" className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex items-center border-b border-line pr-1 pl-3">
            <TabsList variant="line" className="h-10 gap-5 p-0">
              <TabsTrigger value="book" className={tabClass}>Order Book</TabsTrigger>
              <TabsTrigger value="trades" className={tabClass}>Trades</TabsTrigger>
              <TabsTrigger value="dom" className={tabClass}>DOM</TabsTrigger>
            </TabsList>
            <div className="ml-auto">
              <IconButton label="Hide panels" side="left" onClick={onToggle}>
                <PanelRightClose />
              </IconButton>
            </div>
          </div>
          <TabsContent value="book" className="min-h-0 overflow-hidden">
            <OrderBook orderBook={data?.orderBook ?? null} assetType="crypto" symbol={symbol} showHeatmap maxLevels={15} />
          </TabsContent>
          <TabsContent value="trades" className="min-h-0 overflow-hidden">
            <TapeTable trades={data?.trades ?? []} assetType="crypto" symbol={symbol} showAnalytics={false} compact />
          </TabsContent>
          <TabsContent value="dom" className="min-h-0 overflow-hidden">
            <DOMLadder symbol={symbol} levels={20} />
          </TabsContent>
        </Tabs>
      </section>

      <section className="rounded-lg border border-line bg-surface-panel p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Account risk</span>
          <span className="text-[11px] text-muted-foreground">Not connected</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Connect a read-only MFP key to see equity, open P&amp;L and the distance to your loss floors. Coming soon.
        </p>
        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Wallet className="size-3.5" />
          Your key stays on this computer
        </div>
      </section>
    </aside>
  );
}
