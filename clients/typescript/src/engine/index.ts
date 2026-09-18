// The statement compiler: a manifest bound to a dialect.
import type { Plan, Request } from '../ir.js';
import { OrmError } from '../runtime_error.js';
import { renderCreateDDL, splitSQL } from './ddl.js';
import { dialectOf } from './dialect.js';
import { loadManifest, type LoadedManifest } from './manifest.js';
import { Planner } from './planner.js';
import { validate } from './validate.js';

export { renderCreateDDL, renderDDL, splitSQL } from './ddl.js';
export { loadManifest } from './manifest.js';
export type { LoadedManifest, Manifest } from './manifest.js';
export { opAllowed } from './validate.js';

export class Engine {
  private readonly planner: Planner;

  public constructor(public readonly loaded: LoadedManifest, public readonly dialect: string) {
    const d = dialectOf(dialect);
    if (d === undefined) throw new OrmError('DIALECT_UNKNOWN', dialect);
    this.planner = new Planner(loaded.manifest, d);
  }

  /** Builds an engine from schema.json text. */
  public static load(manifestJson: string, dialect: string): Engine {
    return new Engine(loadManifest(manifestJson), dialect);
  }

  public get schemaHash(): string { return this.loaded.manifest.schema_hash; }

  /** Validates a request and returns its plan. */
  public compile(request: Request): Plan {
    validate(this.loaded.manifest, request);
    return this.planner.compile(request);
  }

  /** The statements that create the schema when it is missing. */
  public installStatements(): string[] {
    return splitSQL(renderCreateDDL(this.loaded, this.dialect));
  }
}
