# Changelog

## 1.1.0

### Fixed

- **Endless background git processes in some repos.** In repos with git's file system monitor turned on (`core.fsmonitor`), the extension could get stuck running git commands over and over. Each command made git create and delete a small file inside `.git`, which the extension reacted to by running git again. Agent changes could be missed while this was happening. Changes inside `.git` and `node_modules` are now ignored right away.

- **All env files are reviewed now, not just `.env`.** Agent changes to `.env.local`, `.env.sandbox`, `.env.production`, `prod.env`, `.envrc` and similar files used to go unreviewed when `.gitignore` ignored them. Every env file is now reviewed: `.env`, `.env.*`, `*.env`, and `.envrc`.

### Added

- **Local debug log, off by default.** For tracking down changes that weren't picked up for review. It records file paths and what the extension decided about each change, never file contents, and never leaves your computer. Turn it on with **Developer: Set Log Level…** → **Universal Agent Diff** → **Debug**. See [Debug log](README.md#debug-log-local-only-off-by-default) in the README.

## 1.0.0

- First public release: inline Accept / Reject for any agent's file changes, new and deleted file reviews, side panel, and reviews that survive restarts.
