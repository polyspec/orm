// The release-spec check on the real tree (T682, HR-84): every EN spec file of the latest version tag is compared with the
// same file of the working tree. An identifier of the released spec that the current spec no longer holds fails. A changed
// body is printed as a review entry with its id, tag and both bodies, for a reviewer to judge.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { latestVersionTag, releasedSpecErrors, releasedSpecFor, releasedSpecReview } from './spec-release.mts';

const tag = latestVersionTag('.');
const files = execFileSync('git', ['ls-tree', '--name-only', tag, 'docs/spec/'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.md') && !file.endsWith('.ko.md'));

let failures = 0;
let reviews = 0;
for (const file of files) {
  const released = releasedSpecFor('.', file).text;
  const current = readFileSync(file, 'utf8');
  for (const error of releasedSpecErrors(released, current, tag)) {
    console.error(`spec-release-check: ${file}: ${error}`);
    failures++;
  }
  for (const entry of releasedSpecReview(released, current, tag)) {
    console.log(`REVIEW ${file} ${entry.id} (${entry.tag})`);
    console.log(`  released: ${entry.released}`);
    console.log(`  current:  ${entry.current}`);
    reviews++;
  }
}
console.log(`spec-release-check: ${files.length} files against ${tag}; ${reviews} review entries; ${failures} absent identifiers`);
if (failures > 0) process.exit(1);
