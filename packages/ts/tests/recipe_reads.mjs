// The run-time read of a recipe step (FCV-4): a key of a step or of its outcome that the helper never reads asserts
// nothing, so a run records what it reads and an unread key fails the case by name.

// Keys that the format holds for the reader of the recipe or for the runner of the step, which no op reads; expect_unnamed
// is the outcome of a driver with unnamed parameters, which this runtime does not have.
const ANNOTATIONS = new Set(['op', 'only', 'reason', 'expect_unnamed']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function recording(value, read, prefix) {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'string') read.add(prefix + key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') read.add(prefix + key);
      return Reflect.has(target, key);
    },
  });
}

/** The step as a proxy that records its reads, with outcome for the expect of database and the checks of what stayed unread. */
export function readStep(raw, database) {
  const read = new Set();
  const step = new Proxy(raw, {
    get(target, key, receiver) {
      if (typeof key !== 'string') return Reflect.get(target, key, receiver);
      read.add(key);
      const value = Reflect.get(target, key, receiver);
      if (key !== 'expect' || !isObject(value)) return value;
      return new Proxy(value, {
        get(expect, name, inner) {
          const outcome = Reflect.get(expect, name, inner);
          return name === database && isObject(outcome) ? recording(outcome, read, 'expect.') : outcome;
        },
      });
    },
    has(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.has(target, key);
    },
  });
  const unreadOutcome = () => (isObject(raw.expect?.[database]) ? Object.keys(raw.expect[database]).filter(key => !read.has(`expect.${key}`)).map(key => `expect.${key}`) : []);
  const fail = unread => {
    if (unread.length > 0) throw new Error(`the helper did not read ${unread.join(', ')} of ${raw.op}`);
  };
  return {
    step,
    outcome: value => (isObject(value) ? recording(value, read, 'expect.') : value),
    /** After an op that ended with its expected error: what the op did not reach is not asked of it, the outcome is. */
    checkOutcome: () => fail(unreadOutcome()),
    check: () => fail([...Object.keys(raw).filter(key => !ANNOTATIONS.has(key) && !read.has(key)), ...unreadOutcome()]),
  };
}
