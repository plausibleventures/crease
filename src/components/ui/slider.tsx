import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabel,
  thumbValueText,
  ...props
}: SliderPrimitive.Root.Props & {
  /** accessible name per thumb (index 0, 1, …): needed when there is more than one */
  thumbLabel?: (index: number) => string
  /** spoken value per thumb, e.g. "layer 3 of 40" */
  thumbValueText?: (value: number, index: number) => string
}) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-surface-3 select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            getAriaLabel={thumbLabel ?? undefined}
            getAriaValueText={thumbValueText ? (_f, v, i) => thumbValueText(v, i) : undefined}
            className="relative block size-3.5 shrink-0 rounded-full border-2 border-background bg-primary shadow-[0_1px_2px_rgba(0,0,0,0.35)] ring-primary/30 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-hidden active:ring-1 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
