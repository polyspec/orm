// releasedSpecErrors compares the statements of a released spec with the current spec, identifier by identifier (AGENTS.md:87,
// T682): an identifier of the released spec fails when its body has changed in the current spec, unless the current spec
// retires it. A statement is a list item of the form `- **ID** body`. The retired marker is a body that starts with "Retired".
export function releasedSpecErrors(released: string, current: string): string[] {
  const bodies = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of text.split('\n')) {
      const match = /^- \*\*([A-Z]+-\d+[a-z]?)\*\* (.*)$/.exec(line);
      if (match) out.set(match[1], match[2]);
    }
    return out;
  };
  const before = bodies(released);
  const after = bodies(current);
  const errors: string[] = [];
  for (const [id, body] of before) {
    const now = after.get(id);
    if (now === undefined || now === body || now.startsWith('Retired')) continue;
    errors.push(`${id} changed its body in the current spec without a retired marker; the released spec holds it (AGENTS.md:87)`);
  }
  return errors;
}
