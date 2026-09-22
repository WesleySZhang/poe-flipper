"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

function Slider({
  className,
  ...props
}: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center py-2">
        {/* bg-input, not bg-muted - muted (oklch 0.97) sits nearly on top of the card/background
            (1.0) in light mode, so the unfilled track all but disappeared into the page. input
            (0.922, the same tone this app's own text inputs use for their border) reads as a
            clearly distinct gray track in both themes instead. */}
        <SliderPrimitive.Track className="relative h-2.5 w-full grow rounded-full border border-border bg-input shadow-inner">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            className="block size-5 rounded-full border-2 border-primary bg-background shadow-md outline-hidden transition-transform hover:scale-110 focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
