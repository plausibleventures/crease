"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "@/components/icons"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-ok" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-warn" />
        ),
        error: (
          <OctagonXIcon className="size-4 text-err" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--line-strong)",
          "--border-radius": "var(--radius-lg)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast !font-sans !text-xs !shadow-[0_12px_32px_rgba(0,0,0,0.6)]",
          description: "!text-muted-foreground",
          // the app's tint button (a primary action that is not the screen's main one), not sonner's inverted white chip
          actionButton: "!h-6 !rounded-md !bg-primary/15 !px-2 !text-xs !font-medium !text-primary hover:!bg-primary/25",
          cancelButton: "!h-6 !rounded-md !bg-transparent !px-2 !text-xs !text-muted-foreground hover:!bg-surface-3 hover:!text-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
