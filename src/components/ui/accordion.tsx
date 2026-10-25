import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { cn } from "@/lib/utils"
import { ChevronDownIcon } from "@/components/icons"

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  )
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("not-last:border-b", className)}
      {...props}
    />
  )
}

/** Label · summary · chevron: the same shape as DetailsToggle. `summary` is one line about what's inside. */
function AccordionTrigger({
  className,
  children,
  summary,
  ...props
}: AccordionPrimitive.Trigger.Props & { summary?: React.ReactNode }) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger relative flex flex-1 items-center justify-between gap-2 rounded-md border border-transparent py-2.5 text-left text-sm font-semibold transition-all outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:after:border-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-3.5 **:data-[slot=accordion-trigger-icon]:text-muted-foreground",
          className
        )}
        {...props}
      >
        <span className="shrink-0">{children}</span>
        {summary != null && summary !== "" && (
          <span className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted-foreground">{summary}</span>
        )}
        <ChevronDownIcon data-slot="accordion-trigger-icon" className="pointer-events-none shrink-0 transition-transform group-aria-expanded/accordion-trigger:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="overflow-hidden text-xs"
      {...props}
    >
      <div
        className={cn(
          "pt-0 pb-2.5 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
          className
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
