// The cases of coverage_transactions.mjs on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200), on a case database with the bench
// set installed (runOnCaseDatabase).
import { runOnCaseDatabase } from './coverage_transactions.mjs';

await runOnCaseDatabase('mariadb');
