import type { OrmFunction } from './ir.js';

/** An ORM function value: the model method that receives it records the column and operator. */
abstract class FunctionValue {
  public constructor(public readonly name: string, public readonly args: readonly unknown[]) {}
  public ir(param: (value: unknown) => number): OrmFunction {
    const out: OrmFunction = { name: this.name };
    if (this.args.length > 0) out.ps = this.args.map(param);
    return out;
  }
}

/** A value function: the compared value itself. */
export class ValueFunction extends FunctionValue { private readonly kind = 'value' as const; }

/** A column function: wraps the compared column; the compared value follows it. */
export class ColumnFunction extends FunctionValue { private readonly kind = 'column' as const; }

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
  distance: (longitude: number, latitude: number) => column('distance', longitude, latitude),
  pointX: () => column('point_x'),
  pointY: () => column('point_y'),
} as const;
