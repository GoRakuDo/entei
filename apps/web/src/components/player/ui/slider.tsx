/**
 * shadcn/ui Slider — adapted for Entei Player.
 * Uses Entei OKLCH tokens via CSS variables defined in player.css.
 */
import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

export interface SliderProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /**
   * Optional 0–100 percentage of already-buffered media, drawn as a muted
   * bar behind the played range (YouTube-style). Omit to render nothing.
   */
  bufferPercent?: number;
}

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, value, defaultValue, bufferPercent, ...props }, ref) => {
  // Derive thumb count: controlled value → defaultValue → fallback 1
  const thumbCount = Array.isArray(value)
    ? value.length
    : Array.isArray(defaultValue)
      ? defaultValue.length
      : 1;

  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        className,
      )}
      value={value}
      defaultValue={defaultValue}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-surface">
        {/* Buffered range sits behind the played range (DOM order = paint order). */}
        {bufferPercent !== undefined && bufferPercent > 0 && (
          <span
            className="entei-slider-buffer"
            style={{ width: `${Math.min(100, bufferPercent)}%` }}
            aria-hidden="true"
          />
        )}
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className="block h-5 w-5 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
