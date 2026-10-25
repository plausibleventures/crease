import { BotIcon, CuboidIcon, FolderIcon, PrinterIcon } from "@/components/icons"
import { BrandMark } from "@/components/BrandMark"
import { modKey } from "@/lib/commands"
import { useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"

/**
 * Brand + top-level sections (Library, Machines, Designers), on every screen including inside a project (U4).
 * Outside a project, the last open project follows as a one-click way back. `compact` (project header): icons only
 * below xl, so the canvas toolbar keeps its room; it never shrinks, so a long project title truncates instead of
 * running over the icons.
 */
export function AppNav({ compact = false }: { compact?: boolean }) {
  const route = useStudio((s) => s.route)
  const navigate = useStudio((s) => s.navigate)
  const recent = useStudio((s) => s.recentProject)
  const printing = useStudio((s) => (s.machines ?? []).filter((m) => m.status?.state === "printing" || m.status?.state === "preparing").length)
  const item = (name: "library" | "machines" | "agents", label: string, key: string, icon: React.ReactNode, badge?: React.ReactNode) => (
    <button
      onClick={() => navigate({ name })}
      aria-current={route.name === name ? "page" : undefined}
      aria-label={compact ? label : undefined}
      title={`${label} (${modKey(key)})`}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5",
        route.name === name && "bg-muted text-foreground",
      )}
    >
      {icon}
      <span className={cn(compact && "hidden xl:inline")}>{label}</span>
      {badge}
    </button>
  )
  return (
    <nav className={cn("flex min-w-0 items-center gap-3", compact && "shrink-0")} aria-label="Sections">
      <div className="flex shrink-0 items-center gap-2 font-semibold">
        <BrandMark />
        <span className={cn("tracking-[-0.02em]", compact && "sr-only")}>Crease</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {item("library", "Library", "1", <FolderIcon />)}
        {item(
          "machines",
          "Machines",
          "2",
          <PrinterIcon />,
          printing > 0 && (
            <span className="rounded-sm bg-primary/20 px-1.5 text-micro text-primary tabular-nums" aria-label={`${printing} printing`}>
              {printing}
            </span>
          ),
        )}
        {item("agents", "Designers", "3", <BotIcon />)}
      </div>
      {recent && route.name !== "project" && (
        <div className="flex min-w-0 items-center gap-1 border-l border-line pl-3">
          <button
            onClick={() => navigate({ name: "project", id: recent.id })}
            title={`Back to ${recent.name}`}
            aria-label={`Back to project ${recent.name}`}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CuboidIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="max-w-44 truncate">{recent.name}</span>
          </button>
        </div>
      )}
    </nav>
  )
}
