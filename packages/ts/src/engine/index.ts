// Statement compiler: the runtime model bound to a dialect.
import type { Plan, Request } from '../ir.js';
import { OrmError } from '../runtime_error.js';
import { dialectOf } from './dialect.js';
import type { RuntimeModel } from './model.js';
import { Planner } from './planner.js';
import { validate } from './validate.js';
import * as codes from '../codes.js';

export type { Entity, Field, FieldType, RuntimeModel } from './model.js';
export { loadSet } from './model.js';

export class Engine {
  private readonly planner: Planner;

  public constructor(public readonly model: RuntimeModel, public readonly dialect: string) {
    const d = dialectOf(dialect);
    if (d === undefined) throw new OrmError(codes.DIALECT_UNKNOWN, dialect);
    this.planner = new Planner(model, d);
  }

  public get manifestHash(): string { return this.model.manifestHash; }

  /** Validates a request and returns its plan. */
  public compile(request: Request): Plan {
    validate(this.model, request);
    return this.planner.compile(request);
  }
}
