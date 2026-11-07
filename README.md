# Universal Agent Diff

Review any AI agent's file changes right in the editor, line by line. Works with any agent that writes files to disk: Claude Code, Codex, Copilot, Cursor, Antigravity, scripts, anything.

- Added lines show green; deleted lines show as red blocks.
- **Accept** or **Reject** each change inline; the cursor jumps to the next one.
- New files get **Delete**; deleted files can be restored.
- Orange scrollbar marks show where the changes are.
- A side panel lists every file with pending changes.

> **Requires a Git repository.** The extension only runs when the open folder is a Git repo. It uses Git to know what files looked like before the agent touched them.

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
- **Deleted files** appear in the side panel marked *deleted*. Click one to see what was removed, then use ✓ (keep deleted) or ↺ (restore) in the editor's top-right toolbar.
- **Side panel**: the *Universal Agent Diff* icon in the Activity Bar lists files with pending changes. Hover a file for **Accept all** / **Reject all**.
- **Navigate**: Command Palette → **Next Pending Change** / **Previous Pending Change** (bind them to keys if you like).
- **Your own edits** made while a file is under review become part of that review. Edits to files with nothing pending are ignored.
- **Reviews survive restarts.**

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

## License

[MIT](LICENSE)
