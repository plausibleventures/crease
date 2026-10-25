/// <reference types="vitest/config" />
import { realpathSync } from "node:fs"
import { relative, resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "./shared"),
    },
  },
  // Pre-bundle heavy deps the workspace imports lazily; otherwise Vite re-optimizes on first
  // navigation and the page ends up with two copies of React ("Invalid hook call").
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "three",
      "three/examples/jsm/loaders/STLLoader.js",
      "three/examples/jsm/loaders/3MFLoader.js",
      "@react-three/fiber",
      "@react-three/drei",
      "@monaco-editor/react",
      "monaco-editor",
      "zustand",
    ],
  },
  // Agent worktrees (.claude/worktrees) hold full copies of the repo; keep them out of tests and the dev watcher.
  test: { exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "dist-electron/**"] },
  server: {
    // judged relative to this folder, so a copy inside .claude/worktrees still watches its own files
    watch: { ignored: (p: string) => /^\.claude([\\/]|$)/.test(relative(import.meta.dirname, p)) },
    // PRINTSTUDIO_WEB_PORT / PRINTSTUDIO_API_PORT run a second copy (e.g. an agent worktree) beside the app
    port: Number(process.env.PRINTSTUDIO_WEB_PORT || 5173),
    strictPort: true,
    // a worktree may link node_modules to the main checkout's; serve fonts/icons from its real path too
    fs: { allow: [import.meta.dirname, realpathSync(resolve(import.meta.dirname, "node_modules"))] },
    proxy: {
      "/api": `http://127.0.0.1:${process.env.PRINTSTUDIO_API_PORT || 5174}`,
      "/ws": { target: `ws://127.0.0.1:${process.env.PRINTSTUDIO_API_PORT || 5174}`, ws: true },
    },
  },
})
