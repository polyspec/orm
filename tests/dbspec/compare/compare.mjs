// Lines keep their line end, so a missing final line end is a difference.
function lines(output) {
  return output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function shown(line) {
  return line === undefined ? '(end of output)' : line.endsWith('\n') ? line.slice(0, -1) : `${line} (no line end)`;
}

// expectedOf는 other가 같아야 할 reference의 줄이다. until이 있는 output(일부 section만 구현하는 runner)은
// reference에서 until로 시작하는 첫 줄 앞까지와 같아야 하고, reference에 그 줄이 없으면 비교할 수 없다.
function expectedOf(reference, other) {
  const all = lines(reference.output);
  if (other.until === undefined) return all;
  const end = all.findIndex(line => line.startsWith(other.until));
  if (end < 0) throw new Error(`${reference.name} has no line that starts with ${other.until}, where the output of ${other.name} ends`);
  if (end === 0) throw new Error(`${reference.name} starts with ${other.until}, so ${other.name} has no case to compare`);
  return all.slice(0, end);
}

// compare returns null when every output equals the first, or the first
// difference: the two runs, the case it belongs to, its line number and both
// lines. A case starts at a line that begins with neither "| ", "! " nor "= ".
// An output with until equals the first output up to its first line that
// starts with until.
export function compare(outputs) {
  for (const { name, output } of outputs) {
    if (output.trim() === '') throw new Error(`${name} printed no case`);
  }
  const [reference, ...others] = outputs;
  for (const other of others) {
    const expected = expectedOf(reference, other);
    const actual = lines(other.output);
    let current = '';
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const want = expected[i];
      if (want !== undefined && !/^[|!=] /.test(want)) current = shown(want);
      if (want === actual[i]) continue;
      return {
        reference: reference.name,
        other: other.name,
        case: current,
        line: i + 1,
        expected: shown(want),
        actual: shown(actual[i]),
      };
    }
  }
  return null;
}
