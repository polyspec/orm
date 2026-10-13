#!/usr/bin/env node
// The dbspec language server over standard input and output.
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from '../dist/index.js';

startServer(createConnection(ProposedFeatures.all));
