import '../dist/models/models.js';
import { Db, OrmError } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

// dsn_connection: the client connects to the DSN of each database item, and rejects a DSN of an unsupported scheme.
await runCases('coverage_dsn.mjs', {
  async dsn_connection({ driver, dsn }) {
    try {
      await Db.connect('invalid://database');
      throw new Error('unsupported DSN scheme was accepted');
    } catch (error) {
      if (!(error instanceof OrmError) || error.code !== 'CONFIG') throw error;
    }
    const db = await Db.connect(dsn);
    try {
      if (db.driver !== driver) throw new Error(`DSN selected ${db.driver}, want ${driver}`);
    } finally {
      await db.close();
    }
  },
}, 60_000);
