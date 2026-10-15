#!/usr/bin/env node
// The first step of the bootstrap of a repository (`make install-tools TOOLS=npm` of kit-bootstrap.mk, before the package
// @polyspec/kit is installed): requires the running node to be the release of .node-version, then installs the npm of
// packageManager and the mise of config/toolchain.json into var/tools with the wrappers of var/tools/bin. npm installs the
// packages and mise installs the other tools (mise.toml, mise.lock). A repository holds this directory as a copy, so the
// module imports only Node.js built-ins and the modules of its directory. It runs in the root of the repository.
//
//   node scripts/kit/bootstrap/bootstrap.mts
import { installMise } from './install-mise.mts';
import { installNpm } from './install-npm.mts';
import { declaredToolchain } from './toolchain-declared.mts';

/** Requires the node of .node-version in `root`, then installs the npm and the mise that the checkout declares; throws an Error that names the cause. */
function bootstrap(root: string, running: string, print: (text: string) => void) {
  const declared = declaredToolchain(root);
  if (!declared.node) throw new Error('.node-version is missing; it pins the Node.js release that installs npm');
  if (declared.node.version !== running) throw new Error(`node ${running} is running, but .node-version pins ${declared.node.version}; install node ${declared.node.version} and run make install-tools TOOLS=npm again`);
  if (!declared.npm) throw new Error('package.json is missing; its packageManager pins the npm to install');
  if (!declared.mise) throw new Error('config/toolchain.json declares no mise; declare its version and the sha256 of its archive of each platform');
  installNpm({ root, declared: declared.npm, print });
  installMise({ root, declared: declared.mise, print });
}

try {
  bootstrap(process.cwd(), process.versions.node, text => console.log(`[bootstrap] ${text}`));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  // declaredToolchain, the checks above and the installs fail with an Error.
  console.error(`[bootstrap] ${error.message}`);
  process.exit(1);
}
