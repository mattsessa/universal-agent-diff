# Known issues

For agents and maintainers. Read the entry before working on an issue; update it when anything changes.

## Red block lands inside a wrapped line

Open. A VS Code bug; the extension's code is correct. Verified 2026-11-24 on VS Code 1.147.0.

- **Symptom:** when the line directly above a change wraps, the red deleted-line block appears after that line's first row, splitting it. Accept / Reject and the green lines stay below the whole line.
- **Repro:** in Markdown (wraps by default), have the agent change or delete a line directly below a line long enough to wrap.
- **Tested:** breaks for any wrapped line above (paragraph, table row, bullet) and any change (replace, multi-line replace, pure delete); worse the more rows it wraps onto. Fine when the line above is short or blank, even if the changed line wraps. Window width doesn't matter.
- **Cause:** VS Code anchors every inset at column 1: `this.afterColumn = 1` in `EditorWebviewZone` ([mainThreadCodeInsets.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadCodeInsets.ts)). Column 1 of a wrapped line is in its first row. CodeLens uses the max column (`1073741824`) and lands after the wrapped rest. Same since at least 1.80. Our call (`showDeletedInsets` in `src/extension.ts`) passes the right line.
- **Can't fix in the extension:** the inset API takes only a line number, and no API reports which lines wrap.
- **Tried:** measuring the line above in the inset's webview and falling back to red bar + hover. Missed cases; reverted.
- **Ruled out (from VS Code source):**
  - Red block below the green: anchors on the last green line instead, same bug.
  - Accept / Reject above the red: zones in the same gap are ordered by column, so the inset (1) always sits above CodeLens (max).
  - Old text inline on the green line as a red strikethrough decoration: drawn as CSS `::before`/`::after`, which wrapping ignores; one line only; not selectable.
  - Hover only: the delay is the global `editor.hover.delay`; the hover's background comes from the theme.
- **Next steps:**
  1. Prove the fix locally (not done yet): in `/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`, change the inset zone's `this.afterColumn=1,` (next to `this.heightInLines=`; not CodeLens's `1073741824`) to `this.afterColumn=1073741824,`, restart, retest. VS Code then warns the install is corrupt; updates undo it.
  2. Upstream issue + one-line PR (not filed yet): set `afterColumn` to `Constants.MAX_SAFE_SMALL_INTEGER`, as CodeLens does. Insets tracking issue: [#85682](https://github.com/microsoft/vscode/issues/85682).
  3. Only if users complain first: use red bar + hover where `editor.wordWrap` isn't `off`. Caveat: View → Word Wrap (Alt+Z) toggles wrapping without changing the setting, and extensions can't see it.
- **User workaround:** turn word wrap off, e.g. `"[markdown]": { "editor.wordWrap": "off" }`.
