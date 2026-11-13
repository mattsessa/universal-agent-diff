import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { diffArrays } from 'diff';
import { readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── Diff ────────────────────────────────────────────────────────────────────

/** One contiguous change between the snapshot (old) and the current text (new). */
interface Hunk {
  /** 0-based line index in the snapshot where the change starts */
  oldStart: number;
  /** Snapshot lines replaced by this change (each includes its line ending) */
  oldLines: string[];
  /** 0-based line index in the current text where the change starts */
  newStart: number;
  /** Current lines introduced by this change (each includes its line ending) */
  newLines: string[];
}

/** Split text into lines, keeping each line's ending so `join('')` round-trips exactly. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Compute change hunks between two texts. No context lines; each hunk is one change group. */
function computeHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) {
    return [];
  }
  const parts = diffArrays(splitLines(oldText), splitLines(newText));
  const hunks: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let current: Hunk | null = null;

  for (const part of parts) {
    if (!part.added && !part.removed) {
      current = null;
      oldLine += part.value.length;
      newLine += part.value.length;
      continue;
    }
    if (!current) {
      current = { oldStart: oldLine, oldLines: [], newStart: newLine, newLines: [] };
      hunks.push(current);
    }
    if (part.removed) {
      current.oldLines.push(...part.value);
      oldLine += part.value.length;
    } else {
      current.newLines.push(...part.value);
      newLine += part.value.length;
    }
  }
  return hunks;
}

/** Accept a hunk: return the snapshot text with the hunk's new lines applied. */
function applyHunk(oldText: string, hunk: Hunk): string {
  const lines = splitLines(oldText);
  lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
  return lines.join('');
}

/** Character offsets in the current text covered by a hunk's new lines: [start, end). */
function newRangeOffsets(newText: string, hunk: Hunk): [number, number] {
  const lines = splitLines(newText);
  let start = 0;
  for (let i = 0; i < hunk.newStart; i++) {
    start += lines[i].length;
  }
  const end = start + hunk.newLines.reduce((n, l) => n + l.length, 0);
  return [start, end];
}

// ─── Debug log ───────────────────────────────────────────────────────────────

/**
 * Local debug log (Output → Universal Agent Diff), for diagnosing missed or
 * wrong reviews. Records repo-relative file paths and review decisions, never
 * file contents. Written only at Debug / Trace log level, which is off by
 * default (Developer: Set Log Level…). Stays on this machine: VS Code keeps it
 * in its local logs folder; nothing is sent anywhere.
 */
let log: vscode.LogOutputChannel | undefined;
const debug = (msg: string) => log?.debug(msg);

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Whether a repo-relative path is inside `.git` or `node_modules`. These are
 * never reviewed, and disk events for them are dropped before doing any work:
 * running git in response to a `.git` change can feed itself (e.g. git's
 * fsmonitor daemon writes and deletes a cookie file for every git command).
 */
function isInternalPath(rel: string): boolean {
  const parts = rel.split('/');
  return parts.includes('.git') || parts.includes('node_modules');
}

const STORAGE_KEY = 'interactiveDiff.snapshots';

interface StoredSnapshots {
  repoRoot: string;
  files: Record<string, string>;
  /** Files whose pending change is that the agent deleted them. */
  deleted?: string[];
}

/** Whether a path exists on disk. */
function exists(fsPath: string): Promise<boolean> {
  return stat(fsPath).then(
    () => true,
    () => false,
  );
}

/**
 * Per-file review state.
 *
 * - `lastSeen`: each file's content as last seen on disk (memory only).
 * - `snapshots`: for files with pending changes, the content from just before
 *   the first agent change. Everything that differs from it is reviewed. The
 *   snapshot is deleted once nothing differs (all accepted / rejected).
 *   Saved in VS Code's per-workspace storage so reviews survive restarts;
 *   the storage is cleared when nothing is pending.
 * - `deleted`: files with a snapshot whose pending change is that the agent
 *   deleted them. Their snapshot is the content before the deletion.
 *
 * Files never seen this session fall back to a git tree of the whole working
 * tree taken at startup (via a temporary index; the real index is untouched).
 */
class ReviewState implements vscode.Disposable {
  readonly lastSeen = new Map<string, string>();
  private snapshots = new Map<string, string>();
  private deleted = new Set<string>();
  private indexLock = '';
  private startTree = '';
  private startPaths = new Set<string>();
  private ignored = new Map<string, boolean>();

  private _onDidChangeSnapshots = new vscode.EventEmitter<void>();
  /** Fires when a snapshot is created, updated, or deleted. */
  readonly onDidChangeSnapshots = this._onDidChangeSnapshots.event;

  constructor(
    readonly repoRoot: string,
    private storage: vscode.Memento,
  ) {}

  /** Record the working tree as it is at startup, and restore saved snapshots. */
  async init(): Promise<void> {
    const tmpIndex = path.join(tmpdir(), `interactive-diff-index-${process.pid}-${Date.now()}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      await git(this.repoRoot, ['add', '-A'], env);
      this.startTree = (await git(this.repoRoot, ['write-tree'], env)).trim();
      const list = await git(this.repoRoot, ['ls-tree', '-r', '--name-only', '-z', this.startTree]);
      this.startPaths = new Set(list.split('\0').filter(Boolean));
    } finally {
      await rm(tmpIndex, { force: true });
    }
    this.indexLock = path.resolve(
      this.repoRoot,
      (await git(this.repoRoot, ['rev-parse', '--git-path', 'index.lock'])).trim(),
    );

    // .env files are usually .gitignored, so the startup tree doesn't have
    // them. Remember their startup content directly so changes are tracked.
    for (const uri of await vscode.workspace.findFiles('**/.env', '**/node_modules/**')) {
      const rel = this.relPathOf(uri);
      const text = await readFile(uri.fsPath, 'utf8').catch(() => null);
      if (rel !== undefined && text !== null) {
        this.lastSeen.set(rel, text);
      }
    }

    // Restore saved snapshots for this repo, dropping any that no longer apply
    // (file deleted, now .gitignored, or it already matches its snapshot).
    const stored = this.storage.get<StoredSnapshots>(STORAGE_KEY);
    if (stored?.repoRoot === this.repoRoot) {
      const deleted = new Set(stored.deleted ?? []);
      for (const [rel, snapshot] of Object.entries(stored.files)) {
        if (!(await this.isReviewed(rel))) {
          continue;
        }
        if (deleted.has(rel) && !(await exists(this.uri(rel).fsPath))) {
          this.snapshots.set(rel, snapshot);
          this.deleted.add(rel);
          continue;
        }
        const current = await readFile(this.uri(rel).fsPath, 'utf8').catch(() => null);
        if (current !== null && current !== snapshot) {
          this.snapshots.set(rel, snapshot);
        }
      }
    }
    debug(
      `init: startup tree has ${this.startPaths.size} files; restored ${this.snapshots.size} pending review(s)`,
    );
    await this.persist();
  }

  getSnapshot(rel: string): string | undefined {
    return this.snapshots.get(rel);
  }

  /** Repo-relative paths of all files with pending changes, sorted. */
  pendingFiles(): string[] {
    return [...this.snapshots.keys()].sort();
  }

  setSnapshot(rel: string, text: string): void {
    debug(`${rel}: review ${this.snapshots.has(rel) ? 'updated' : 'started'}`);
    this.snapshots.set(rel, text);
    this.deleted.delete(rel);
    void this.persist();
    this._onDidChangeSnapshots.fire();
  }

  deleteSnapshot(rel: string): void {
    this.deleted.delete(rel);
    if (this.snapshots.delete(rel)) {
      debug(`${rel}: review cleared`);
      void this.persist();
      this._onDidChangeSnapshots.fire();
    }
  }

  /** Whether a file's pending change is that the agent deleted it. */
  isDeleted(rel: string): boolean {
    return this.deleted.has(rel);
  }

  /** Record that the agent deleted a file whose content was `before`. */
  markDeleted(rel: string, before: string): void {
    debug(`${rel}: deletion review started`);
    this.snapshots.set(rel, before);
    this.deleted.add(rel);
    void this.persist();
    this._onDidChangeSnapshots.fire();
  }

  /** The file exists again: its review (if any) becomes a normal content review. */
  clearDeleted(rel: string): void {
    if (this.deleted.delete(rel)) {
      void this.persist();
      this._onDidChangeSnapshots.fire();
    }
  }

  /** Paths with a snapshot or remembered content at or under `rel` (file or folder). */
  knownUnder(rel: string): string[] {
    const keys = new Set([...this.snapshots.keys(), ...this.lastSeen.keys()]);
    return [...keys].filter((k) => k === rel || k.startsWith(rel + '/'));
  }

  /**
   * Whether source control (not an agent) removed a file: a git operation is
   * running (index lock held), or git no longer stages the file but HEAD still
   * has it (git rm).
   */
  async deletedBySourceControl(rel: string): Promise<boolean> {
    if (await exists(this.indexLock)) {
      return true;
    }
    const has = (ref: string) =>
      git(this.repoRoot, ['cat-file', '-e', ref]).then(
        () => true,
        () => false,
      );
    return !(await has(`:${rel}`)) && (await has(`HEAD:${rel}`));
  }

  /** Repo-relative path for a document, or undefined if it isn't a file in the repo. */
  relPath(doc: vscode.TextDocument): string | undefined {
    return this.relPathOf(doc.uri);
  }

  /** Repo-relative path for a URI, or undefined if it isn't a file in the repo. */
  relPathOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const rel = path.relative(this.repoRoot, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(path.sep).join('/');
  }

  uri(rel: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.repoRoot, rel));
  }

  /**
   * Last known disk content of a file: as last seen this session, else as it
   * was at startup, else empty (new file). Undefined for files that aren't
   * reviewed (see `isReviewed`).
   */
  async knownContent(rel: string): Promise<string | undefined> {
    if (!(await this.isReviewed(rel))) {
      return undefined;
    }
    const seen = this.lastSeen.get(rel);
    if (seen !== undefined) {
      return seen;
    }
    if (this.startPaths.has(rel)) {
      return git(this.repoRoot, ['cat-file', 'blob', `${this.startTree}:${rel}`]);
    }
    return '';
  }

  /** Save snapshots to workspace storage; removes the entry when nothing is pending. */
  private persist(): Thenable<void> {
    const value: StoredSnapshots | undefined =
      this.snapshots.size === 0
        ? undefined
        : {
            repoRoot: this.repoRoot,
            files: Object.fromEntries(this.snapshots),
            deleted: [...this.deleted],
          };
    return this.storage.update(STORAGE_KEY, value);
  }

  /**
   * Whether `text` is exactly git's version of the file: staged (index) or
   * last commit (HEAD). A disk change to such content came from source
   * control (discard, checkout, pull, stash), not an agent.
   */
  async matchesGit(rel: string, text: string): Promise<boolean> {
    for (const ref of [`:${rel}`, `HEAD:${rel}`]) {
      const version = await git(this.repoRoot, ['cat-file', 'blob', ref]).catch(() => null);
      if (version === text) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a file takes part in reviews: never inside `.git` or
   * `node_modules`; `.env` files always; otherwise only if not .gitignored.
   */
  async isReviewed(rel: string): Promise<boolean> {
    if (isInternalPath(rel)) {
      return false;
    }
    if (path.posix.basename(rel) === '.env') {
      return true;
    }
    return !(await this.isIgnored(rel));
  }

  /**
   * A .gitignore changed: forget cached ignore results and drop reviews and
   * remembered content of files that are no longer reviewed.
   */
  async recheckIgnored(): Promise<void> {
    this.ignored.clear();
    for (const rel of [...this.snapshots.keys()]) {
      if (!(await this.isReviewed(rel))) {
        this.deleteSnapshot(rel);
      }
    }
    for (const rel of [...this.lastSeen.keys()]) {
      if (!(await this.isReviewed(rel))) {
        this.lastSeen.delete(rel);
      }
    }
  }

  private async isIgnored(rel: string): Promise<boolean> {
    let result = this.ignored.get(rel);
    if (result === undefined) {
      // Exit code 1 = not ignored. 0 = ignored; anything else is an error
      // (e.g. path inside a nested repo), treated as ignored to stay safe.
      result = await git(this.repoRoot, ['check-ignore', '-q', rel]).then(
        () => true,
        (err: { code?: unknown }) => err.code !== 1,
      );
      this.ignored.set(rel, result);
    }
    return result;
  }

  dispose(): void {
    this._onDidChangeSnapshots.dispose();
  }
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) =>
        err
          ? reject(Object.assign(new Error(stderr || err.message), { code: err.code }))
          : resolve(stdout),
    );
  });
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

interface FileReview {
  rel: string;
  snapshot: string;
  hunks: Hunk[];
}

/** Line where a hunk's Accept / Reject appears (0-based). */
function hunkLine(doc: vscode.TextDocument, hunk: Hunk): number {
  return Math.min(hunk.newStart, doc.lineCount - 1);
}

/**
 * HTML for an inset showing deleted lines in red, styled like editor lines.
 * Long lines wrap. The inset is `rows` editor lines tall, so one editor line
 * is the inset height / `rows`; the script measures how many rows the wrapped
 * text needs and posts `{ rows }` back whenever that differs, so the inset can
 * be recreated at the right height (insets can't be resized in place).
 */
function deletedLinesHtml(lines: string[], rows: number): string {
  const escape = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;';
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
  body {
    --lh: calc(100vh / ${rows});
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    font-weight: var(--vscode-editor-font-weight);
  }
  #c > div {
    min-height: var(--lh); line-height: var(--lh);
    white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.2));
  }
</style></head><body><div id="c">${lines.map((l) => `<div>${escape(l)}</div>`).join('')}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('c');
  let reported = ${rows};
  const measure = () => {
    const lh = window.innerHeight / ${rows};
    if (!lh) return;
    document.body.style.setProperty('--lh', lh + 'px');
    const needed = Math.max(1, Math.round(content.getBoundingClientRect().height / lh));
    if (needed !== reported) {
      reported = needed;
      vscode.postMessage({ rows: needed });
    }
  };
  new ResizeObserver(measure).observe(content);
  window.addEventListener('resize', measure);
  measure();
</script></body></html>`;
}

/**
 * Draws pending changes in regular editors: green background on added lines,
 * deleted lines as red blocks between editor lines (proposed `editorInsets`
 * API), and Accept / Reject CodeLens above each change. If the proposed API
 * isn't enabled, deletions fall back to a red line with the text on hover.
 */
class ReviewOverlay implements vscode.CodeLensProvider, vscode.Disposable {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  });

  private removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
  });

  /** Orange mark in the scrollbar (overview ruler) for every pending change. */
  private marker = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: '#ff8c00',
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  /** Whether the proposed `editorInsets` API is enabled; set false on first failure. */
  private insetsEnabled = true;
  /** Current deleted-line insets per editor, with a key describing what they show. */
  private insets = new Map<
    vscode.TextEditor,
    { key: string; insets: vscode.WebviewEditorInset[] }
  >();
  /**
   * Measured row counts (after wrapping) per editor, keyed by the deleted text,
   * so recreated insets start at the right height instead of flickering.
   */
  private rowCache = new WeakMap<vscode.TextEditor, Map<string, number>>();

  constructor(private state: ReviewState) {}

  /** Pending changes for a document, or undefined if it has no snapshot. */
  review(doc: vscode.TextDocument): FileReview | undefined {
    const rel = this.state.relPath(doc);
    const snapshot = rel === undefined ? undefined : this.state.getSnapshot(rel);
    if (rel === undefined || snapshot === undefined || this.state.isDeleted(rel)) {
      return undefined;
    }
    return { rel, snapshot, hunks: computeHunks(snapshot, doc.getText()) };
  }

  refresh(): void {
    const visible = vscode.window.visibleTextEditors;
    for (const editor of [...this.insets.keys()]) {
      if (!visible.includes(editor)) {
        this.clearInsets(editor);
      }
    }
    for (const editor of visible) {
      this.decorate(editor);
    }
    this._onDidChangeCodeLenses.fire();
  }

  private clearInsets(editor: vscode.TextEditor): void {
    this.insets.get(editor)?.insets.forEach((i) => i.dispose());
    this.insets.delete(editor);
  }

  /**
   * Show each deletion as a red block directly above where it was removed.
   * Insets are only recreated when the deletions change. Returns false if the
   * proposed API isn't available.
   */
  private showDeletedInsets(editor: vscode.TextEditor, hunks: Hunk[]): boolean {
    if (!this.insetsEnabled) {
      return false;
    }
    const deletions = hunks
      .filter((h) => h.oldLines.length > 0)
      .map((h) => ({
        line: h.newStart - 1,
        lines: h.oldLines.map((l) => l.replace(/\r?\n$/, '')),
      }));
    const key = JSON.stringify(deletions);
    if (this.insets.get(editor)?.key === key) {
      return true;
    }
    this.clearInsets(editor);

    // Keep only cached row counts for deletions still shown.
    const oldCache = this.rowCache.get(editor);
    const cache = new Map<string, number>();
    for (const d of deletions) {
      const k = JSON.stringify(d.lines);
      const rows = oldCache?.get(k);
      if (rows !== undefined) {
        cache.set(k, rows);
      }
    }
    this.rowCache.set(editor, cache);

    const entry = { key, insets: [] as vscode.WebviewEditorInset[] };
    const create = (d: (typeof deletions)[number], rows: number): vscode.WebviewEditorInset => {
      const inset = vscode.window.createWebviewTextEditorInset(editor, d.line, rows, {
        enableScripts: true,
      });
      inset.webview.html = deletedLinesHtml(d.lines, rows);
      // The webview reports how many rows its wrapped text needs; recreate the
      // inset at that height (insets can't be resized).
      inset.webview.onDidReceiveMessage((msg: { rows?: unknown }) => {
        const want = msg?.rows;
        if (typeof want !== 'number' || !Number.isInteger(want) || want < 1) {
          return;
        }
        const i = entry.insets.indexOf(inset);
        if (want === inset.height || this.insets.get(editor) !== entry || i < 0) {
          return;
        }
        cache.set(JSON.stringify(d.lines), want);
        entry.insets[i] = create(d, want);
        inset.dispose();
      });
      inset.onDidDispose(() => {
        if (this.insets.get(editor)?.insets.includes(inset)) {
          this.insets.delete(editor);
        }
      });
      return inset;
    };

    try {
      for (const d of deletions) {
        const rows = cache.get(JSON.stringify(d.lines)) ?? d.lines.length;
        entry.insets.push(create(d, rows));
      }
    } catch {
      entry.insets.forEach((i) => i.dispose());
      this.insetsEnabled = false;
      return false;
    }
    this.insets.set(editor, entry);
    return true;
  }

  private decorate(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const markers: vscode.Range[] = [];
    const hunks = this.review(doc)?.hunks ?? [];
    const insetsShown = this.showDeletedInsets(editor, hunks);

    for (const hunk of hunks) {
      if (hunk.newLines.length > 0) {
        const last = hunk.newStart + hunk.newLines.length - 1;
        added.push({ range: new vscode.Range(hunk.newStart, 0, last, 0) });
        markers.push(new vscode.Range(hunk.newStart, 0, last, 0));
      } else {
        const line = hunkLine(doc, hunk);
        markers.push(new vscode.Range(line, 0, line, 0));
      }
      if (hunk.oldLines.length > 0 && !insetsShown) {
        const line = hunkLine(doc, hunk);
        const hover = new vscode.MarkdownString();
        hover.appendCodeblock(hunk.oldLines.join('').replace(/\r?\n$/, ''), doc.languageId);
        removed.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage: hover });
      }
    }

    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.marker, markers);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const review = this.review(doc);
    for (const hunk of review?.hunks ?? []) {
      const line = hunkLine(doc, hunk);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Accept',
          command: 'interactiveDiff.acceptHunk',
          arguments: [doc.uri, hunk],
        }),
        new vscode.CodeLens(range, {
          title: 'Reject',
          command: 'interactiveDiff.rejectHunk',
          arguments: [doc.uri, hunk],
        }),
      );
      // Brand-new file, nothing accepted yet: the whole file is this one change.
      if (review?.snapshot === '') {
        lenses.push(
          new vscode.CodeLens(range, {
            title: 'Delete',
            command: 'interactiveDiff.deleteHunk',
            arguments: [doc.uri, hunk],
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    [...this.insets.keys()].forEach((e) => this.clearInsets(e));
    this.added.dispose();
    this.removed.dispose();
    this.marker.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}

// ─── Side panel ──────────────────────────────────────────────────────────────

/** Lists files with pending changes. Clicking one opens it at its first change. */
class PendingFilesProvider implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private state: ReviewState) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: string): string[] {
    return element ? [] : this.state.pendingFiles();
  }

  getTreeItem(rel: string): vscode.TreeItem {
    const item = new vscode.TreeItem(this.state.uri(rel));
    const dir = path.posix.dirname(rel);
    const deleted = this.state.isDeleted(rel);
    item.description = [deleted ? 'deleted' : '', dir === '.' ? '' : dir]
      .filter(Boolean)
      .join(' · ');
    if (deleted) {
      item.tooltip = `${rel} (deleted by the agent)`;
    }
    item.command = { command: 'interactiveDiff.openPending', title: 'Open', arguments: [rel] };
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ─── Deleted files ───────────────────────────────────────────────────────────

/** Scheme for read-only views of deleted files: `?old` = content before, `?empty` = nothing. */
const DELETED_SCHEME = 'interactive-diff-deleted';

function deletedUri(rel: string, side: 'old' | 'empty'): vscode.Uri {
  return vscode.Uri.from({ scheme: DELETED_SCHEME, path: '/' + rel, query: side });
}

/** Repo-relative path shown by a deleted-file view URI, or undefined for other URIs. */
function relOfDeletedUri(uri: vscode.Uri | undefined): string | undefined {
  return uri?.scheme === DELETED_SCHEME ? uri.path.slice(1) : undefined;
}

// ─── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Universal Agent Diff', { log: true });
  context.subscriptions.push(log);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders[0];
  if (!folder) {
    debug('activate: no workspace folder, not running');
    return;
  }
  const repoRoot = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
  debug(
    `activate: repo "${path.basename(repoRoot)}"; ${folders.length} workspace folder(s)` +
      (folders.length > 1 ? ' (only the first is watched)' : ''),
  );
  const state = new ReviewState(repoRoot, context.workspaceState);
  await state.init();
  const overlay = new ReviewOverlay(state);
  const pending = new PendingFilesProvider(state);
  const panel = vscode.window.createTreeView('interactiveDiff.pending', {
    treeDataProvider: pending,
  });

  /** Refresh the side panel list and its badge (number of pending files). */
  const updatePanel = () => {
    pending.refresh();
    const count = state.pendingFiles().length;
    panel.badge =
      count > 0
        ? { value: count, tooltip: `${count} file${count === 1 ? '' : 's'} pending review` }
        : undefined;
  };
  updatePanel();

  /** Delete a file's snapshot once nothing differs from it. */
  const clearIfDone = (doc: vscode.TextDocument) => {
    const review = overlay.review(doc);
    if (review && review.hunks.length === 0) {
      state.deleteSnapshot(review.rel);
      if (!doc.isDirty) {
        state.lastSeen.set(review.rel, doc.getText());
      }
    }
  };

  /**
   * A document was opened. If it differs from its last known disk content,
   * something outside VS Code (an agent) changed it: start a snapshot.
   */
  const onOpen = async (doc: vscode.TextDocument) => {
    const rel = state.relPath(doc);
    if (rel === undefined || doc.isDirty || state.getSnapshot(rel) !== undefined) {
      if (rel !== undefined) {
        debug(`${rel}: opened, skipped (${doc.isDirty ? 'unsaved edits' : 'review already open'})`);
      }
      return;
    }
    const known = await state.knownContent(rel);
    if (known === undefined) {
      debug(`${rel}: opened, not reviewed (.gitignored, .git or node_modules)`);
      return;
    }
    const text = doc.getText();
    if (text !== known) {
      debug(`${rel}: opened, differs from last known content → agent change`);
      state.setSnapshot(rel, known);
    }
    state.lastSeen.set(rel, text);
    overlay.refresh();
  };

  /**
   * A document's text changed. If VS Code reloaded it from disk and it now
   * matches git's version, source control restored it (not an agent), so any
   * review is discarded. Otherwise it's an agent change only if VS Code reloaded
   * it from disk: the editor text now matches the file on disk, and that
   * differs from the disk content we last saw. Typing never matches the disk
   * (it's unsaved), so it's never mistaken for an agent. `isDirty` alone isn't
   * reliable: on the first keystroke after a save it can still read false.
   * If there's no snapshot yet, start one from the content before the change.
   * Any other change (typing, our Reject) is just part of the review.
   */
  const onChange = async (e: vscode.TextDocumentChangeEvent) => {
    const doc = e.document;
    const rel = state.relPath(doc);
    if (rel === undefined || e.contentChanges.length === 0) {
      return;
    }
    if (!(await state.isReviewed(rel))) {
      debug(`${rel}: edited, not reviewed (.gitignored, .git or node_modules)`);
      return;
    }
    const text = doc.getText();
    let fromDisk = false;
    let diskInfo = 'disk not checked';
    if (!doc.isDirty && e.reason === undefined) {
      const disk = await readFile(doc.uri.fsPath, 'utf8').catch(() => null);
      fromDisk = disk === text && disk !== state.lastSeen.get(rel);
      diskInfo =
        disk === null
          ? 'disk unreadable'
          : `matches disk=${disk === text}, differs from last seen=${disk !== state.lastSeen.get(rel)}`;
    }
    const info =
      `dirty=${doc.isDirty}, reason=${e.reason ?? 'none'}, ` +
      `active editor=${vscode.window.activeTextEditor?.document === doc}, ` +
      `visible=${vscode.window.visibleTextEditors.some((ed) => ed.document === doc)}, ${diskInfo}`;
    if (fromDisk && (await state.matchesGit(rel, text))) {
      // Source control restored the file: not an agent; discard any review.
      debug(`${rel}: edited (${info}) → reloaded from disk, matches git → source control`);
      state.deleteSnapshot(rel);
      state.lastSeen.set(rel, text);
    } else if (fromDisk) {
      debug(`${rel}: edited (${info}) → reloaded from disk → agent change`);
      if (state.getSnapshot(rel) === undefined) {
        const before = state.lastSeen.get(rel) ?? (await state.knownContent(rel));
        if (before !== undefined && before !== text) {
          state.setSnapshot(rel, before);
        }
      }
      state.lastSeen.set(rel, text);
    } else {
      debug(
        `${rel}: edited (${info}) → treated as my edit` +
          (state.getSnapshot(rel) === undefined
            ? ', no open review → ignored'
            : ', joins open review'),
      );
    }
    clearIfDone(doc);
    overlay.refresh();
  };

  /**
   * A file changed or was created on disk. Files open in VS Code are handled
   * by `onChange` (VS Code reloads them); this covers files that aren't open.
   * If the file differs from its last known content and has no snapshot yet,
   * that content becomes the snapshot, so it shows up as pending right away.
   */
  const onDiskChange = async (uri: vscode.Uri) => {
    const rel = state.relPathOf(uri);
    if (rel === undefined || isInternalPath(rel)) {
      return;
    }
    state.clearDeleted(rel);
    if (path.basename(uri.fsPath) === '.gitignore') {
      await state.recheckIgnored();
      overlay.refresh();
    }
    if (!(await state.isReviewed(rel))) {
      debug(`${rel}: changed on disk, not reviewed (.gitignored, .git or node_modules)`);
      return;
    }
    if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === uri.fsPath)) {
      debug(`${rel}: changed on disk, open in VS Code → left to the editor change handler`);
      return;
    }
    const current = await readFile(uri.fsPath, 'utf8').catch(() => null);
    if (current === null || current.includes('\0')) {
      debug(`${rel}: changed on disk, skipped (folder, unreadable or binary)`);
      return;
    }
    if (await state.matchesGit(rel, current)) {
      // Source control restored the file: not an agent; discard any review.
      debug(`${rel}: changed on disk, matches git → source control`);
      state.deleteSnapshot(rel);
      state.lastSeen.set(rel, current);
      return;
    }
    const snapshot = state.getSnapshot(rel);
    if (snapshot === undefined) {
      const before = await state.knownContent(rel);
      if (before === undefined) {
        return; // .gitignored
      }
      if (before !== current) {
        debug(`${rel}: changed on disk → agent change`);
        state.setSnapshot(rel, before);
      } else {
        debug(`${rel}: changed on disk, same as last known content → nothing to review`);
      }
    } else if (snapshot === current) {
      state.deleteSnapshot(rel);
    }
    state.lastSeen.set(rel, current);
  };

  /** Paths being deleted by VS Code itself (Explorer, our Reject / Delete); kept for 5s. */
  const ownDeletes = new Set<string>();
  const isOwnDelete = (fsPath: string) =>
    [...ownDeletes].some((p) => fsPath === p || fsPath.startsWith(p + path.sep));

  /**
   * A file or folder was deleted on disk. Deletions by an agent become a
   * review (restorable with Reject) for each file whose previous content is
   * known. Deletions made in VS Code, by source control, of files the agent
   * just created (nothing to restore), or of unreviewed files are dropped.
   */
  const onDiskDelete = async (uri: vscode.Uri) => {
    const rel = state.relPathOf(uri);
    if (rel === undefined || isInternalPath(rel)) {
      return;
    }
    if (path.basename(uri.fsPath) === '.gitignore') {
      await state.recheckIgnored();
    }
    const own = isOwnDelete(uri.fsPath);
    // A deleted folder may only report itself: also check the files under it.
    const tracked = await git(repoRoot, ['ls-files', '-z', '--', rel]).then(
      (out) => out.split('\0').filter(Boolean),
      () => [],
    );
    for (const r of new Set([rel, ...tracked, ...state.knownUnder(rel)])) {
      if (await exists(state.uri(r).fsPath)) {
        continue;
      }
      const reviewed = await state.isReviewed(r);
      const bySourceControl = !own && reviewed && (await state.deletedBySourceControl(r));
      const agent = !own && reviewed && !bySourceControl;
      const before = agent ? (state.getSnapshot(r) ?? (await state.knownContent(r))) : undefined;
      // Short-lived files never seen before (e.g. an agent's temp file during
      // an atomic save) have nothing to restore or clear: don't log them.
      const unseen = state.getSnapshot(r) === undefined && !state.lastSeen.has(r);
      if (!(agent && !before && unseen)) {
        debug(
          `${r}: deleted → ` +
            (own
              ? 'by VS Code itself, ignored'
              : !reviewed
                ? 'not reviewed, ignored'
                : bySourceControl
                  ? 'by source control, ignored'
                  : before
                    ? 'agent deletion'
                    : 'agent deletion, nothing to restore (new or empty file)'),
        );
      }
      if (before) {
        state.markDeleted(r, before);
      } else {
        state.deleteSnapshot(r);
      }
      state.lastSeen.delete(r);
    }
    overlay.refresh();
  };

  /** Show a deleted file's old content (all red) in a read-only diff. */
  const showDeleted = (rel: string) =>
    vscode.commands.executeCommand(
      'vscode.diff',
      deletedUri(rel, 'old'),
      deletedUri(rel, 'empty'),
      `${path.posix.basename(rel)} (deleted)`,
      { preview: false },
    );

  /** Close any open views of a deleted file. */
  const closeDeletedViews = async (rel: string) => {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => {
        const input = t.input;
        const uri =
          input instanceof vscode.TabInputTextDiff
            ? input.original
            : input instanceof vscode.TabInputText
              ? input.uri
              : undefined;
        return relOfDeletedUri(uri) === rel;
      });
    await vscode.window.tabGroups.close(tabs);
  };

  /** Accept (keep deleted) or Reject (restore) a deletion from its view, then move on. */
  const resolveDeleted = async (keep: boolean, uri?: vscode.Uri) => {
    const rel = relOfDeletedUri(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (rel === undefined || !state.isDeleted(rel)) {
      return;
    }
    await (keep ? acceptFile(rel) : rejectFile(rel));
    await closeDeletedViews(rel);
    if (state.pendingFiles().length > 0) {
      await goToChange(1);
    }
  };

  const deletedContent = new vscode.EventEmitter<vscode.Uri>();

  /** Open document for a repo-relative path, if VS Code has it loaded. */
  const openDoc = (rel: string) => {
    const fsPath = state.uri(rel).fsPath;
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  };

  /** Accept every pending change in a file: keep it as is and clear its review. */
  const acceptFile = async (rel: string) => {
    debug(`${rel}: accept all`);
    state.deleteSnapshot(rel);
    const disk = await readFile(state.uri(rel).fsPath, 'utf8').catch(() => null);
    if (disk !== null) {
      state.lastSeen.set(rel, disk);
    }
    overlay.refresh();
  };

  /**
   * Reject every pending change in a file: restore its snapshot and save.
   * A file the agent created (empty snapshot) is deleted instead. Open files
   * are restored with a normal editor edit, so Cmd+Z undoes it.
   */
  const rejectFile = async (rel: string) => {
    const snapshot = state.getSnapshot(rel);
    if (snapshot === undefined) {
      return;
    }
    debug(`${rel}: reject all`);
    const uri = state.uri(rel);
    const doc = openDoc(rel);
    const wasDeleted = state.isDeleted(rel);
    // Clear the review first so our own write isn't seen as an agent change.
    state.deleteSnapshot(rel);
    state.lastSeen.set(rel, snapshot);

    if (snapshot === '') {
      const edit = new vscode.WorkspaceEdit();
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(edit);
      state.lastSeen.delete(rel);
    } else if (doc && !wasDeleted) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), snapshot);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot, 'utf8'));
    }
    overlay.refresh();
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(repoRoot, '**/*'),
  );

  /** Re-diff the document and return the clicked hunk only if it still exists unchanged. */
  const findHunk = async (uri: vscode.Uri, clicked: Hunk) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const review = overlay.review(doc);
    const hunk = review?.hunks.find(
      (h) =>
        h.oldStart === clicked.oldStart &&
        h.newStart === clicked.newStart &&
        h.oldLines.join('') === clicked.oldLines.join('') &&
        h.newLines.join('') === clicked.newLines.join(''),
    );
    return review && hunk ? { doc, review, hunk } : undefined;
  };

  /** Open a file and put the cursor on the given line. */
  const showLine = async (uri: vscode.Uri, line: number) => {
    const editor = await vscode.window.showTextDocument(uri, { preview: false });
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  };

  /** Open a pending file at its first change. */
  const openPending = async (rel: string, atLast = false) => {
    if (state.isDeleted(rel)) {
      await showDeleted(rel);
      return;
    }
    const uri = state.uri(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hunks = overlay.review(doc)?.hunks ?? [];
    const target = atLast ? hunks[hunks.length - 1] : hunks[0];
    await showLine(uri, target ? hunkLine(doc, target) : 0);
  };

  /**
   * Go to the next (or previous) pending change from the cursor. Stays in the
   * current file until it has none left, wrapping around within it. When the
   * file has no pending changes, open the next (or previous) pending file.
   */
  const goToChange = async (direction: 1 | -1) => {
    const editor = vscode.window.activeTextEditor;
    const review = editor && overlay.review(editor.document);
    if (editor && review && review.hunks.length > 0) {
      const lines = review.hunks.map((h) => hunkLine(editor.document, h));
      const from = editor.selection.active.line;
      const target =
        direction === 1
          ? (lines.find((l) => l > from) ?? lines[0])
          : ([...lines].reverse().find((l) => l < from) ?? lines[lines.length - 1]);
      await showLine(editor.document.uri, target);
      return;
    }
    const files = state.pendingFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('Universal Agent Diff: no pending changes.');
      return;
    }
    const current = editor
      ? (state.relPath(editor.document) ?? relOfDeletedUri(editor.document.uri))
      : undefined;
    if (direction === 1) {
      await openPending(files.find((f) => current === undefined || f > current) ?? files[0]);
    } else {
      const prev = [...files].reverse().find((f) => current === undefined || f < current);
      await openPending(prev ?? files[files.length - 1], true);
    }
  };

  /**
   * After a change is accepted or rejected, go to the next pending change in
   * the same file: the first one starting at or after `boundary` (the line just
   * past the handled change), wrapping around. If the file has none left, open
   * the next pending file, if any.
   */
  const jumpToNext = async (doc: vscode.TextDocument, boundary: number) => {
    const hunks = overlay.review(doc)?.hunks ?? [];
    if (hunks.length > 0) {
      const next = hunks.find((h) => h.newStart >= boundary) ?? hunks[0];
      await showLine(doc.uri, hunkLine(doc, next));
    } else if (state.pendingFiles().length > 0) {
      await goToChange(1);
    }
  };

  context.subscriptions.push(
    state,
    overlay,
    pending,
    panel,
    watcher,
    watcher.onDidChange(onDiskChange),
    watcher.onDidCreate(onDiskChange),
    watcher.onDidDelete(onDiskDelete),
    vscode.workspace.onWillDeleteFiles((e) => {
      for (const f of e.files) {
        ownDeletes.add(f.fsPath);
        setTimeout(() => ownDeletes.delete(f.fsPath), 5000);
      }
    }),
    deletedContent,
    vscode.workspace.registerTextDocumentContentProvider(DELETED_SCHEME, {
      onDidChange: deletedContent.event,
      provideTextDocumentContent: (uri) => {
        const rel = relOfDeletedUri(uri);
        return uri.query === 'old' && rel !== undefined ? (state.getSnapshot(rel) ?? '') : '';
      },
    }),
    state.onDidChangeSnapshots(() => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === DELETED_SCHEME) {
          deletedContent.fire(doc.uri);
        }
      }
    }),
    vscode.commands.registerCommand('interactiveDiff.acceptDeletion', (uri?: vscode.Uri) =>
      resolveDeleted(true, uri),
    ),
    vscode.commands.registerCommand('interactiveDiff.restoreFile', (uri?: vscode.Uri) =>
      resolveDeleted(false, uri),
    ),
    state.onDidChangeSnapshots(updatePanel),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, overlay),
    vscode.window.onDidChangeVisibleTextEditors(() => overlay.refresh()),
    vscode.workspace.onDidOpenTextDocument(onOpen),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = state.relPath(doc);
      if (rel !== undefined) {
        debug(
          `${rel}: saved in VS Code → recorded as last seen` +
            (state.getSnapshot(rel) === undefined ? ' (no open review)' : ''),
        );
        state.lastSeen.set(rel, doc.getText());
      }
    }),

    vscode.commands.registerCommand('interactiveDiff.nextChange', () => goToChange(1)),
    vscode.commands.registerCommand('interactiveDiff.prevChange', () => goToChange(-1)),
    vscode.commands.registerCommand('interactiveDiff.openPending', openPending),
    vscode.commands.registerCommand('interactiveDiff.acceptFile', acceptFile),
    vscode.commands.registerCommand('interactiveDiff.rejectFile', rejectFile),

    vscode.commands.registerCommand(
      'interactiveDiff.acceptHunk',
      async (uri: vscode.Uri, clicked: Hunk) => {
        const found = await findHunk(uri, clicked);
        if (found) {
          const { doc, review, hunk } = found;
          debug(`${review.rel}: accept change at line ${hunk.newStart + 1}`);
          state.setSnapshot(review.rel, applyHunk(review.snapshot, hunk));
          clearIfDone(doc);
          overlay.refresh();
          await jumpToNext(doc, hunk.newStart + hunk.newLines.length);
          return;
        }
        overlay.refresh();
      },
    ),

    vscode.commands.registerCommand(
      'interactiveDiff.rejectHunk',
      async (uri: vscode.Uri, clicked: Hunk) => {
        const found = await findHunk(uri, clicked);
        if (found) {
          const { doc, review, hunk } = found;
          debug(`${review.rel}: reject change at line ${hunk.newStart + 1}`);
          const [start, end] = newRangeOffsets(doc.getText(), hunk);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            uri,
            new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
            hunk.oldLines.join(''),
          );
          await vscode.workspace.applyEdit(edit);
          await doc.save();
          clearIfDone(doc);
          overlay.refresh();
          await jumpToNext(doc, hunk.newStart + hunk.oldLines.length);
          return;
        }
        overlay.refresh();
      },
    ),

    // Only offered on a brand-new file (empty snapshot): delete the file.
    vscode.commands.registerCommand(
      'interactiveDiff.deleteHunk',
      async (uri: vscode.Uri, clicked: Hunk) => {
        const found = await findHunk(uri, clicked);
        if (found?.review.snapshot === '') {
          await rejectFile(found.review.rel);
          if (state.pendingFiles().length > 0) {
            await goToChange(1);
          }
          return;
        }
        overlay.refresh();
      },
    ),
  );

  for (const doc of vscode.workspace.textDocuments) {
    await onOpen(doc);
  }
  overlay.refresh();
}

export function deactivate() {}
