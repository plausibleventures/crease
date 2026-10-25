// Settings > About: what this is (name, version, licence), where your things are kept, which tools it is using, the
// licences, and "Report a problem". The app menu's "About Crease" opens Settings here.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { AboutInfo } from "@shared/types"
import { ExternalLinkIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { LicencesButton } from "@/components/dialogs/LicencesDialog"
import { api, errMsg } from "@/lib/api"
import { desktop } from "@/lib/desktop"
import { diagnostics, reportBody, TOOLS, toolVersion, type ToolChecks } from "@/lib/diagnostics"

export function AboutSection({ checks }: { checks: ToolChecks | null }) {
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api
      .about()
      .then(setAbout)
      .catch((e) => setErr(errMsg(e)))
  }, [])
  const showFolder = desktop()?.showDataFolder

  if (err) return <div className="text-caption text-err">Couldn't load: {err}</div>
  if (!about) return <div className="text-caption text-muted-foreground">Loading…</div>

  const report = async () => {
    const diag = diagnostics(about, checks)
    if (about.issueUrl) {
      const q = new URLSearchParams({ title: "", body: reportBody(diag) })
      window.open(`${about.issueUrl}?${q}`, "_blank", "noopener")
      return
    }
    try {
      await navigator.clipboard.writeText(reportBody(diag))
      toast.success("Copied a summary", { description: "Paste it into your report. It has versions only, no files or keys." })
    } catch {
      toast.error("Couldn't copy the summary")
    }
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{about.name}</span>
        <span className="text-muted-foreground tabular-nums">{about.version}</span>
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
        <span className="text-muted-foreground">{about.license}</span>
        {about.repoUrl && (
          <a href={about.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            Project page <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        )}
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Your data</dt>
        <dd className="flex min-w-0 items-baseline gap-1.5">
          {/* a long path loses its start, not the folder name */}
          <span className="min-w-0 truncate text-left font-mono [direction:rtl]" title={about.dataDir} translate="no">
            <bdi>{about.dataDir}</bdi>
          </span>
          {showFolder && (
            <>
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <Button variant="link" size="xs" className="h-auto shrink-0 px-0" onClick={() => void showFolder()}>
                Show in Finder
              </Button>
            </>
          )}
        </dd>
        {TOOLS.map((t) => (
          <div key={t.key} className="contents">
            <dt className="text-muted-foreground">{t.name}</dt>
            <dd className="font-mono tabular-nums" translate="no">
              {toolVersion(checks?.[t.key])}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <LicencesButton />
        <Button variant="outline" size="sm" onClick={() => void report()} title={about.issueUrl ? "Opens a new issue with the versions filled in" : "Copies the app, tool and system versions to paste into a report"}>
          Report a problem
          {about.issueUrl && <ExternalLinkIcon aria-hidden />}
        </Button>
      </div>
    </div>
  )
}
