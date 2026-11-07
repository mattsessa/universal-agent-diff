// Proposed API "editorInsets": a webview shown between two lines of a text editor.
// Requires "enabledApiProposals": ["editorInsets"] in package.json and
// "enable-proposed-api": ["mattsessa.universal-agent-diff"] in ~/.vscode/argv.json.

declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }

  export namespace window {
    /** Shows a webview of `height` lines directly below 0-based `line` (-1 = above the first line). */
    export function createWebviewTextEditorInset(
      editor: TextEditor,
      line: number,
      height: number,
      options?: WebviewOptions,
    ): WebviewEditorInset;
  }
}
