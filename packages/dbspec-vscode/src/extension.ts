// VS Code extension entry: starts the bundled dbspec language server (dist/server.cjs) as a language client. Every
// result (diagnostics, semantic tokens, folding, formatting) comes from the server; the extension reads nothing itself.
import type * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

const LANGUAGE = 'dbspec';

let client: LanguageClient | undefined;

/** Starts the language client of the bundled server `dist/server.cjs`. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const module = context.asAbsolutePath('dist/server.cjs');
  client = new LanguageClient(LANGUAGE, 'dbspec', { module, transport: TransportKind.stdio }, { documentSelector: [{ language: LANGUAGE }] });
  await client.start();
}

/** Stops the language server. */
export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
