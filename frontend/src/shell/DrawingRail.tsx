import { ArrowUpDown, EyeOff, Lock, Magnet, Minus, MousePointer2, Ruler, Slash, Square, Trash2 } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { IconButton } from './IconButton';

const GROUPS = [
  [
    ['Cursor', MousePointer2],
    ['Trend line', Slash],
    ['Horizontal level', Minus],
    ['Rectangle', Square],
    ['Long and short position', ArrowUpDown],
    ['Measure', Ruler],
  ],
  [
    ['Magnet', Magnet],
    ['Lock all drawings', Lock],
    ['Hide all drawings', EyeOff],
    ['Remove all drawings', Trash2],
  ],
] as const;

export function DrawingRail() {
  return (
    <aside className="flex w-11 flex-col items-center gap-1 border-r border-line bg-surface-panel py-2" style={{ gridArea: 'rail' }} aria-label="Drawing tools">
      {GROUPS.map((group, i) => (
        <div key={i} className="flex flex-col items-center gap-1">
          {i > 0 && <Separator className="my-1 w-6 bg-line" />}
          {group.map(([label, Icon]) =>
            label === 'Cursor' ? (
              <IconButton key={label} label={label} side="right" active>
                <Icon />
              </IconButton>
            ) : (
              <IconButton key={label} label={`${label} (coming soon)`} side="right" disabled>
                <Icon />
              </IconButton>
            ),
          )}
        </div>
      ))}
    </aside>
  );
}
