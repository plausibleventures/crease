/**
 * Command palette filter: every word of the query must appear in the text, as a substring (best, more so at a word
 * start) or as letters in order ("nwprj" → "New project"). Higher is better; null = no match. Empty query → 0.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase()
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  let score = 0
  for (const w of words) {
    const at = t.indexOf(w)
    if (at >= 0) {
      score += at === 0 ? 4 : /[\s:·/-]/.test(t[at - 1]) ? 3 : 2
      continue
    }
    let j = 0
    let gaps = 0
    for (let i = 0; i < t.length && j < w.length; i++) {
      if (t[i] === w[j]) j++
      else if (j > 0) gaps++
    }
    if (j < w.length) return null
    score += 1 - Math.min(gaps, 10) / 20
  }
  return score
}
