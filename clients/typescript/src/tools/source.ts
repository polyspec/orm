// Schema sources for the tools: Mermaid, schema.json, DDL written by the
// tool, or a live database (db:<dsn>).
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { buildManifest, loadSchemaManifest, manifestText, type SchemaManifest } from '../schema/build.js';
import { parseDiagram } from '../schema/mermaid.js';
import { openToolDb, parseToolDsn, redactedDsn } from './db.js';
import { liveManifest } from './introspect.js';

export const schemaMetadataPrefix = '-- orm-schema-v1 ';

/** The metadata line that embeds the manifest in generated SQL. */
export function manifestMetadata(m: SchemaManifest): string {
  return schemaMetadataPrefix + Buffer.from(manifestText(m)).toString('base64').replace(/=+$/, '') + '\n';
}

/** Resolves one schema source without changing it. */
export async function loadSchemaSource(source: string, dialect: string): Promise<SchemaManifest> {
  if (source.startsWith('db:')) return loadDatabaseSchema(source.slice(3), dialect);
  let bytes: Buffer;
  try { bytes = readFileSync(source); } catch (error) {
    throw new Error(`read ${source}: ${(error as Error).message}`);
  }
  const text = bytes.toString('utf8');
  switch (extname(source).toLowerCase()) {
    case '.mmd': case '.mermaid': return buildMermaidSource(source, text);
    case '.json': return loadSchemaManifest(text);
    case '.sql': return manifestFromDDL(source, text);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('erDiagram')) return buildMermaidSource(source, text);
  if (trimmed.startsWith('{')) return loadSchemaManifest(text);
  if (text.includes(schemaMetadataPrefix)) return manifestFromDDL(source, text);
  throw new Error(`MIGRATION_SOURCE: ${source}: cannot detect mmd, json, or ormgen sql`);
}

function buildMermaidSource(path: string, text: string): SchemaManifest {
  try {
    return buildManifest([parseDiagram(text)]);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

const base64 = /^[A-Za-z0-9+/]*$/;

function manifestFromDDL(path: string, text: string): SchemaManifest {
  for (const line of text.split('\n')) {
    if (!line.startsWith(schemaMetadataPrefix)) continue;
    const encoded = line.slice(schemaMetadataPrefix.length).trim();
    if (!base64.test(encoded) || encoded.length % 4 === 1) {
      throw new Error(`MIGRATION_SOURCE: ${path}: invalid orm-schema-v1 metadata: illegal base64 data`);
    }
    try {
      return loadSchemaManifest(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch (error) {
      throw new Error(`MIGRATION_SOURCE: ${path}: invalid embedded manifest: ${(error as Error).message}`);
    }
  }
  throw new Error(`MIGRATION_SOURCE_LOSS: ${path} has no orm-schema-v1 metadata; SQL cannot represent codec styles or relation options`);
}

/** The manifest of the live database a db: source names; it must use the dialect. */
async function loadDatabaseSchema(raw: string, dialect: string): Promise<SchemaManifest> {
  if (raw === '') throw new Error('MIGRATION_SOURCE: db: requires a DSN');
  const dsn = parseToolDsn(raw);
  if (dsn.dialect !== dialect) throw new Error(`MIGRATION_CONFIG: db source ${redactedDsn(dsn)} is ${dsn.dialect}, not ${dialect}`);
  const { db } = await openToolDb(raw);
  try {
    return await liveManifest(db);
  } catch (error) {
    throw new Error(`MIGRATION_INTROSPECT: driver=${dsn.dialect} dsn=${redactedDsn(dsn)}: ${(error as Error).message}`);
  } finally {
    await db.close();
  }
}
