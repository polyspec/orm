import type { PoolBounds, PoolStats } from './driver.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

/** A connection that a ConnectionPool holds: when it was opened, whether it can still be used, and how it is closed. */
export interface PooledConnection {
  readonly created: number;
  readonly broken: boolean;
  close(): void;
}

/**
 * The connections of one Db that the client pools itself, the SQLite files and the flowmark sessions (CFG-4, CFG-5, CFG-5a).
 * Open connections never exceed bounds.size, and a caller that needs one while all of them are in use waits for one. A released
 * connection closes when it is broken, when the pool is closed, when bounds.idleSize connections are already idle, or when
 * bounds.lifetimeMs has passed since it was opened. An idle connection closes when its lifetime ends, by a timer of its own, so
 * stats() never counts a connection that outlived its lifetime.
 */
export class ConnectionPool<C extends PooledConnection> {
  private idle: C[] = [];
  private readonly expiries = new Map<C, ReturnType<typeof setTimeout>>();
  private open = 0;
  private inUse = 0;
  private closed = false;
  private waiters: Array<() => void> = [];

  public constructor(
    private readonly bounds: PoolBounds,
    private readonly dial: (signal: AbortSignal | undefined) => Promise<C>,
    private readonly canceled: () => OrmError,
  ) {}

  /** Hands out an idle connection or opens a new one. If bounds.size connections are in use, waits until one comes back. */
  public async acquire(signal: AbortSignal | undefined): Promise<C> {
    while (!this.closed && this.inUse >= this.bounds.size) await this.wait(signal);
    if (this.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    for (let c = this.idle.pop(); c !== undefined; c = this.idle.pop()) {
      this.keep(c);
      if (c.broken || this.expired(c)) {
        this.drop(c);
        continue;
      }
      this.inUse++;
      return c;
    }
    this.open++;
    this.inUse++;
    try {
      return await this.dial(signal);
    } catch (error) {
      this.open--;
      this.inUse--;
      this.wakeOne();
      throw error;
    }
  }

  /** Returns a connection to the pool, or closes it (see the class). */
  public release(c: C): void {
    this.inUse--;
    if (c.broken || this.closed || this.expired(c) || this.idle.length >= this.bounds.idleSize) this.drop(c);
    else {
      this.idle.push(c);
      this.expire(c);
    }
    this.wakeOne();
  }

  public close(): void {
    this.closed = true;
    for (const c of this.idle) {
      this.keep(c);
      this.drop(c);
    }
    this.idle = [];
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  public stats(): PoolStats {
    return { maxOpenConnections: this.bounds.size, openConnections: this.open, inUse: this.inUse, idle: this.idle.length };
  }

  private expired(c: C): boolean {
    return this.bounds.lifetimeMs > 0 && performance.now() - c.created >= this.bounds.lifetimeMs;
  }

  /** Closes the idle connection c when its lifetime ends. The timer does not keep the process alive. */
  private expire(c: C): void {
    if (this.bounds.lifetimeMs <= 0) return;
    const timer = setTimeout(() => {
      this.expiries.delete(c);
      const at = this.idle.indexOf(c);
      if (at === -1) return;
      this.idle.splice(at, 1);
      this.drop(c);
      this.wakeOne();
    }, Math.max(0, c.created + this.bounds.lifetimeMs - performance.now()));
    timer.unref();
    this.expiries.set(c, timer);
  }

  /** Stops the lifetime timer of c, which leaves the idle connections. */
  private keep(c: C): void {
    const timer = this.expiries.get(c);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.expiries.delete(c);
  }

  private drop(c: C): void {
    c.close();
    this.open--;
  }

  private wait(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(this.canceled());
    return new Promise((resolve, reject) => {
      const waiter = (): void => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = (): void => { this.waiters = this.waiters.filter(w => w !== waiter); reject(this.canceled()); };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private wakeOne(): void {
    this.waiters.shift()?.();
  }
}
