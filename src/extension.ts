import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { diffArrays } from 'diff';
import { readdir, readFile, rm, stat } from 'fs/promises';
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

/**
 * Env files hold secrets and are usually .gitignored, but agents edit them, so
 * they're always reviewed: `.env`, `.env.<anything>` (`.env.local`,
 * `.env.sandbox`, `.env.production`, …), `<anything>.env` (`prod.env`), and
 * direnv's `.envrc`. Keep `ENV_FILES_GLOB` in sync with `isEnvFile`.
 */
const ENV_FILES_GLOB = '**/{.env,.env.*,*.env,.envrc}';

function isEnvFile(rel: string): boolean {
  const name = path.posix.basename(rel);
  return name.endsWith('.env') || name.startsWith('.env.') || name === '.envrc';
}

/**
 * Storage key prefix; each repo stores its pending reviews under
 * `${STORAGE_KEY}:${repoRoot}`. Before multi-repo support (≤ 1.1.0) a single
 * repo used `STORAGE_KEY` itself; that entry is migrated on first load.
 */
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
 * The Git repos being reviewed: one per workspace folder (folders inside the
 * same repo share it). A file belongs to the deepest repo containing it, so a
 * repo nested inside another (both open as folders) is reviewed on its own.
 */
class Repos {
  private byRoot = new Map<string, ReviewState>();

  all(): ReviewState[] {
    return [...this.byRoot.values()];
  }

  get(repoRoot: string): ReviewState | undefined {
    return this.byRoot.get(repoRoot);
  }

  add(state: ReviewState): void {
    this.byRoot.set(state.repoRoot, state);
  }

  remove(repoRoot: string): void {
    this.byRoot.delete(repoRoot);
  }

  /** Whether more than one repo is open (file names in the UI and log then include the repo). */
  get multiple(): boolean {
    return this.byRoot.size > 1;
  }

  /** The repo a path on disk belongs to: the deepest one containing it. */
  ownerOf(fsPath: string): ReviewState | undefined {
    let owner: ReviewState | undefined;
    for (const state of this.byRoot.values()) {
      const rel = path.relative(state.repoRoot, fsPath);
      const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
      if (inside && (!owner || state.repoRoot.length > owner.repoRoot.length)) {
        owner = state;
      }
    }
    return owner;
  }

  /**
   * The repo and repo-relative path of a file, or undefined if it isn't in a
   * repo that's ready (a repo is still starting while it records its startup
   * state; changes before that are part of the startup state).
   */
  fileOf(uri: vscode.Uri): PendingFile | undefined {
    const state = uri.scheme === 'file' ? this.ownerOf(uri.fsPath) : undefined;
    const rel = state?.ready ? state.relPathOf(uri) : undefined;
    return state && rel !== undefined ? { state, rel } : undefined;
  }

  /** Every file with pending changes, ordered by repo, then path. */
  pendingFiles(): PendingFile[] {
    return this.all()
      .flatMap((state) => state.pendingFiles().map((rel) => ({ state, rel })))
      .sort(compareFiles);
  }
}

/** A file in a specific repo. */
interface PendingFile {
  state: ReviewState;
  rel: string;
}

const sameFile = (a: PendingFile | undefined, b: PendingFile | undefined) =>
  !!a && !!b && a.state === b.state && a.rel === b.rel;

/** Order files by repo, then by path. */
function compareFiles(a: PendingFile, b: PendingFile): number {
  const byRepo = a.state.repoRoot.localeCompare(b.state.repoRoot);
  return byRepo !== 0 ? byRepo : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
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

  private readonly storageKey: string;
  /** Set once `init` has recorded the startup state; until then changes aren't reviewed. */
  ready = false;

  constructor(
    readonly repoRoot: string,
    private storage: vscode.Memento,
    private repos: Repos,
  ) {
    this.storageKey = `${STORAGE_KEY}:${repoRoot}`;
  }

  /** The repo's folder name. */
  get name(): string {
    return path.basename(this.repoRoot);
  }

  /** How a file is named in the side panel and log: repo-relative, prefixed with the repo when several are open. */
  label(rel: string): string {
    return this.repos.multiple ? `${this.name}/${rel}` : rel;
  }

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

    // Env files are usually .gitignored, so the startup tree doesn't have
    // them. Remember their startup content directly so changes are tracked
    // (without it, an agent's first edit would look like a brand-new file).
    for (const uri of await vscode.workspace.findFiles(ENV_FILES_GLOB, '**/node_modules/**')) {
      const rel = this.relPathOf(uri);
      const text = await readFile(uri.fsPath, 'utf8').catch(() => null);
      if (rel !== undefined && isEnvFile(rel) && text !== null && !text.includes('\0')) {
        this.lastSeen.set(rel, text);
      }
    }

    // Restore saved snapshots for this repo, dropping any that no longer apply
    // (file deleted, now .gitignored, or it already matches its snapshot).
    const legacy = this.storage.get<StoredSnapshots>(STORAGE_KEY);
    const migrate = legacy !== undefined && path.resolve(legacy.repoRoot) === this.repoRoot;
    const stored =
      this.storage.get<StoredSnapshots>(this.storageKey) ?? (migrate ? legacy : undefined);
    if (stored && path.resolve(stored.repoRoot) === this.repoRoot) {
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
      `init "${this.name}": startup tree has ${this.startPaths.size} files; restored ${this.snapshots.size} pending review(s)`,
    );
    await this.persist();
    if (migrate) {
      await this.storage.update(STORAGE_KEY, undefined);
    }
    this.ready = true;
  }

  getSnapshot(rel: string): string | undefined {
    return this.snapshots.get(rel);
  }

  /** Repo-relative paths of all files with pending changes, sorted. */
  pendingFiles(): string[] {
    return [...this.snapshots.keys()].sort();
  }

  setSnapshot(rel: string, text: string): void {
    debug(`${this.label(rel)}: review ${this.snapshots.has(rel) ? 'updated' : 'started'}`);
    this.snapshots.set(rel, text);
    this.deleted.delete(rel);
    void this.persist();
    this._onDidChangeSnapshots.fire();
  }

  deleteSnapshot(rel: string): void {
    this.deleted.delete(rel);
    if (this.snapshots.delete(rel)) {
      debug(`${this.label(rel)}: review cleared`);
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
    debug(`${this.label(rel)}: deletion review started`);
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

  /**
   * Repo-relative path for a URI, or undefined if it isn't a file in this repo
   * (including files in a repo nested inside this one).
   */
  relPathOf(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' || this.repos.ownerOf(uri.fsPath) !== this) {
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
    return this.storage.update(this.storageKey, value);
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
   * `node_modules`; env files always (see `isEnvFile`); otherwise only if
   * not .gitignored.
   */
  async isReviewed(rel: string): Promise<boolean> {
    if (isInternalPath(rel)) {
      return false;
    }
    if (isEnvFile(rel)) {
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

/** Top-level folder of the Git repo containing `dir`, or undefined if it isn't in one. */
function repoRootOf(dir: string): Promise<string | undefined> {
  return git(dir, ['rev-parse', '--show-toplevel']).then(
    (out) => path.resolve(out.trim()),
    () => undefined,
  );
}

/** How deep (folders below a workspace folder) and how wide the nested-repo scan goes. */
const NESTED_REPO_MAX_DEPTH = 4;
const NESTED_REPO_MAX_FOLDERS = 5000;

/**
 * Git repos inside a folder, below it: any subfolder with a `.git` entry (a
 * folder, or a file for submodules and worktrees). Finds repos the folder's
 * own repo ignores or can't see into, e.g. a parent repo that .gitignores the
 * repos inside it. Skips `node_modules` and hidden folders, doesn't follow
 * symlinks, and stops after NESTED_REPO_MAX_DEPTH levels or
 * NESTED_REPO_MAX_FOLDERS folders so huge trees stay fast.
 */
async function findNestedRepos(folder: string): Promise<string[]> {
  const found: string[] = [];
  let level = [folder];
  let scanned = 0;
  for (let depth = 0; depth <= NESTED_REPO_MAX_DEPTH && level.length > 0; depth++) {
    level = level.slice(0, Math.max(0, NESTED_REPO_MAX_FOLDERS - scanned));
    scanned += level.length;
    const listings = await Promise.all(
      level.map((dir) =>
        readdir(dir, { withFileTypes: true }).then(
          (entries) => ({ dir, entries }),
          () => ({ dir, entries: [] }),
        ),
      ),
    );
    const next: string[] = [];
    for (const { dir, entries } of listings) {
      if (dir !== folder && entries.some((e) => e.name === '.git')) {
        found.push(dir);
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          next.push(path.join(dir, e.name));
        }
      }
    }
    level = next;
  }
  return found;
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
  state: ReviewState;
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

  constructor(private repos: Repos) {}

  /** Pending changes for a document, or undefined if it has no snapshot. */
  review(doc: vscode.TextDocument): FileReview | undefined {
    const file = this.repos.fileOf(doc.uri);
    if (!file) {
      return undefined;
    }
    const { state, rel } = file;
    const snapshot = state.getSnapshot(rel);
    if (snapshot === undefined || state.isDeleted(rel)) {
      return undefined;
    }
    return { state, rel, snapshot, hunks: computeHunks(snapshot, doc.getText()) };
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
class PendingFilesProvider implements vscode.TreeDataProvider<PendingFile>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private repos: Repos) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: PendingFile): PendingFile[] {
    return element ? [] : this.repos.pendingFiles();
  }

  getTreeItem(file: PendingFile): vscode.TreeItem {
    const { state, rel } = file;
    const item = new vscode.TreeItem(state.uri(rel));
    const label = state.label(rel);
    const dir = path.posix.dirname(label);
    const deleted = state.isDeleted(rel);
    item.description = [deleted ? 'deleted' : '', dir === '.' ? '' : dir]
      .filter(Boolean)
      .join(' · ');
    if (deleted) {
      item.tooltip = `${label} (deleted by the agent)`;
    }
    item.command = { command: 'interactiveDiff.openPending', title: 'Open', arguments: [file] };
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ─── Deleted files ───────────────────────────────────────────────────────────

/**
 * Scheme for read-only views of deleted files. The path is the repo-relative
 * file; the query holds `side` (`old` = content before, `empty` = nothing)
 * and `repo` (the repo root).
 */
const DELETED_SCHEME = 'interactive-diff-deleted';

function deletedUri(file: PendingFile, side: 'old' | 'empty'): vscode.Uri {
  const query = new URLSearchParams({ side, repo: file.state.repoRoot }).toString();
  return vscode.Uri.from({ scheme: DELETED_SCHEME, path: '/' + file.rel, query });
}

/** The file shown by a deleted-file view URI, or undefined for other URIs. */
function deletedFileOf(
  repos: Repos,
  uri: vscode.Uri | undefined,
): (PendingFile & { side: string }) | undefined {
  if (uri?.scheme !== DELETED_SCHEME) {
    return undefined;
  }
  const query = new URLSearchParams(uri.query);
  const state = repos.get(query.get('repo') ?? '');
  return state ? { state, rel: uri.path.slice(1), side: query.get('side') ?? '' } : undefined;
}

// ─── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Universal Agent Diff', { log: true });
  context.subscriptions.push(log);

  const repos = new Repos();
  /** Each repo's watcher and listeners, disposed when the repo is no longer open. */
  const repoDisposables = new Map<string, vscode.Disposable[]>();
  const overlay = new ReviewOverlay(repos);
  const pending = new PendingFilesProvider(repos);
  const panel = vscode.window.createTreeView('interactiveDiff.pending', {
    treeDataProvider: pending,
  });

  /** Refresh the side panel list and its badge (number of pending files). */
  const updatePanel = () => {
    pending.refresh();
    const count = repos.pendingFiles().length;
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
      review.state.deleteSnapshot(review.rel);
      if (!doc.isDirty) {
        review.state.lastSeen.set(review.rel, doc.getText());
      }
    }
  };

  /**
   * A document was opened. If it differs from its last known disk content,
   * something outside VS Code (an agent) changed it: start a snapshot.
   */
  const onOpen = async (doc: vscode.TextDocument) => {
    const file = repos.fileOf(doc.uri);
    if (!file) {
      return;
    }
    const { state, rel } = file;
    const name = state.label(rel);
    if (doc.isDirty || state.getSnapshot(rel) !== undefined) {
      debug(`${name}: opened, skipped (${doc.isDirty ? 'unsaved edits' : 'review already open'})`);
      return;
    }
    const known = await state.knownContent(rel);
    if (known === undefined) {
      debug(`${name}: opened, not reviewed (.gitignored, .git or node_modules)`);
      return;
    }
    const text = doc.getText();
    if (text !== known) {
      debug(`${name}: opened, differs from last known content → agent change`);
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
    const file = repos.fileOf(doc.uri);
    if (!file || e.contentChanges.length === 0) {
      return;
    }
    const { state, rel } = file;
    const name = state.label(rel);
    if (!(await state.isReviewed(rel))) {
      debug(`${name}: edited, not reviewed (.gitignored, .git or node_modules)`);
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
      debug(`${name}: edited (${info}) → reloaded from disk, matches git → source control`);
      state.deleteSnapshot(rel);
      state.lastSeen.set(rel, text);
    } else if (fromDisk) {
      debug(`${name}: edited (${info}) → reloaded from disk → agent change`);
      if (state.getSnapshot(rel) === undefined) {
        const before = state.lastSeen.get(rel) ?? (await state.knownContent(rel));
        if (before !== undefined && before !== text) {
          state.setSnapshot(rel, before);
        }
      }
      state.lastSeen.set(rel, text);
    } else {
      debug(
        `${name}: edited (${info}) → treated as my edit` +
          (state.getSnapshot(rel) === undefined
            ? ', no open review → ignored'
            : ', joins open review'),
      );
    }
    clearIfDone(doc);
    overlay.refresh();
  };

  /**
   * A file in `state`'s repo changed or was created on disk. Files open in VS
   * Code are handled by `onChange` (VS Code reloads them); this covers files
   * that aren't open. If the file differs from its last known content and has
   * no snapshot yet, that content becomes the snapshot, so it shows up as
   * pending right away.
   */
  const onDiskChange = async (state: ReviewState, uri: vscode.Uri) => {
    const rel = state.relPathOf(uri);
    if (rel === undefined || isInternalPath(rel)) {
      return;
    }
    const name = state.label(rel);
    state.clearDeleted(rel);
    if (path.basename(uri.fsPath) === '.gitignore') {
      await state.recheckIgnored();
      overlay.refresh();
    }
    if (!(await state.isReviewed(rel))) {
      debug(`${name}: changed on disk, not reviewed (.gitignored, .git or node_modules)`);
      return;
    }
    if (vscode.workspace.textDocuments.some((d) => d.uri.fsPath === uri.fsPath)) {
      debug(`${name}: changed on disk, open in VS Code → left to the editor change handler`);
      return;
    }
    const current = await readFile(uri.fsPath, 'utf8').catch(() => null);
    if (current === null || current.includes('\0')) {
      debug(`${name}: changed on disk, skipped (folder, unreadable or binary)`);
      return;
    }
    if (await state.matchesGit(rel, current)) {
      // Source control restored the file: not an agent; discard any review.
      debug(`${name}: changed on disk, matches git → source control`);
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
        debug(`${name}: changed on disk → agent change`);
        state.setSnapshot(rel, before);
      } else {
        debug(`${name}: changed on disk, same as last known content → nothing to review`);
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
   * A file or folder in `state`'s repo was deleted on disk. Deletions by an
   * agent become a review (restorable with Reject) for each file whose
   * previous content is known. Deletions made in VS Code, by source control,
   * of files the agent just created (nothing to restore), or of unreviewed
   * files are dropped.
   */
  const onDiskDelete = async (state: ReviewState, uri: vscode.Uri) => {
    const rel = state.relPathOf(uri);
    if (rel === undefined || isInternalPath(rel)) {
      return;
    }
    if (path.basename(uri.fsPath) === '.gitignore') {
      await state.recheckIgnored();
    }
    const own = isOwnDelete(uri.fsPath);
    // A deleted folder may only report itself: also check the files under it.
    const tracked = await git(state.repoRoot, ['ls-files', '-z', '--', rel]).then(
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
          `${state.label(r)}: deleted → ` +
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
  const showDeleted = (file: PendingFile) =>
    vscode.commands.executeCommand(
      'vscode.diff',
      deletedUri(file, 'old'),
      deletedUri(file, 'empty'),
      `${path.posix.basename(file.rel)} (deleted)`,
      { preview: false },
    );

  /** Close any open views of a deleted file. */
  const closeDeletedViews = async (file: PendingFile) => {
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
        return sameFile(deletedFileOf(repos, uri), file);
      });
    await vscode.window.tabGroups.close(tabs);
  };

  /** Accept (keep deleted) or Reject (restore) a deletion from its view, then move on. */
  const resolveDeleted = async (keep: boolean, uri?: vscode.Uri) => {
    const file = deletedFileOf(repos, uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!file || !file.state.isDeleted(file.rel)) {
      return;
    }
    await (keep ? acceptFile(file) : rejectFile(file));
    await closeDeletedViews(file);
    if (repos.pendingFiles().length > 0) {
      await goToChange(1);
    }
  };

  const deletedContent = new vscode.EventEmitter<vscode.Uri>();

  /** Tell open deleted-file views to re-read their content. */
  const refreshDeletedViews = () => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === DELETED_SCHEME) {
        deletedContent.fire(doc.uri);
      }
    }
  };

  /** Open document for a file, if VS Code has it loaded. */
  const openDoc = ({ state, rel }: PendingFile) => {
    const fsPath = state.uri(rel).fsPath;
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  };

  /** Accept every pending change in a file: keep it as is and clear its review. */
  const acceptFile = async ({ state, rel }: PendingFile) => {
    debug(`${state.label(rel)}: accept all`);
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
  const rejectFile = async (file: PendingFile) => {
    const { state, rel } = file;
    const snapshot = state.getSnapshot(rel);
    if (snapshot === undefined) {
      return;
    }
    debug(`${state.label(rel)}: reject all`);
    const uri = state.uri(rel);
    const doc = openDoc(file);
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
  const openPending = async (file: PendingFile, atLast = false) => {
    if (file.state.isDeleted(file.rel)) {
      await showDeleted(file);
      return;
    }
    const uri = file.state.uri(file.rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hunks = overlay.review(doc)?.hunks ?? [];
    const target = atLast ? hunks[hunks.length - 1] : hunks[0];
    await showLine(uri, target ? hunkLine(doc, target) : 0);
  };

  /**
   * Go to the next (or previous) pending change from the cursor. Stays in the
   * current file until it has none left, wrapping around within it. When the
   * file has no pending changes, open the next (or previous) pending file,
   * across all repos.
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
    const files = repos.pendingFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('Universal Agent Diff: no pending changes.');
      return;
    }
    const uri = editor?.document.uri;
    const current = uri && (repos.fileOf(uri) ?? deletedFileOf(repos, uri));
    if (direction === 1) {
      await openPending(files.find((f) => !current || compareFiles(f, current) > 0) ?? files[0]);
    } else {
      const prev = [...files].reverse().find((f) => !current || compareFiles(f, current) < 0);
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
    } else if (repos.pendingFiles().length > 0) {
      await goToChange(1);
    }
  };

  /**
   * A repo may have appeared or gone away on disk (git init, clone, a repo
   * folder deleted): if so, re-scan the workspace for repos. Created: a `.git`,
   * or a folder containing one (a clone may only report the folder). Deleted:
   * a `.git`, or a repo's folder.
   */
  const checkForRepoChange = async (uri: vscode.Uri, created: boolean) => {
    const fsPath = uri.fsPath;
    if (fsPath.split(path.sep).includes('node_modules')) {
      return;
    }
    const changed =
      path.basename(fsPath) === '.git' ||
      (created ? await exists(path.join(fsPath, '.git')) : repos.get(fsPath) !== undefined);
    if (changed) {
      debug('a Git repo was added or removed on disk → re-scanning the workspace');
      void syncRepos();
    }
  };

  /** Start reviewing a repo: record its startup state, then watch its files. */
  const addRepo = async (repoRoot: string) => {
    const state = new ReviewState(repoRoot, context.workspaceState, repos);
    repos.add(state);
    try {
      await state.init();
    } catch (err) {
      debug(
        `repo "${state.name}": couldn't start (${(err as Error).message.trim()}), not reviewed`,
      );
      repos.remove(repoRoot);
      state.dispose();
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, '**/*'),
    );
    repoDisposables.set(repoRoot, [
      watcher,
      watcher.onDidChange((uri) => onDiskChange(state, uri)),
      watcher.onDidCreate((uri) => {
        void checkForRepoChange(uri, true);
        void onDiskChange(state, uri);
      }),
      watcher.onDidDelete((uri) => {
        void checkForRepoChange(uri, false);
        void onDiskDelete(state, uri);
      }),
      state.onDidChangeSnapshots(updatePanel),
      state.onDidChangeSnapshots(refreshDeletedViews),
      state,
    ]);
    for (const doc of vscode.workspace.textDocuments) {
      if (repos.fileOf(doc.uri)?.state === state) {
        await onOpen(doc);
      }
    }
  };

  /** Stop reviewing a repo whose folder was removed. Its pending reviews stay saved. */
  const removeRepo = (repoRoot: string) => {
    repoDisposables.get(repoRoot)?.forEach((d) => d.dispose());
    repoDisposables.delete(repoRoot);
    repos.remove(repoRoot);
  };

  /**
   * Review every Git repo in the workspace: each folder's own repo (folders in
   * the same repo share it) plus repos nested inside the folder (see
   * `findNestedRepos`). Folders with neither are skipped. Stops reviewing
   * repos that are no longer there. Runs one at a time.
   */
  let syncing = Promise.resolve();
  const syncRepos = () =>
    (syncing = syncing.then(async () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(
        (f) => f.uri.scheme === 'file',
      );
      const roots = new Set<string>();
      for (const folder of folders) {
        const root = await repoRootOf(folder.uri.fsPath);
        if (root) {
          roots.add(root);
        }
        let nested = 0;
        for (const dir of await findNestedRepos(folder.uri.fsPath)) {
          const nestedRoot = await repoRootOf(dir);
          if (nestedRoot && nestedRoot !== root) {
            roots.add(nestedRoot);
            nested++;
          }
        }
        if (!root && nested === 0) {
          debug(`folder "${folder.name}": no Git repo in it, not reviewed`);
        }
      }
      for (const state of repos.all()) {
        if (!roots.has(state.repoRoot)) {
          debug(`repo "${state.name}": no longer open, not reviewed`);
          removeRepo(state.repoRoot);
        }
      }
      for (const root of roots) {
        if (!repos.get(root)) {
          await addRepo(root);
        }
      }
      debug(
        `reviewing ${repos.all().length} repo(s) from ${folders.length} workspace folder(s): ` +
          repos
            .all()
            .map((s) => `"${s.name}"`)
            .join(', '),
      );
      updatePanel();
      overlay.refresh();
    }));

  context.subscriptions.push(
    overlay,
    pending,
    panel,
    { dispose: () => [...repoDisposables.keys()].forEach(removeRepo) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => void syncRepos()),
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
        const file = deletedFileOf(repos, uri);
        return file?.side === 'old' ? (file.state.getSnapshot(file.rel) ?? '') : '';
      },
    }),
    vscode.commands.registerCommand('interactiveDiff.acceptDeletion', (uri?: vscode.Uri) =>
      resolveDeleted(true, uri),
    ),
    vscode.commands.registerCommand('interactiveDiff.restoreFile', (uri?: vscode.Uri) =>
      resolveDeleted(false, uri),
    ),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, overlay),
    vscode.window.onDidChangeVisibleTextEditors(() => overlay.refresh()),
    vscode.workspace.onDidOpenTextDocument(onOpen),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const file = repos.fileOf(doc.uri);
      if (file) {
        const { state, rel } = file;
        debug(
          `${state.label(rel)}: saved in VS Code → recorded as last seen` +
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
          debug(`${review.state.label(review.rel)}: accept change at line ${hunk.newStart + 1}`);
          review.state.setSnapshot(review.rel, applyHunk(review.snapshot, hunk));
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
          debug(`${review.state.label(review.rel)}: reject change at line ${hunk.newStart + 1}`);
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
          await rejectFile(found.review);
          if (repos.pendingFiles().length > 0) {
            await goToChange(1);
          }
          return;
        }
        overlay.refresh();
      },
    ),
  );

  await syncRepos();
}

export function deactivate() {}
