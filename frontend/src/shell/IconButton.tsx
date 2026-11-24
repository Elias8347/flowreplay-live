import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface IconButtonProps extends ComponentProps<typeof Button> {
  label: string;
  children: ReactNode;
  active?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Ghost icon button with a tooltip. Disabled buttons still explain themselves on hover. */
export function IconButton({ label, children, active, side = 'bottom', className, disabled, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            className={cn(
              'size-8 text-muted-foreground hover:bg-surface-hover hover:text-foreground [&_svg]:size-4',
              active && 'bg-surface-raised text-foreground',
              className,
            )}
            {...props}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
