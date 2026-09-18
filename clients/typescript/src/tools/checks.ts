// MySQL and PostgreSQL store a CHECK expression in their own normalized form,
// so the text read from the catalog differs from the declared expression. To
// compare them, the declared expression is created on a temporary table of the
// same database and read back through the same catalog path; SQLite keeps the
// text it was given, so its form is the rendered DDL text.
import type { Column } from '../engine/manifest.js';
import { ddlColumn, ddlErrorText, ddlTable, quotedCheckExpression, type Quote } from '../engine/ddl.js';
import { manifestHash, type SchemaEntity, type SchemaManifest } from '../schema/build.js';
import { openToolDb, type ToolDb } from './db.js';
import { postgresCheckExpr, sqliteBalancedParen } from './introspect.js';

const probe = '__orm_check_probe';

function probeCheckName(i: number): string { return `__orm_check_probe_${i + 1}`; }

/**
 * Replaces the expression of every live check that is equivalent to the
 * declared check of the same name with the declared text, so a diff reports
 * only real changes. A changed live manifest gets the hash of its new
 * content, so a plan that stores it stays self-consistent.
 */
export async function alignLiveChecks(db: ToolDb, live: SchemaManifest, want: SchemaManifest): Promise<void> {
  let changed = false;
  const liveEntities = live.entities ?? {};
  for (const [name, declared] of Object.entries(want.entities ?? {})) {
    if ((declared.checks ?? []).length === 0) continue;
    let current = Object.hasOwn(liveEntities, name) ? liveEntities[name] : undefined;
    if (!current) {
      for (const candidate of Object.values(liveEntities)) {
        if (candidate.table === ddlTable(declared.table, db.driver)) current = candidate;
      }
    }
    if (!current || (current.checks ?? []).length === 0) continue;
    let canonical: string[];
    try { canonical = await canonicalChecks(db, declared); } catch (error) {
      throw new Error(`table ${declared.table}: normalize CHECK expressions: ${ddlErrorText(error)}`);
    }
    for (const liveCheck of current.checks!) {
      declared.checks!.forEach((check, j) => {
        if (check.name === liveCheck.name && canonical[j] === liveCheck.expr && liveCheck.expr !== check.expr) {
          liveCheck.expr = check.expr;
          changed = true;
        }
      });
    }
  }
  if (changed) live.schema_hash = manifestHash(live);
}

/** The catalog form of each declared check of e, in declaration order. */
async function canonicalChecks(db: ToolDb, e: SchemaEntity): Promise<string[]> {
  const quote: Quote = db.driver === 'mysql' ? s => '`' + s + '`' : s => `"${s}"`;
  const exprs = (e.checks ?? []).map(check => quotedCheckExpression(check.expr, quote));
  if (db.driver === 'sqlite') return exprs;
  const lines = (e.columns ?? []).map(c => ddlColumn({ ...c, auto: false } as unknown as Column, db.driver, quote));
  exprs.forEach((expr, i) => lines.push(`CONSTRAINT ${quote(probeCheckName(i))} CHECK (${expr})`));
  await db.exec(`CREATE TEMPORARY TABLE ${quote(probe)} (${lines.join(', ')})`);
  const byName = new Map<string, string>();
  try {
    if (db.driver === 'mysql') {
      const text = String((await db.query(`SHOW CREATE TABLE ${quote(probe)}`))[0]![1]);
      exprs.forEach((_, i) => {
        const marker = `CONSTRAINT ${quote(probeCheckName(i))} CHECK `;
        const at = text.indexOf(marker);
        if (at < 0) throw new Error(`check ${e.checks![i]!.name} is missing from the probe table`);
        const open = at + marker.length;
        const end = sqliteBalancedParen(text, open);
        byName.set(probeCheckName(i), text.slice(open + 1, end));
      });
    } else {
      for (const row of await db.query(`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'pg_temp.${probe}'::regclass AND contype = 'c'`)) {
        byName.set(String(row[0]), postgresCheckExpr(String(row[1])));
      }
    }
  } finally {
    await db.exec(`DROP TABLE IF EXISTS ${quote(probe)}`).catch(() => undefined);
  }
  return exprs.map((_, i) => {
    const text = byName.get(probeCheckName(i));
    if (text === undefined) throw new Error(`check ${e.checks![i]!.name} is missing from the probe table`);
    return text;
  });
}

/** Aligns the checks of a db: source with the other side of a diff, which is compared in that database. */
export async function alignSourceChecks(fromPath: string, toPath: string, from: SchemaManifest, to: SchemaManifest): Promise<void> {
  const align = async (source: string, live: SchemaManifest, want: SchemaManifest): Promise<void> => {
    if (!source.startsWith('db:')) return;
    const { db } = await openToolDb(source.slice(3));
    try { await alignLiveChecks(db, live, want); } finally { await db.close(); }
  };
  await align(fromPath, from, to);
  await align(toPath, to, from);
}
