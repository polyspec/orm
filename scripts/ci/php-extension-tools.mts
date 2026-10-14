// make install-php-extension-tools installs what the build and the checks of the PHP extension orm_dbspec
// (packages/php-ext, C built with phpize) need besides the PHP of .php-version: it checks that phpize and php-config
// belong to the PHP on PATH, and it copies gen_stub.php of that PHP with its PHP-Parser into .runtime/bin/gen-stub, which
// make php-extension-arginfo and the arginfo check of make dbspec-php-extension-check run offline. gen_stub.php downloads
// its PHP-Parser when its directory has none, so this install step does that once.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fail = (message: string): never => {
  console.error(`php-extension-tools: ${message}`);
  process.exit(1);
};
const output = (program: string, args: string[]): string | undefined => {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const configured = output('php-config', ['--version']) ?? fail('php-config is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)');
const phpize = output('sh', ['-c', 'command -v phpize']) ?? fail('phpize is not on PATH; install the PHP development files of .php-version (the setup-php step gives them in CI)');
const running = output('php', ['-r', 'echo PHP_VERSION;']) ?? fail('php does not run');
if (configured !== running) fail(`php-config reports PHP ${configured}, but php is PHP ${running}; put the development files of the same PHP on PATH`);
console.log(`php-extension-tools: php-config ${configured}`);
// phpize is a shell script that names the build directory of its PHP in the variables prefix, exec_prefix and phpdir;
// the shell evaluates those assignments of it, which may refer to one another.
const assignments = readFileSync(phpize, 'utf8').split('\n').filter(line => /^(prefix|datarootdir|exec_prefix|phpdir)=/.test(line)).join('\n');
const phpdir = output('sh', ['-c', `${assignments}\nprintf %s "$phpdir"`]) ?? fail(`${phpize} names no phpdir`);
if (!existsSync(join(phpdir, 'gen_stub.php'))) fail(`${phpdir}/gen_stub.php does not exist; phpize copies it from there, so install the PHP development files of .php-version`);
const dest = '.runtime/bin/gen-stub';
const parsers = (directory: string) => (existsSync(directory) ? readdirSync(directory).filter(name => name.startsWith('PHP-Parser-')) : []);
const same = existsSync(join(dest, 'gen_stub.php')) && readFileSync(join(dest, 'gen_stub.php')).equals(readFileSync(join(phpdir, 'gen_stub.php')));
if (same && parsers(dest).length > 0) {
  console.log(`php-extension-tools: ${dest}/gen_stub.php is the one of this PHP and has its PHP-Parser`);
  process.exit(0);
}
const work = `${dest}.tmp.${process.pid}`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(join(phpdir, 'gen_stub.php'), join(work, 'gen_stub.php'));
for (const parser of parsers(phpdir)) cpSync(join(phpdir, parser), join(work, parser), { recursive: true });
if (parsers(work).length === 0) {
  // gen_stub.php installs its PHP-Parser into its own directory when it first parses a stub.
  writeFileSync(join(work, 'probe.stub.php'), '<?php\nfunction probe(): void {}\n');
  const probed = spawnSync('php', [join(work, 'gen_stub.php'), join(work, 'probe.stub.php')], { stdio: 'inherit' });
  if (probed.status !== 0) fail(`gen_stub.php exited with ${probed.status ?? probed.signal ?? 'no status'}`);
  rmSync(join(work, 'probe.stub.php'), { force: true });
  rmSync(join(work, 'probe_arginfo.h'), { force: true });
}
const installed = parsers(work)[0] ?? fail(`gen_stub.php did not install PHP-Parser into ${work}`);
rmSync(dest, { recursive: true, force: true });
renameSync(work, dest);
console.log(`php-extension-tools: ${dest}/gen_stub.php with ${installed}`);
