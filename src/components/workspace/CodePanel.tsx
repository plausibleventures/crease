import { lazy, Suspense } from "react"
import { Loader2Icon } from "@/components/icons"
import { EmptyState } from "@/components/panel"

const CodeEditor = lazy(() => import("./CodeEditor"))

export function CodePanel({ projectId }: { projectId: string }) {
  return (
    <Suspense fallback={<EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading editor…" />}>
      <CodeEditor projectId={projectId} />
    </Suspense>
  )
}
