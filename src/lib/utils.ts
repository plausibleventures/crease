import { createCn } from "cn/config"

// The type scale has two app sizes beside Tailwind's (tokens in src/index.css): text-micro and text-caption. Without
// this, class merging would read them as text colours and drop them next to text-muted-foreground.
export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: ["micro", "caption"] }] } } })
