---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

<!-- Local adaptation for Print Studio: upstream fetches the guidelines from
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
on every run. They are vendored instead (pinned commit in ../SOURCES.md), so the
skill makes no network request. -->

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Read the guidelines in [references/web-interface-guidelines.md](references/web-interface-guidelines.md)
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

The rules are vendored locally in `references/web-interface-guidelines.md` (a
pinned copy of `command.md` from vercel-labs/web-interface-guidelines). Do not
fetch them from the network. The file contains all the rules and the output
format; treat its `$ARGUMENTS` placeholder as the files or pattern the user gave.

## Usage

When a user provides a file or pattern argument:
1. Read `references/web-interface-guidelines.md`
2. Read the specified files
3. Apply all rules from the guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
