# Changelog

## 1.3.1

### Fixed

- **Renaming or moving files in VS Code is no longer reviewed as an agent change.** Renaming a file or folder in the Explorer (or dragging it somewhere else) used to show up as the agent deleting the old file and creating a new one. It's now treated as your change and ignored. If the file had a pending review, the review moves with it.

## 1.3.0

### Fixed

- **Replacing one of several identical lines shows the old line with its replacement.** When a file had the same line twice in a row and the agent replaced the first one, the review could show it as two separate changes: the new line added in green, then the second copy deleted in red below it, each with its own Accept / Reject. It now shows as one change, with the deleted line in red directly above the new green line.

## 1.2.1

### Changed

- **Finishing a file no longer jumps to another file.** Accepting or rejecting a file's last change used to open the next pending file right away. You now stay in the file you just finished. Within a file, Accept / Reject still jump to the next change. Use **Next Pending Change** to move on to the next file.

## 1.2.0

### Fixed

- **Multi-root workspaces: every repo is reviewed now.** With several folders open in one window, only the first folder's repo was watched, and agent changes in the others went unreviewed. Each folder's Git repo is now reviewed on its own, including repos added to or removed from the workspace while it's open. When more than one repo is open, the side panel shows which repo each file is in. Folders that aren't in a Git repo are skipped instead of stopping the extension.

- **Repos inside other repos are reviewed now.** Opening a folder that holds several repos (for example a parent repo that `.gitignore`s the repos inside it) used to skip every change in the inner repos. Repos inside an open folder are now found and reviewed on their own, including ones you `git init` or clone while the folder is open. Submodules are covered too.

## 1.1.0

### Fixed

- **Endless background git processes in some repos.** In repos with git's file system monitor turned on (`core.fsmonitor`), the extension could get stuck running git commands over and over. Each command made git create and delete a small file inside `.git`, which the extension reacted to by running git again. Agent changes could be missed while this was happening. Changes inside `.git` and `node_modules` are now ignored right away.

- **All env files are reviewed now, not just `.env`.** Agent changes to `.env.local`, `.env.sandbox`, `.env.production`, `prod.env`, `.envrc` and similar files used to go unreviewed when `.gitignore` ignored them. Every env file is now reviewed: `.env`, `.env.*`, `*.env`, and `.envrc`.

### Added

- **Local debug log, off by default.** For tracking down changes that weren't picked up for review. It records file paths and what the extension decided about each change, never file contents, and never leaves your computer. Turn it on with **Developer: Set Log Level…** → **Universal Agent Diff** → **Debug**. See [Debug log](README.md#debug-log-local-only-off-by-default) in the README.

## 1.0.0

- First public release: inline Accept / Reject for any agent's file changes, new and deleted file reviews, side panel, and reviews that survive restarts.
