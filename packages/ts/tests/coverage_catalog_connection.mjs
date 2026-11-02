// Requirements: INT-101.
// The one native check of catalog_connection (FCV-2, docs/spec/feature-coverage.md "Catalog connection exclusions"): the
// MySQL server refuses a TIME(7) (DIA-54). The recipe's sql.exec step cannot expect a server error, so the check stays
// here. It takes its MySQL database from ORM_TEST_MYSQL_DSN, as the recipe entries do.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { nativeQuery } from './coverage_case.mjs';

caseTest('mysql rejects temporal precision above 6', DATABASE, async () => {
  const dsn = process.env.ORM_TEST_MYSQL_DSN;
  if (!dsn) throw new Error('ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
  const invalid = `catalog_precision_invalid_${process.pid}_${randomInt(0, 1_000_000_000)}`;
  try {
    await assert.rejects(
      nativeQuery('mysql', dsn, [`CREATE TABLE ${invalid} (id BIGINT PRIMARY KEY, t TIME(7))`]),
      /precision/i,
      'MySQL rejects temporal precision above 6',
    );
  } finally {
    await nativeQuery('mysql', dsn, [`DROP TABLE IF EXISTS ${invalid}`]);
  }
});
