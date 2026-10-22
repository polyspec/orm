// LISTEN and NOTIFY on PostgreSQL (docs/spec/dialects.md DIA-192 to DIA-196). A subscription holds a pg client of its own,
// outside the pool; notifications that arrive while no receive waits are queued in arrival order.
import pg from 'pg';
import * as codes from './codes.js';
import { OrmError } from './runtime_error.js';

/** One notification: the channel, the payload, and the process id of the sender. */
export interface Notification {
  channel: string;
  payload: string;
  pid: number;
}

/** A pending receive: the callbacks that settle it, and the abort listener that the signal of the receive added. */
interface Waiter {
  resolve(notification: Notification): void;
  reject(error: unknown): void;
}

/** The connection of a LISTEN subscription. The pool's driver opens it with openListener. */
export class PostgresListener {
  private readonly queue: Notification[] = [];
  private waiter: Waiter | undefined;
  private closed = false;

  public constructor(private readonly client: pg.Client, private readonly onFailure: (error: unknown) => OrmError) {
    client.on('notification', (message: pg.Notification) => {
      const notification = { channel: message.channel, payload: message.payload ?? '', pid: message.processId };
      if (this.waiter === undefined) this.queue.push(notification);
      else this.waiter.resolve(notification);
    });
    // A connection error ends the subscription: a waiting receive fails with the error, and later calls fail with CONFIG.
    client.on('error', (error: unknown) => {
      this.closed = true;
      const failure = this.onFailure(error);
      if (this.waiter !== undefined) this.waiter.reject(failure);
    });
  }

  /** Runs LISTEN for channel on the connection. */
  public async listen(channel: string): Promise<void> {
    await this.run(`LISTEN ${quoteIdent(channel)}`);
  }

  /** Runs UNLISTEN for channel on the connection. */
  public async unlisten(channel: string): Promise<void> {
    await this.run(`UNLISTEN ${quoteIdent(channel)}`);
  }

  /** Waits for the next notification. An aborted signal, or a signal that is already aborted, fails the receive with CANCELED and closes the connection. */
  public receive(signal: AbortSignal | undefined): Promise<Notification> {
    if (this.closed) return Promise.reject(new OrmError(codes.CONFIG, 'the LISTEN subscription is closed'));
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const cancelled = () => new OrmError(codes.CANCELED, 'the receive of the LISTEN subscription was cancelled');
    if (signal?.aborted) return this.close().then(() => Promise.reject(cancelled()));
    return new Promise<Notification>((resolve, reject) => {
      const settle = (done: () => void) => {
        this.waiter = undefined;
        signal?.removeEventListener('abort', onAbort);
        done();
      };
      const onAbort = () => settle(() => {
        this.close().then(() => reject(cancelled()), () => reject(cancelled()));
      });
      this.waiter = {
        resolve: notification => settle(() => resolve(notification)),
        reject: error => settle(() => reject(error)),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Runs UNLISTEN for every channel and closes the connection. Closing a closed subscription does nothing. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.query('UNLISTEN *');
    } finally {
      await this.client.end();
    }
  }

  private async run(sql: string): Promise<void> {
    if (this.closed) throw new OrmError(codes.CONFIG, 'the LISTEN subscription is closed');
    try {
      await this.client.query(sql);
    } catch (error) {
      throw this.onFailure(error);
    }
  }
}

/** A quoted PostgreSQL identifier of channel; the channel's length and NUL are checked by the caller. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Checks a channel of 1 to 63 bytes without U+0000 (DIA-192). */
export function checkChannel(channel: string): void {
  if (Buffer.byteLength(channel) < 1 || Buffer.byteLength(channel) > 63 || channel.includes('\u0000')) {
    throw new OrmError(codes.CONFIG, 'a channel is 1 to 63 bytes without U+0000');
  }
}

/** A LISTEN subscription of a handle: the receives use the abort signal of the handle that listened (DIA-195). */
export class Subscription {
  public constructor(private readonly listener: PostgresListener, private readonly signal: AbortSignal | undefined) {}

  /** Waits for the next notification; see PostgresListener.receive. */
  public receive(): Promise<Notification> {
    return this.listener.receive(this.signal);
  }

  /** Stops delivery of channel. */
  public unlisten(channel: string): Promise<void> {
    checkChannel(channel);
    return this.listener.unlisten(channel);
  }

  /** Runs UNLISTEN for every channel and closes the connection. */
  public close(): Promise<void> {
    return this.listener.close();
  }
}
