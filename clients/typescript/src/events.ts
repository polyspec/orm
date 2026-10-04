// statement event다(docs/usage.md "Statement events"). 연결은 자기가 보내는 모든 statement마다
// event 하나를 등록한 subscriber에게 publish한다.
import type { SentOrigin, StatementDone } from './driver.js';
import { OrmError } from './runtime_error.js';

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
 * 연결의 모든 handle이 공유하는 subscriber 목록과 transaction 번호다. 목록은 바꿀 때마다 새로
 * 만들므로 publish 중에 등록하거나 해제해도 그 publish의 목록은 그대로다.
 */
export class Subscribers {
  private list: readonly StatementSubscriber[] = [];
  private transactions = 0;

  public subscribe(subscriber: StatementSubscriber): () => void {
    if (typeof subscriber !== 'function') throw new OrmError('CONFIG', 'subscribe takes a function that receives a statement event');
    // 같은 함수를 두 번 등록해도 해제는 자기 등록 하나만 지운다.
    const entry: StatementSubscriber = event => subscriber(event);
    this.list = [...this.list, entry];
    return () => { this.list = this.list.filter(s => s !== entry); };
  }

  /** 새 바깥 transaction의 번호다. */
  public nextTransaction(): number { return ++this.transactions; }

  /**
   * statement 하나의 event를 publish하는 done이다. kind와 tables는 호출자가 보낸 statement의 것이고,
   * driver가 스스로 보낸 statement는 table이 없는 utility다. 다른 연결에서 보낸 kill은 transaction 밖이다.
   */
  public done(kind: StatementKind, tables: readonly string[], transaction: number | null, binds: readonly unknown[]): StatementDone {
    return (sql: string, elapsed: number, error: OrmError | null, origin: SentOrigin) => {
      if (this.list.length === 0) return;
      if (origin === 'statement') this.publish({ sql, binds, kind, tables, elapsed, transaction, error });
      else this.publish({ sql, binds: noBinds, kind: 'utility', tables: noTables, elapsed, transaction: origin === 'kill' ? null : transaction, error });
    };
  }

  /** subscriber를 등록 순서로 부른다. 하나가 던지면 나머지는 부르지 않고 SUBSCRIBER를 던진다. */
  private publish(event: StatementEvent): void {
    const list = this.list;
    if (list.length === 0) return;
    const frozen = Object.freeze({ ...event, binds: Object.freeze([...event.binds]), tables: Object.freeze([...event.tables]) });
    for (const subscriber of list) {
      try { subscriber(frozen); } catch (error) {
        throw new OrmError('SUBSCRIBER', `statement event subscriber failed: ${error instanceof Error ? error.message : String(error)}`, error);
      }
    }
  }
}

/** planner가 쓴 statement의 kind다: SQL의 첫 단어다. */
export function statementKind(sql: string): StatementKind {
  const verb = sql.trimStart().split(' ', 1)[0]!.toUpperCase();
  switch (verb) {
    case 'INSERT': return 'insert';
    case 'UPDATE': return 'update';
    case 'DELETE': return 'delete';
    default: return 'select';
  }
}
