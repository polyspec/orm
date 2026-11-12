// The cases of coverage_transactions.mjs on MySQL (docs/spec/dialects.md DIA-200), on a case database with the bench
// set installed (runOnCaseDatabase).
import { runOnCaseDatabase } from './coverage_transactions.mjs';

await runOnCaseDatabase('mysql');
