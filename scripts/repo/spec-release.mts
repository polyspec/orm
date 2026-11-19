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
  const [latest] = tags.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) {
      const [left, right] = [x[i] ?? 0, y[i] ?? 0];
      if (left !== right) return right - left;
    }
    return 0;
  });
  if (latest === undefined) throw new Error(`no version tag (vX.Y.Z) in ${repo}; the release-spec check needs the tags`);
  return latest;
}

export function releasedSpecFor(repo: string, path: string): { tag: string; text: string } {
  const tag = latestVersionTag(repo);
  const text = execFileSync('git', ['-C', repo, 'show', `${tag}:${path}`], { encoding: 'utf8' });
  return { tag, text };
}

export type ReviewEntry = { id: string; tag: string; released: string; current: string };

// The statements of a spec, by identifier.
function statements(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^- \*\*([A-Z]+-\d+[a-z]?)\*\* (.*)$/.exec(line);
    if (match === null) continue;
    const [, id, body] = match;
    if (id === undefined || body === undefined) throw new Error(`statement line without an identifier or a body: ${line}`);
    out.set(id, body);
  }
  return out;
}

// An identifier of the released spec that the current spec no longer holds fails (AGENTS.md:87). Its message names the tag.
export function releasedSpecErrors(released: string, current: string, tag = 'the released spec'): string[] {
  const before = statements(released);
  const after = statements(current);
  const errors: string[] = [];
  for (const id of before.keys()) {
    if (!after.has(id)) errors.push(`${id} is absent from the current spec; ${tag} holds it (AGENTS.md:87)`);
  }
  return errors;
}

// An identifier whose body changed in the current spec is not a failure: a reviewer judges its meaning (HR-84). A retired
// marker is not a change to review.
export function releasedSpecReview(released: string, current: string, tag: string): ReviewEntry[] {
  const before = statements(released);
  const after = statements(current);
  const entries: ReviewEntry[] = [];
  for (const [id, body] of before) {
    const now = after.get(id);
    if (now !== undefined && now !== body && !now.startsWith('Retired')) {
      entries.push({ id, tag, released: body, current: now });
    }
  }
  return entries;
}
