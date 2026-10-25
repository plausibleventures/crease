import { cn } from "@/lib/utils"

/**
 * The Crease mark inside the window (nav, welcome). One swappable asset: public/brand/crease-mark.png, a small copy of
 * the app icon (build/icon.png, the faceted Ridge C; `npm run icon` regenerates it).
 */
export const BRAND_MARK_SRC = "/brand/crease-mark.png"

export function BrandMark({ className }: { className?: string }) {
  return <img src={BRAND_MARK_SRC} alt="" aria-hidden draggable={false} className={cn("size-5 shrink-0 rounded-[25%] select-none", className)} />
}
