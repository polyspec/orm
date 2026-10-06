// Lines keep their line end, so a missing final line end is a difference.
function lines(output) {
  return output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function shown(line) {
  return line === undefined ? '(end of output)' : line.endsWith('\n') ? line.slice(0, -1) : `${line} (no line end)`;
}

// compare returns null when every output equals the first, or the first
// difference: the two runs, the case it belongs to, its line number and both
// lines. A case starts at a line that begins with neither "| ", "! " nor "= ".
export function compare(outputs) {
  for (const { name, output } of outputs) {
    if (output.trim() === '') throw new Error(`${name} printed no case`);
  }
  const [reference, ...others] = outputs;
  for (const other of others) {
    const expected = lines(reference.output);
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
