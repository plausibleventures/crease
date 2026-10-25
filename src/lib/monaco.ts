// Local (offline) Monaco setup for @monaco-editor/react + an OpenSCAD Monarch grammar.
import * as monaco from "monaco-editor"
import EditorWorker from "monaco-editor/editor/editor.worker?worker"
import { loader } from "@monaco-editor/react"

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker }
  }
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

let registered = false
export function registerOpenScad() {
  if (registered) return
  registered = true
  monaco.languages.register({ id: "openscad", extensions: [".scad"] })
  monaco.languages.setLanguageConfiguration("openscad", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  })
  monaco.languages.setMonarchTokensProvider("openscad", {
    keywords: ["module", "function", "if", "else", "for", "let", "each", "include", "use", "true", "false", "undef", "intersection_for", "assert", "echo"],
    builtins: [
      "cube", "sphere", "cylinder", "polyhedron", "square", "circle", "polygon", "text", "import", "surface",
      "union", "difference", "intersection", "hull", "minkowski", "translate", "rotate", "scale", "mirror",
      "multmatrix", "color", "offset", "resize", "linear_extrude", "rotate_extrude", "projection", "render", "children",
      "abs", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "floor", "round", "ceil", "ln", "log", "pow",
      "sqrt", "exp", "len", "min", "max", "norm", "cross", "concat", "lookup", "str", "chr", "ord", "search", "rands",
    ],
    tokenizer: {
      root: [
        [/\$[a-zA-Z_]\w*/, "variable.predefined"],
        [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@builtins": "type.identifier", "@default": "identifier" } }],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/\d+(\.\d+)?([eE][-+]?\d+)?/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[=<>!+\-*/%?:&|^]+/, "operator"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  } as monaco.languages.IMonarchLanguage)
}

let themed = false
/** Monaco theme matching the Workshop design (the stone panel it sits in, Geist Mono, the semantic palette). */
export function defineStudioTheme() {
  if (themed) return
  themed = true
  monaco.editor.defineTheme("workshop-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "e7e5e4" },
      { token: "comment", foreground: "9a938e", fontStyle: "italic" },
      { token: "keyword", foreground: "9db4ff" },
      { token: "type.identifier", foreground: "48c9a0" }, // OpenSCAD builtins: cube, translate…
      { token: "variable.predefined", foreground: "f77ee0" }, // $fn, $preview
      { token: "number", foreground: "e8b66a" },
      { token: "string", foreground: "b2e65a" },
      { token: "operator", foreground: "a8a29e" },
      { token: "delimiter", foreground: "9a938e" },
      { token: "identifier", foreground: "f5f5f4" },
    ],
    colors: {
      "editor.background": "#1c1917",
      "editor.foreground": "#e7e5e4",
      "editorLineNumber.foreground": "#6b645e",
      "editorLineNumber.activeForeground": "#a8a29e",
      "editor.lineHighlightBackground": "#292524",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#f5f5f430",
      "editor.inactiveSelectionBackground": "#f5f5f418",
      "editorCursor.foreground": "#f5f5f4",
      "editorIndentGuide.background1": "#292524",
      "editorIndentGuide.activeBackground1": "#44403c",
      "editorBracketMatch.background": "#f5f5f418",
      "editorBracketMatch.border": "#f5f5f450",
      "editorWidget.background": "#292524",
      "editorWidget.border": "#44403c",
      "scrollbarSlider.background": "#ffffff18",
      "scrollbarSlider.hoverBackground": "#ffffff28",
      "editorGutter.background": "#1c1917",
    },
  })
}

export { monaco }
