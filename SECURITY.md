# Security policy

Crease runs an AI agent on your computer and can send jobs to a machine that heats up and moves. We take reports
about either seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: the repository's **Security** tab >
**Report a vulnerability**. Include what you did, what happened, the version (or commit), your OS, and which designer
(runtime/model) was involved. A minimal project or build pack that reproduces it helps a lot.

This is a small alpha project: expect an acknowledgement within a week. We'll agree a disclosure date with you, fix
it on `main`, and credit you unless you'd rather we didn't.

Only the latest `main` and the newest release are supported.

## In scope

- **Agent sandbox escapes.** The design agent may only write inside its project folder; it has no network access
  except through the app's tools; it can't write G-code, `.git`, `.studio`, `.claude` or other app-owned files; and it
  can't reach a printer directly. Anything that gets around these (through Bash, an interpreter, symlinks, another
  tool, user-level Claude settings, hooks or MCP servers) is in scope.
- **Print approval bypass.** Starting a print, or changing what will be printed, without the user's confirmation in
  the app's dialog; printing something other than the reviewed slice; or a print request that skips the
  latest-slice review.
- **Prompt injection that crosses a boundary**: text in a project, an imported build pack, a photo or a web page that
  makes the agent do one of the above, or leak data out of the project.
- **Build pack import**: zip path traversal, checksum bypass, or imported agent settings (`.claude`, `CLAUDE.md`,
  `.mcp.json`, hooks) running before the user enables them.
- **Secrets**: API keys exposed through the settings API, logs, transcripts, events, build packs or crash output.
- **The local API**: the server listens on 127.0.0.1 with a per-launch token in the desktop app; anything that lets a
  web page or another local user drive it.
- **Printer commands** that could cause unsafe motion or heating (for example, wrong bed size or temperatures sent
  without the preflight checks).

## Out of scope (report upstream)

- The Claude CLI and Agent SDK themselves: Anthropic's [vulnerability form](https://hackerone.com/4f1f16ba-10d3-4d09-9ecc-c721aad90f24/embedded_submissions/new).
- OpenSCAD, OrcaSlicer, Klipper/Moonraker or printer firmware bugs, unless Crease makes them reachable in a way
  they otherwise wouldn't be.
- The agent designing a bad or unprintable part without crossing a boundary: please file a "Design quality" issue.
- Attacks that need someone who already controls your user account or your printer's network.
