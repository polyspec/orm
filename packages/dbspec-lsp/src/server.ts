// The server: declares its capabilities and answers every request from the analysis of the current state. A document's
// set comes from set resolution (docs/editor.md "Set resolution") on the Node file system, where an open buffer wins
// over the disk; a change of any open buffer or of a watched file analyzes every open document again, so a document
// whose set holds the changed file is never stale.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDocument, resolveSet, TOKEN_CLASSES, type DocumentAnalysis, type SetHost } from '@polyspec/dbspec-language';
import { nodeSetHost } from '@polyspec/dbspec-language/node';
import {
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  MessageType,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type Diagnostic,
  type InitializeResult,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { diagnosticsOf, foldingRangesOf, formatEditsOf, semanticTokensOf } from './results.js';

const encoder = new TextEncoder();

/** The path of a `file:` URI with `/` separators, as set resolution takes it, or null for another scheme. */
function pathOf(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  return fileURLToPath(uri).replaceAll('\\', '/');
}

/** Registers every handler on the connection and starts listening. */
export function startServer(connection: Connection): void {
  const texts = new TextDocuments(TextDocument);
  const analyses = new Map<string, DocumentAnalysis>();
  // The URIs that carry published diagnostics of another file of a set, cleared when no set reports them any more.
  let published = new Set<string>();
  let watching = false;

  // The Node host with the open buffers: a listed file that is open is read from its buffer, its identity from disk.
  const host: SetHost = {
    lstat: path => nodeSetHost.lstat(path),
    stat: path => nodeSetHost.stat(path),
    list: directory => nodeSetHost.list(directory),
    open: path => {
      const file = nodeSetHost.open(path);
      const open = texts.get(pathToFileURL(path).href);
      return open === undefined ? file : { bytes: encoder.encode(open.getText()), identity: file.identity };
    },
  };

  /** Analyzes every open document again and publishes the diagnostics of each URI that has or had any. */
  const refresh = (): void => {
    analyses.clear();
    const byUri = new Map<string, Diagnostic[]>();
    for (const text of texts.all()) {
      const path = pathOf(text.uri);
      let set: Readonly<Record<string, string>> = {};
      if (path !== null) {
        const resolved = resolveSet(path, host);
        if (resolved.set === null) {
          // The set is not resolved: its errors are shown, and the document is analyzed alone, so its use lines report
          // their diagnostic beside them (docs/editor.md "Set resolution").
          for (const e of resolved.errors) void connection.sendNotification('window/showMessage', { type: MessageType.Error, message: `${e.rule}: ${e.message}` });
        } else {
          set = resolved.set;
          for (const d of resolved.diagnostics) {
            const uri = pathToFileURL(d.path).href;
            const list = byUri.get(uri) ?? [];
            const at = { line: d.line - 1, character: d.column - 1 };
            list.push({ range: { start: at, end: at }, severity: DiagnosticSeverity.Error, code: d.rule, source: 'dbspec', message: d.message });
            byUri.set(uri, list);
          }
        }
      }
      const analysis = openDocument(text.getText(), { set });
      analyses.set(text.uri, analysis);
      byUri.set(text.uri, [...(byUri.get(text.uri) ?? []), ...diagnosticsOf(analysis)]);
    }
    for (const uri of published) if (!byUri.has(uri)) void connection.sendDiagnostics({ uri, diagnostics: [] });
    for (const [uri, diagnostics] of byUri) {
      const text = texts.get(uri);
      void connection.sendDiagnostics(text === undefined ? { uri, diagnostics } : { uri, version: text.version, diagnostics });
    }
    published = new Set(byUri.keys());
  };
  const analysisOf = (uri: string): DocumentAnalysis | undefined => analyses.get(uri);

  connection.onInitialize((params): InitializeResult => {
    watching = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    return {
      capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full },
        semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_CLASSES], tokenModifiers: [] }, full: true },
        foldingRangeProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'dbspec-lsp' },
    };
  });
  connection.onInitialized(() => {
    // A set file or a listed document changed on disk is learned from the client's file events, not by polling.
    if (watching) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/dbspec-set.json' }, { globPattern: '**/*.dbs' }] });
    }
  });
  connection.onDidChangeWatchedFiles(refresh);

  texts.onDidChangeContent(refresh);
  texts.onDidClose(refresh);
  connection.languages.semanticTokens.on(({ textDocument }) => {
    const analysis = analysisOf(textDocument.uri);
    return { data: analysis === undefined ? [] : semanticTokensOf(analysis) };
  });
  connection.onFoldingRanges(({ textDocument }) => {
    const analysis = analysisOf(textDocument.uri);
    return analysis === undefined ? null : foldingRangesOf(analysis);
  });
  connection.onDocumentFormatting(({ textDocument }) => {
    const text = texts.get(textDocument.uri);
    const analysis = analysisOf(textDocument.uri);
    return text === undefined || analysis === undefined ? null : formatEditsOf(text, analysis);
  });

  texts.listen(connection);
  connection.listen();
}
