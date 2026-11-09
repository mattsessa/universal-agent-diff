# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Universal Agent Diff: an interactive diff view VS Code extension for reviewing AI agent changes.

## Functionality

- Agent disk writes start a per-file review snapshot.
- Inline Accept / Reject on every change.
- Added lines green; deleted lines shown as red blocks.
- My edits join an open review; otherwise ignored.
- Snapshot cleared once everything accepted or rejected.
- Watches closed files; detects changes without opening them.
- Tracks `.env` even though it's gitignored.
- Ignores changes restored by source control (discard, checkout).
- Side panel lists pending files with count badge.
- Hover file in panel: Accept all / Reject all.
- Reject all on agent-created file deletes it.
- New agent-created files get Accept / Reject / Delete; Reject empties the file, Delete removes it.
- Agent file deletions are reviewable: listed as "deleted"; Accept keeps it deleted, Reject restores it.
- Next / Previous Pending Change commands (Command Palette).
- Pending reviews persist across restarts; storage purged when empty.

## Notes

- All code lives in `src/extension.ts`.
- `TEST_ME.md` (repo root) is an interactive demo: the user prompts their agent "Do test N in TEST_ME.md" (or a part, e.g. "test 1A") and reviews the result. Keep its tests in sync with the Functionality list above.
- Red deleted-line blocks use proposed API `editorInsets`.
- Requires `"enable-proposed-api": ["mattsessa.universal-agent-diff"]` in `~/.vscode/argv.json`.
- Without it, deletions fall back to red bar + hover.
- Install: `npm run install:local`, then reload window.
- Release: see "Releasing" in README.md. Give me the commands (`npm version patch|minor|major`, then `git push --follow-tags`); I run them myself. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the `.vsix` and publishes a GitHub Release.
- `.npmrc` sets `legacy-peer-deps=true` because typescript-eslint 8.56 declares a peer of TypeScript <6; remove it after upgrading typescript-eslint.
- Internal IDs (`interactiveDiff.*` commands/views, storage key) keep the old prefix on purpose.

## Rules

- Do not edit files prior to my explicit consent.
- Run only the commands in package.json, and those required to test and devleop.
- Never install things on my computer.

## WARNINGS

- NEVER use git, it has no use to you.
