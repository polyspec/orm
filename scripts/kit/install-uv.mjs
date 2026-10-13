// Installs the uv release that config/toolchain.json uv declares into var/tools/uv, with the wrapper uv in var/tools/bin. The
// archive is uv-<target>.tar.gz of the GitHub release of uv for this platform; the download is refused unless its sha256 is
// the digest that the declaration gives for the platform, and it is unpacked as it is. The wrapper sets every directory that
// uv writes to under var/tools (the cache and the Python installs), reads no uv.toml of the home (UV_NO_CONFIG) and lets uv
// download a Python only by `uv python install` (UV_PYTHON_DOWNLOADS=manual). An installed release is kept. The uv of the
// machine is never used.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileDigest } from './digest.mjs';
import { installOnce } from './install-tool.mjs';
import { bootstrapEnvironment, printedRelease, quote, run, toolsPath, wrapperText, writeWrapper } from './tool-wrappers.mjs';

// The target of the uv archive of each platform key (process.platform-process.arch) that the declaration may name.
export const UV_TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

/** The download URL of the uv archive of `version` for the target `target`. */
export const uvArchiveUrl = (version, target) => `https://github.com/astral-sh/uv/releases/download/${version}/uv-${target}.tar.gz`;

// The text of the wrapper uv: the state of uv under var/tools, then the installed binary.
function uvWrapper(root, binary, version) {
  const lines = [
    `UV_CACHE_DIR=${quote(toolsPath(root, 'uv-cache'))}`,
    `UV_PYTHON_INSTALL_DIR=${quote(toolsPath(root, 'uv-python'))}`,
    'UV_NO_CONFIG=1',
    'UV_PYTHON_DOWNLOADS=manual',
    'export UV_CACHE_DIR UV_PYTHON_INSTALL_DIR UV_NO_CONFIG UV_PYTHON_DOWNLOADS',
    `exec ${quote(binary)} "$@"`,
  ];
  return wrapperText(`uv ${version} of this checkout`, lines.join('\n'));
}

/** Installs the declared uv `{ version, sha256 }` (sha256 by platform key) into var/tools/uv of `root` and writes the wrapper. */
export function installUv({ root, declared, platform = `${process.platform}-${process.arch}`, print = () => {} }) {
  const target = UV_TARGETS[platform];
  if (!target) throw new Error(`no uv archive is verified for ${platform}; the verified platforms are ${Object.keys(UV_TARGETS).join(', ')}`);
  const sha256 = declared.sha256[platform];
  if (!sha256) throw new Error(`config/toolchain.json uv declares no sha256 for ${platform}; declare the digest of uv-${target}.tar.gz of the uv release ${declared.version}`);
  const url = uvArchiveUrl(declared.version, target);
  const prefix = toolsPath(root, 'uv');
  const binary = directory => path.join(directory, `uv-${target}`, 'uv');
  const result = installOnce({
    root, label: 'uv', prefix, recorded: declared.version, installedRelease: directory => printedRelease(binary(directory), 'uv'), print,
    install: (next) => {
      const archive = path.join(next, `uv-${target}.tar.gz`);
      const environment = bootstrapEnvironment(root);
      run('curl', ['--fail', '--silent', '--show-error', '--location', '--output', archive, url], { cwd: root, env: environment }, print);
      const actual = fileDigest(archive);
      if (actual !== sha256) {
        rmSync(archive, { force: true });
        throw new Error(`${url} has the sha256 ${actual}; config/toolchain.json uv declares ${sha256} for ${platform}`);
      }
      run('tar', ['-xzf', archive, '-C', next], { cwd: root, env: environment }, print);
      rmSync(archive, { force: true });
    },
  });
  writeWrapper(root, 'uv', uvWrapper(root, binary(prefix), declared.version), print);
  return result;
}
