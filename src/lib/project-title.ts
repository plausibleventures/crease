// A short project name from what the user asked for ("make me a phone stand for my desk" -> "Phone stand for my
// desk"). Local and instant: no designer call. The designer can rename the project later.

const LEAD = [
  /^(hi|hey|hello)\b[\s,!.]*/,
  /^(please|pls|ok|okay|so)\b[\s,]*/,
  /^(can|could|would|will) (you|u)( please)?\s+/,
  /^(i('d| would)? (like|want|need)( you)?( to)?|i'm looking for|we need)\s+/,
  /^(make|design|create|build|print|model|draw|do|get)( me| us)?\s+/,
  /^(something|a thing|an object|a part)( that| to| for)?\s+(?=\w)/,
  /^(a|an|the|some|one|two|three|\d+)\s+/,
  /^(new|little|small|simple|quick)\s+/,
]

/** At most `max` characters, cut at a word. */
function clip(s: string, max: number) {
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const at = cut.lastIndexOf(" ")
  return (at > max * 0.5 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;:-]+$/, "")
}

export function projectTitle(request: string, max = 40): string {
  // the first sentence or line carries the thing; details come after
  let s = request.replace(/\s+/g, " ").trim().replace(/^(hi|hey|hello)\b[\s,!.]*/i, "").split(/(?<=[.!?])\s|\n/)[0] ?? ""
  s = s.replace(/[.!?]+$/, "").replace(/^["'“‘]+|["'”’]+$/g, "")
  let low = s.toLowerCase()
  for (let pass = 0; pass < 3; pass++)
    for (const re of LEAD) {
      const m = low.match(re)
      if (m && m[0].length < low.length) {
        s = s.slice(m[0].length)
        low = low.slice(m[0].length)
      }
    }
  // trailing chatter: ", please" / " thanks"
  s = s.replace(/[,\s]+(please|thanks|thank you|pls)$/i, "").trim()
  s = clip(s, max)
  if (!s) return "New project"
  return s.charAt(0).toUpperCase() + s.slice(1)
}
