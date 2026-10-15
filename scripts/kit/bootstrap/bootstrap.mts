#!/usr/bin/env node
// The first step of the bootstrap of a repository (`make install-tools TOOLS=npm` of kit-bootstrap.mk, before the package
// @polyspec/kit is installed): installs the mise of config/toolchain.json, then with it the Node.js of mise.toml at the digest
// of mise.lock, then the npm of packageManager into var/tools, with the wrappers of var/tools/bin; the wrappers npm and npx
// run that npm with that node. The node of the machine only starts this script, whatever its release (K171); every later
// step, npm ci first, runs the node of the checkout. npm installs the packages and mise installs the other tools. A
// repository holds this directory as a copy, so the module imports only Node.js built-ins and the modules of its directory.
// It runs in the root of the repository.
//
//   node scripts/kit/bootstrap/bootstrap.mts
import { installMise, installNode } from './install-mise.mts';
import { installNpm } from './install-npm.mts';
import { declaredToolchain } from './toolchain-declared.mts';

/** Installs the mise, the node and the npm that the checkout at `root` declares; throws an Error that names the cause. */
function bootstrap(root: string, print: (text: string) => void) {
  const declared = declaredToolchain(root);
  if (!declared.npm) throw new Error('package.json is missing; its packageManager pins the npm to install');
  if (!declared.mise) throw new Error('config/toolchain.json declares no mise; declare its version and the sha256 of its archive of each platform');
  installMise({ root, declared: declared.mise, print });
  const node = installNode({ root, print });
  installNpm({ root, declared: declared.npm, node, print });
}

try {
  bootstrap(process.cwd(), text => console.log(`[bootstrap] ${text}`));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  // declaredToolchain, the checks above and the installs fail with an Error.
  console.error(`[bootstrap] ${error.message}`);
  process.exit(1);
}
