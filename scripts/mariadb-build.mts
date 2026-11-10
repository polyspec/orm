// make orm-install-mariadb builds, on a machine whose package manager has no MariaDB, the MariaDB server of the test servers from
// the source release of the MariaDB Foundation, pinned by its version and sha256, with cmake into var/mariadb/<version>, where the
// locked tools of orm live (var/tools). The CI runner installs the same release from the Ubuntu packages (scripts/ci/server-programs.mts);
// MARIADB_VERSION is the one version both read. The build uses only the cmake, compiler and libraries of the machine: the TLS
// library (wolfSSL) and zlib are the copies in the source release, and PCRE2 and fmt are the ones the machine has, found through
// pkg-config; a missing one fails the configure step with its name. The pre-generated parsers of the release are used, so no
// bison is needed. A finished build is known by the version line of its mariadbd; then the script changes nothing. The source and
// the build folders are removed after the install, and kept with their logs when a step fails.
//
// Usage: node scripts/mariadb-build.mts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** MARIADB_VERSION is the MariaDB release of the test servers, locally built and installed on the CI runner. */
export const MARIADB_VERSION = '11.8.6';
/** MARIADB_SOURCE is the source release of MARIADB_VERSION and MARIADB_SOURCE_SHA256 its digest, from its sha256sums.txt. */
export const MARIADB_SOURCE = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/source/mariadb-${MARIADB_VERSION}.tar.gz`;
export const MARIADB_SOURCE_SHA256 = 'b126581a8ca89376d2a3ce63fee97c114c3e15315345e769b9d00c51e1b7d619';
/** MARIADB_VERSION_LINE is what `mariadbd --version` prints for MARIADB_VERSION, a build of it or the Ubuntu package. */
export const MARIADB_VERSION_LINE = new RegExp(` Ver ${MARIADB_VERSION.replaceAll('.', '\\.')}-MariaDB`);

const ROOT = resolve(import.meta.dirname, '..');
/** mariadbPrefix is the folder that the build of MARIADB_VERSION installs into; its bin folder holds mariadbd. */
export const mariadbPrefix = (root = ROOT): string => join(root, 'var/mariadb', MARIADB_VERSION);

// The plugins and parts the test servers do not start are left out: they need libraries the build does not use and would
// only lengthen it. The server keeps InnoDB, Aria, MyISAM and the plugins compiled in by default. DTrace probes are left out:
// MariaDB turns them on when the machine has dtrace, and on arm64 macOS the compiler moved the error path of my_net_write
// (sql/net_serv.cc, MYSQL_NET_WRITE_DONE) into a shared stub that ends in a jump to the probe, which the linker then replaced
// with a nop, so the stub ran on into the next function and the server crashed (signal 11 in find_named) whenever a client
// went away while the server wrote to it.
export const CMAKE_OPTIONS = [
  '-DCMAKE_BUILD_TYPE=RelWithDebInfo', '-DWITH_SSL=bundled', '-DWITH_ZLIB=bundled', '-DWITH_PCRE=system', '-DWITH_LIBFMT=system',
  '-DWITH_UNIT_TESTS=OFF', '-DWITH_EMBEDDED_SERVER=OFF', '-DWITH_WSREP=OFF', '-DWITH_MARIABACKUP=OFF', '-DENABLE_DTRACE=OFF',
  ...['ROCKSDB', 'MROONGA', 'SPIDER', 'CONNECT', 'COLUMNSTORE', 'S3', 'OQGRAPH', 'SPHINX', 'HASHICORP_KEY_MANAGEMENT', 'AUTH_GSSAPI', 'AUTH_PAM']
    .map(plugin => `-DPLUGIN_${plugin}=NO`),
];

const fail = (message: string): never => {
  console.error(`mariadb-build: ${message}`);
  process.exit(1);
};

/** BUILD_OPTIONS_FILE is the file of the prefix that names the CMAKE_OPTIONS of its build, one per line. */
export const BUILD_OPTIONS_FILE = 'build-options.txt';
/** buildOptionsText is the text of BUILD_OPTIONS_FILE for the options of a build. */
export const buildOptionsText = (options: readonly string[] = CMAKE_OPTIONS): string => `${options.join('\n')}\n`;

// installed reports whether prefix holds a mariadbd of MARIADB_VERSION built with CMAKE_OPTIONS: a build of other options, or of
// none recorded, is built again.
function installed(prefix: string): boolean {
  const server = join(prefix, 'bin/mariadbd');
  if (!existsSync(server)) return false;
  const line = spawnSync(server, ['--version'], { encoding: 'utf8' }).stdout ?? '';
  if (!MARIADB_VERSION_LINE.test(line)) fail(`${server} prints ${JSON.stringify(line.trim())}, not MariaDB ${MARIADB_VERSION}; remove ${prefix} and run make orm-install-mariadb again`);
  const recorded = join(prefix, BUILD_OPTIONS_FILE);
  if (existsSync(recorded) && readFileSync(recorded, 'utf8') === buildOptionsText()) return true;
  console.log(`mariadb-build: ${prefix} was built with other options than CMAKE_OPTIONS; building it again`);
  return false;
}

// step runs one build step with its output in <log>, and fails naming the step and the log.
function step(name: string, log: string, program: string, args: string[], cwd: string): void {
  console.log(`mariadb-build: ${name}`);
  const fd = openSync(log, 'w');
  const ran = spawnSync(program, args, { cwd, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  if (ran.error) fail(`${name}: ${program}: ${ran.error.message}`);
  if (ran.status !== 0) fail(`${name} exited with ${ran.status ?? ran.signal}; see ${log}`);
}

async function main(): Promise<void> {
  const prefix = mariadbPrefix();
  if (installed(prefix)) {
    console.log(`mariadb-build: MariaDB ${MARIADB_VERSION} is installed in ${prefix}`);
    return;
  }
  const work = join(ROOT, 'var/mariadb', `build-${MARIADB_VERSION}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'build'), { recursive: true });
  const fmt = spawnSync('pkg-config', ['--variable=includedir', 'fmt'], { encoding: 'utf8' });
  if (fmt.status !== 0 || !fmt.stdout.trim()) fail('pkg-config finds no fmt; the build takes the fmt headers of the machine');
  console.log(`mariadb-build: downloading ${MARIADB_SOURCE}`);
  const response = await fetch(MARIADB_SOURCE);
  if (!response.ok) fail(`${MARIADB_SOURCE} answered ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== MARIADB_SOURCE_SHA256) fail(`${MARIADB_SOURCE} has the sha256 ${digest}, not ${MARIADB_SOURCE_SHA256}`);
  const tarball = join(work, `mariadb-${MARIADB_VERSION}.tar.gz`);
  writeFileSync(tarball, archive);
  step('unpack', join(work, 'unpack.log'), 'tar', ['-xzf', tarball], work);
  const source = join(work, `mariadb-${MARIADB_VERSION}`);
  const build = join(work, 'build');
  step('configure', join(work, 'configure.log'), 'cmake',
    [source, `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DLIBFMT_INCLUDE_DIR=${fmt.stdout.trim()}`, ...CMAKE_OPTIONS], build);
  step('build', join(work, 'build.log'), 'cmake', ['--build', '.', '--parallel', String(cpus().length)], build);
  // The install replaces the whole prefix, so no file of another build stays in it.
  rmSync(prefix, { recursive: true, force: true });
  step('install', join(work, 'install.log'), 'cmake', ['--install', '.'], build);
  writeFileSync(join(prefix, BUILD_OPTIONS_FILE), buildOptionsText());
  if (!installed(prefix)) fail(`the install wrote no ${join(prefix, 'bin/mariadbd')}; see ${join(work, 'install.log')}`);
  rmSync(work, { recursive: true, force: true });
  console.log(`mariadb-build: MariaDB ${MARIADB_VERSION} installed in ${prefix}`);
}

if (import.meta.main) await main();
