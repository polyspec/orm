// codec_case.mjs holds the helpers of the codec binding files: the canonical form of a decoded value and check, which
// runs one case as a top-level test and fails it with every problem its body finds.
import { Value as JsonValue, stringify as stringifyJson } from '@polyspec/ordered-json';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';

export const canonical = value => {
  if (value instanceof JsonValue) return canonical(JSON.parse(stringifyJson(value)));
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const shown = value => JSON.stringify(canonical(value));
// The vectors name the Mermaid styles; json and jsons are both the ordered_json stage.
export const stagesOf = styles => styles.map(style => (style === 'json' || style === 'jsons' ? 'ordered_json' : style));
// check runs the checks of one case, which push each problem they find to the list it is given, and fails the case with
// every problem.
export const check = (name, body) => caseTest(name, COMPUTE, async () => {
  const wrong = [];
  await body(wrong);
  if (wrong.length > 0) throw new Error(`${name}:\n${wrong.join('\n')}`);
});

