// The bundled dbspec language server: packages/dbspec-lsp over the transport that the client names (--stdio).
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from '@polyspec/dbspec-lsp';

startServer(createConnection(ProposedFeatures.all));
