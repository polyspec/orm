// A statement event (docs/usage.md "Statement events"). A connection, for every statement it sends,
// publishes an event to the subscribers that registered for it.
import type { SentOrigin, StatementDone } from './driver.js';
import { present } from './present.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

/**
 * The origin of a statement: the verb of the plan step of a model statement,
 * transaction control, a statement of the schema utilities, or utility for
 * every other statement the client sends.
 */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback_to' | 'schema' | 'utility';

/** One statement that the connection sent to the database. */
export interface StatementEvent {
  /** The statement as sent; a relation step carries its expanded IN list. */
  readonly sql: string;
  /** The bound values in order; a secret is `$SECRET` and an executor clock value `$NOW`. */
  readonly binds: readonly unknown[];
  readonly kind: StatementKind;
  /** The tables the statement names, sorted and without duplicates. */
  readonly tables: readonly string[];
  /** Seconds from sending the statement until the client read its result. */
  readonly elapsed: number;
  /** The number of the transaction on the connection, counted from 1 by every outermost begin; null outside a transaction. */
  readonly transaction: number | null;
  /** The error the statement ended with, or null. */
  readonly error: OrmError | null;
}

/** Receives the event of every statement after it ends and before the operation continues; it must not throw. */
export type StatementSubscriber = (event: StatementEvent) => void;

const noTables: readonly string[] = Object.freeze([]);
const noBinds: readonly unknown[] = Object.freeze([]);

/**
 * The subscriber list and transaction number shared by all handles of the connection. The list is rebuilt each time it changes,
 * so registering or unregistering during a publish leaves that publish's list as it is.
 */
export class Subscribers {
  private list: readonly StatementSubscriber[] = [];
  private transactions = 0;

  public subscribe(subscriber: StatementSubscriber): () => void {
    if (typeof subscriber !== 'function') throw new OrmError(codes.CONFIG, 'subscribe takes a function that receives a statement event');
    // Even if the same function is registered twice, unregistering removes only its own single registration.
    const entry: StatementSubscriber = event => subscriber(event);
    this.list = [...this.list, entry];
    return () => { this.list = this.list.filter(s => s !== entry); };
  }

  /** The number of a new outer transaction. */
  public nextTransaction(): number { return ++this.transactions; }

  /**
   * A done that publishes the event of one statement. kind and tables are those of the statement the caller sent, and
   * a statement the driver sent itself is a utility with no table. A kill sent from another connection is outside any transaction.
   */
  public done(kind: StatementKind, tables: readonly string[], transaction: number | null, binds: readonly unknown[]): StatementDone {
    return (sql: string, elapsed: number, error: OrmError | null, origin: SentOrigin) => {
      if (this.list.length === 0) return;
      if (origin === 'statement') this.publish({ sql, binds, kind, tables, elapsed, transaction, error });
      else this.publish({ sql, binds: noBinds, kind: 'utility', tables: noTables, elapsed, transaction: origin === 'kill' ? null : transaction, error });
    };
  }

  /** Calls the subscribers in registration order. If one throws, the rest are not called and SUBSCRIBER is thrown. */
  private publish(event: StatementEvent): void {
    const list = this.list;
    if (list.length === 0) return;
    const frozen = Object.freeze({ ...event, binds: Object.freeze([...event.binds]), tables: Object.freeze([...event.tables]) });
    for (const subscriber of list) {
      try { subscriber(frozen); } catch (error) {
        throw new OrmError(codes.SUBSCRIBER, `statement event subscriber failed: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
  }
}

/** The kind of statement the planner wrote: the first word of the SQL. */
export function statementKind(sql: string): StatementKind {
  const verb = present(sql.trimStart().split(' ', 1)[0], 'the first word of a statement').toUpperCase();
  switch (verb) {
    // ALTER is the schema statement of MySQL identity restart.
    case 'ALTER': return 'schema';
    case 'INSERT': return 'insert';
    case 'UPDATE': return 'update';
    case 'DELETE': return 'delete';
    default: return 'select';
  }
}
