import type { OrmFunction } from './ir.js';

/** A value function: the compared value itself; the model method that receives it records the column and operator. */
export class ValueFunction {
  private readonly kind = 'value' as const;
  /** @internal */
  public constructor(/** @internal */ public readonly name: string, /** @internal */ public readonly args: readonly unknown[]) {}
}

/** A column function: wraps the compared column; the compared value follows it. */
export class ColumnFunction {
  private readonly kind = 'column' as const;
  /** @internal */
  public constructor(/** @internal */ public readonly name: string, /** @internal */ public readonly args: readonly unknown[]) {}
}

/** The IR of an ORM function value: its name and the bind slots of its arguments. */
export function functionIR(fn: ValueFunction | ColumnFunction, param: (value: unknown) => number): OrmFunction {
  const out: OrmFunction = { name: fn.name };
  if (fn.args.length > 0) out.ps = fn.args.map(param);
  return out;
}

const value = (name: string, ...args: unknown[]) => new ValueFunction(name, args);
const column = (name: string, ...args: unknown[]) => new ColumnFunction(name, args);

export const orm = {
  now: () => value('now'),
  today: () => value('today'),
  secondsAgo: (n: number) => value('seconds_ago', n),
  minutesAgo: (n: number) => value('minutes_ago', n),
  hoursAgo: (n: number) => value('hours_ago', n),
  daysAgo: (n: number) => value('days_ago', n),
  monthsAgo: (n: number) => value('months_ago', n),
  secondsLater: (n: number) => value('seconds_later', n),
  minutesLater: (n: number) => value('minutes_later', n),
  hoursLater: (n: number) => value('hours_later', n),
  daysLater: (n: number) => value('days_later', n),
  monthsLater: (n: number) => value('months_later', n),
  dayOfWeek: () => column('day_of_week'),
  year: () => column('year'),
  month: () => column('month'),
  date: () => column('date'),
} as const;
