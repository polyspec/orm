#!/usr/bin/env node
// Command line entry of dbspec-fmt; the implementation is src/cli/main.ts.
import { main } from '../dist/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
