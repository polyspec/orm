// The GitHub Release of a repository through the gh CLI, shared by the release tools and the release proof: the release
// of a tag with its drafts, and the download of one asset by its id. A draft is listed only for a user with push access, and
// the release workflow runs with that access.
import { closeSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { run, Stop } from './process.mjs';

/** `{ hostname, repo }` of a repository URL: the host of `gh api --hostname` and the OWNER/REPO of `repos/`. */
export function repositoryParts(url) {
  const { host, pathname } = new URL(url);
  const repo = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!repo) throw new Stop(`${url} names no OWNER/REPO`);
  return { hostname: host, repo };
}

/** The release of `tag` in the repository, drafts included, as `{ id, tag_name, draft, assets: [{ id, name, url, digest }] }`, or null. `url` is the download URL of an asset and `digest` its `sha256:<hex>`, as GitHub lists them. */
export function releaseOf(options, url, tag) {
  const { hostname, repo } = repositoryParts(url);
  const listed = run('gh', ['api', '--hostname', hostname, '--paginate', `repos/${repo}/releases`, '--jq', '.[] | {id, tag_name, draft, assets: [.assets[] | {id, name, url: .browser_download_url, digest}]} | @json'], options);
  const releases = listed.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
  return releases.find(release => release.tag_name === tag) ?? null;
}

/** Writes the binary of asset `id` of the repository to `file`, read through the API with the octet-stream media type. */
export function downloadAsset(options, url, id, file) {
  const { hostname, repo } = repositoryParts(url);
  const args = ['api', '--hostname', hostname, '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${id}`];
  const fd = openSync(file, 'w');
  try {
    const result = spawnSync('gh', args, { cwd: options.cwd, env: options.env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
    if (result.error) throw new Stop(`gh ${args.join(' ')} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Stop(`gh ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`);
  } finally {
    closeSync(fd);
  }
}
