import { plainWords } from "./plain"

const plain = (text: string) => plainWords(text)

/**
 * Text in plain words (no file or variable names). U2: there are no modes, so every screen gets plain words; the
 * exact text stays one hover or one "Details" away where a screen offers it.
 */
export function usePlain(): (text: string) => string {
  return plain
}
