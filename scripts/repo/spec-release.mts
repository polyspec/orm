// The release-spec check (T682). The released spec is the spec of the latest version tag (`vX.Y.Z`, the largest by version),
// read with `git show`, so a checkout without its tags cannot pass. An identifier of the released spec fails when the current
// spec changed its body without retiring it, or when the current spec no longer holds it (AGENTS.md:87). A statement is a list
// item of the form `- **ID** body`. The retired marker is a body that starts with "Retired".
import { execFileSync } from 'node:child_process';

export function latestVersionTag(repo: string): string {
  const tags = execFileSync('git', ['-C', repo, 'tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (tags.length === 0) throw new Error(`no version tag (vX.Y.Z) in ${repo}; the release-spec check needs the tags`);
  const key = (tag: string) => tag.slice(1).split('.').map(Number);
  return tags.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0];
}

export function releasedSpecFor(repo: string, path: string): { tag: string; text: string } {
  const tag = latestVersionTag(repo);
  const text = execFileSync('git', ['-C', repo, 'show', `${tag}:${path}`], { encoding: 'utf8' });
  return { tag, text };
}

export function releasedSpecErrors(released: string, current: string, tag = 'the released spec'): string[] {
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
    if (now === undefined) {
      errors.push(`${id} is absent from the current spec; ${tag} holds it (AGENTS.md:87)`);
    } else if (now !== body && !now.startsWith('Retired')) {
      errors.push(`${id} changed its body in the current spec without a retired marker; ${tag} holds it (AGENTS.md:87)`);
    }
  }
  return errors;
}
