import { Fragment, type ReactNode } from "react"

// Very small markdown subset: fenced code, headings, bullets, inline code, bold.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith("`"))
      out.push(
        <code key={`${keyBase}-${i++}`} className="rounded-sm bg-muted px-1 font-mono text-caption">
          {tok.slice(1, -1)}
        </code>,
      )
    else out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdownish({ text }: { text: string }) {
  const parts = text.split(/```/)
  return (
    <div className="flex flex-col gap-1 leading-snug break-words">
      {parts.map((part, pi) => {
        if (pi % 2 === 1) {
          const nl = part.indexOf("\n")
          const code = nl >= 0 ? part.slice(nl + 1) : part
          return (
            <pre key={pi} className="overflow-x-auto border bg-background/60 p-2 font-mono text-caption leading-snug">
              {code.replace(/\n$/, "")}
            </pre>
          )
        }
        const blocks = part.split(/\n{2,}/).filter((b) => b.trim())
        return (
          <Fragment key={pi}>
            {blocks.map((b, bi) => {
              const lines = b.split("\n")
              if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim()))
                return (
                  <ul key={bi} className="ml-4 list-disc">
                    {lines
                      .filter((l) => l.trim())
                      .map((l, li) => (
                        <li key={li}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), `${pi}-${bi}-${li}`)}</li>
                      ))}
                  </ul>
                )
              const h = b.match(/^(#{1,4})\s+(.*)$/)
              if (h && lines.length === 1)
                return (
                  <div key={bi} className="font-semibold">
                    {inline(h[2], `${pi}-${bi}`)}
                  </div>
                )
              return (
                <p key={bi} className="whitespace-pre-wrap">
                  {inline(b, `${pi}-${bi}`)}
                </p>
              )
            })}
          </Fragment>
        )
      })}
    </div>
  )
}
