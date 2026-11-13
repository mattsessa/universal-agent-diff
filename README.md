# Universal Agent Diff

Review any AI agent's file changes right in the editor, line by line. Works with any agent that writes files to disk: Claude Code, Codex, Copilot, Cursor, Antigravity, scripts, anything.

- Added lines show green; deleted lines show as red blocks.
- **Accept** or **Reject** each change inline; the cursor jumps to the next one.
- New files get **Delete**; deleted files can be restored.
- Orange scrollbar marks show where the changes are.
- A side panel lists every file with pending changes.

> **Requires a Git repository.** The extension only runs when the open folder is a Git repo. It uses Git to know what files looked like before the agent touched them. In a multi-root workspace, every folder's repo is reviewed; folders that aren't in a Git repo are skipped. Repos inside an open folder (nested repos, submodules) are found and reviewed on their own, up to 4 folders deep.

## Install

**1. Download and install**

Download `universal-agent-diff.vsix` from the [latest release](https://github.com/mattsessa/universal-agent-diff/releases/latest).

In VS Code: Extensions view → `···` menu (top right) → **Install from VSIX…** → pick the file.

Or from a terminal:

```sh
curl -L -o universal-agent-diff.vsix https://github.com/mattsessa/universal-agent-diff/releases/latest/download/universal-agent-diff.vsix
code --install-extension universal-agent-diff.vsix
```

In Cursor or Windsurf, use `cursor` or `windsurf` instead of `code`.

**2. Enable the red deleted-line blocks**

These use an API VS Code only allows when you opt in. Command Palette → **Preferences: Configure Runtime Arguments**, and add this line inside the outer `{ }`:

```json
"enable-proposed-api": ["mattsessa.universal-agent-diff"]
```

- Put a comma after the line before it, or VS Code ignores the file.
- If you already have an `"enable-proposed-api"` line, add `"mattsessa.universal-agent-diff"` to that list instead of adding a second line.

Then **fully quit and restart** VS Code. Reloading the window is not enough.

If you skip this step, everything still works, but deleted lines show as a thin red line; hover it to see the removed text.

**3. Turn off your agent's own inline diff** (recommended)

So you don't get two sets of buttons. Look in your agent's settings for an "inline diff", "review changes" or "auto-accept" option. For example, for Antigravity in User Settings (JSON):

```json
"antigravity.enableInlineDiff": false,
```

**4. Make the Accept / Reject buttons stand out** (optional)

Command Palette → **Preferences: Open User Settings (JSON)**, and add:

```json
"editor.codeLensFontSize": 14,
"workbench.colorCustomizations": {
  "editorCodeLens.foreground": "#ff8c00"
},
```

## Usage

Let your agent work. Every file it changes, creates or deletes shows up for review.

- **Accept / Reject** appear above each change. Accept keeps it; Reject puts back what was there before. Either one jumps to the next change.
- **New files** also get **Delete**: Reject empties the file, Delete removes it.
- **Deleted files** appear in the side panel marked _deleted_. Click one to see what was removed, then use ✓ (keep deleted) or ↺ (restore) in the editor's top-right toolbar.
- **Side panel**: the _Universal Agent Diff_ icon in the Activity Bar lists files with pending changes. Hover a file for **Accept all** / **Reject all**.
- **Navigate**: Command Palette → **Next Pending Change** / **Previous Pending Change** (bind them to keys if you like).
- **Your own edits** made while a file is under review become part of that review. Edits to files with nothing pending are ignored.
- **Reviews survive restarts.**
- **Ignored files** (anything in `.gitignore`) aren't reviewed, except **env files**, which are always reviewed because agents often edit them and they hold secrets: `.env`, `.env.*` (e.g. `.env.local`, `.env.sandbox`, `.env.production`), `*.env` (e.g. `prod.env`), and `.envrc` (direnv). Their contents stay on your computer like everything else.

## Debug log (local only, off by default)

The extension has a debug log for tracking down changes that weren't picked up for review, or were picked up wrongly. **It's off by default, never leaves your computer, and nothing is sent anywhere.**

- **What it records:** file paths (relative to the repo) and what the extension decided about each change, e.g. "edited by an agent, review started" or "treated as my edit, ignored". **It never records file contents.** File names can still be sensitive, so look over a log before sharing it.
- **Turn it on:** Command Palette → **Developer: Set Log Level…** → **Universal Agent Diff** → **Debug**. Set it back to **Info** to turn it off.
- **View it:** **Output** panel → **Universal Agent Diff** in the dropdown. VS Code also keeps it in its local logs folder (Command Palette → **Developer: Open Extension Logs Folder**).
- **Reporting a bug:** if a change didn't show up for review, turn the log on, reproduce the problem, and attach the relevant lines (edit out any file names you'd rather not share) to your [issue](https://github.com/mattsessa/universal-agent-diff/issues).

## Update

Download the new `.vsix` from the [latest release](https://github.com/mattsessa/universal-agent-diff/releases/latest) and install it the same way. It replaces the old version.

## Build from source

Requires Node.js 22+.

```sh
git clone https://github.com/mattsessa/universal-agent-diff.git
cd universal-agent-diff
npm install
npm run install:local
```

`install:local` packages the extension with `vsce` (via `npx`, nothing installed globally) and installs it with the `code` command. If `code` isn't found: Command Palette → **Shell Command: Install 'code' command in PATH**.

## Releasing (maintainers)

Pushing commits does **not** publish anything; a release is built only when a version tag is pushed.

1. Commit everything, and test locally with `npm run install:local`.
2. Bump the version, commit and tag in one step (`patch` = bug fixes, `minor` = new features, `major` = breaking changes):

   ```sh
   npm version patch        # e.g. 1.0.0 → 1.0.1, creates tag v1.0.1
   git push --follow-tags   # pushes the commit and the tag
   ```

3. [`.github/workflows/release.yml`](.github/workflows/release.yml) builds `universal-agent-diff.vsix` and publishes it as a GitHub Release. Check the **Actions** tab; the "latest release" download link updates automatically.

If a release fails, fix it, then move the tag to the new commit:

```sh
git tag -d v1.0.1 && git push origin :refs/tags/v1.0.1
git tag v1.0.1 && git push origin v1.0.1
```

## License

[MIT](LICENSE)
