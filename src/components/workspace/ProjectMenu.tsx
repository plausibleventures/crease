import { useState } from "react"
import { CopyIcon, CuboidIcon, MoreHorizontalIcon, PackageIcon, PencilIcon, TagIcon, Trash2Icon, UploadIcon } from "@/components/icons"
import { requestImport } from "./ImportFile"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ExportPackDialog, useImportPack } from "@/components/pack/BuildPack"
import { askRename, askTags, askTrash, duplicateProject } from "@/components/library/project-actions"
import { useStudio } from "@/stores/studio"

/** The workspace header's project menu (⋯): rename, tags, duplicate, import/export, move to Trash. */
export function ProjectMenu({ projectId }: { projectId: string }) {
  const [exportOpen, setExportOpen] = useState(false)
  const imp = useImportPack()
  const project = useStudio((s) => (s.project?.id === projectId ? s.project : null))
  const ref = project ? { id: project.id, name: project.name, tags: project.tags } : null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="Project menu" aria-label="Project menu" />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={!ref} onClick={() => ref && askRename(ref)}>
            <PencilIcon /> Rename…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!ref} onClick={() => ref && askTags(ref)}>
            <TagIcon /> Tags…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!ref} onClick={() => ref && void duplicateProject(ref)}>
            <CopyIcon /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={requestImport}>
            <CuboidIcon /> Import file (STL, 3MF, SCAD)…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setExportOpen(true)}>
            <PackageIcon /> Export build pack…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={imp.pick} disabled={imp.busy}>
            <UploadIcon /> Import build pack…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!ref} onClick={() => ref && askTrash(ref)} className="text-err">
            <Trash2Icon /> Move to Trash…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ExportPackDialog projectId={projectId} open={exportOpen} onOpenChange={setExportOpen} />
      {imp.element}
    </>
  )
}
