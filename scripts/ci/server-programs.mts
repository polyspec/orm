// make orm-install-server-programs installs, on the Linux runner of CI, the programs from which make orm-test-servers starts the
// servers of the database checks, as it does locally: MySQL 8.4 from the Ubuntu packages of the runner, PostgreSQL 17 and PgBouncer
// from the PostgreSQL apt repository, and ProxySQL 3.0.9 from its Ubuntu 24.04 arm64 package, checked by its sha256,
// whose dependencies Ubuntu 26.04 provides. make orm-test-servers finds mysqld at its package path /usr/sbin/mysqld on PATH.
//
// The MySQL and the MariaDB packages of Ubuntu conflict (mariadb-client-core conflicts with virtual-mysql-client-core, which
// mysql-client-core provides), so a runner holds one of them: the argument names the server family of the CI group, mysql or
// mariadb, which make orm-install-server-programs reads from the need mariadb-server of the targets of the group
// (scripts/check/ci-setup.mts). With mariadb the script installs mariadb-server-core and mariadb-client-core of the Ubuntu
// archive, mariadb-client, which holds mariadb-admin and mariadb-tzinfo-to-sql, and the ProxySQL of the MySQL
// family, from which make orm-test-mariadb starts the MariaDB servers and the ProxySQL in front of the primary, and no MySQL,
// PostgreSQL or PgBouncer.
// The image loads an AppArmor profile for /usr/sbin/mysqld that allows only /var/lib/mysql; it is removed because the
// servers keep their data in .runtime/servers. In a GitHub Actions job the PostgreSQL bin directory is added to GITHUB_PATH.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const PROXYSQL = 'https://repo.proxysql.com/ProxySQL/proxysql-3.0.x/noble/proxysql_3.0.9-ubuntu24_arm64.deb';
const PROXYSQL_SHA256 = 'e12b272107f1ac65ae8a9f9015a9c696b7b2f78b6ad35f84b5ce086449eb2a0f';
const PROXYSQL_FILE = '/tmp/proxysql.deb';

const fail = (message: string): never => {
  console.error(`server-programs: ${message}`);
  process.exit(1);
};
// run runs a command with its output shown, or quiet when the command is chatty; a failure stops the install.
function run(program: string, args: string[], { quiet = false, input }: { quiet?: boolean; input?: string } = {}): void {
  const result = spawnSync(program, args, { stdio: [input === undefined ? 'inherit' : 'pipe', quiet ? 'ignore' : 'inherit', 'inherit'], ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) fail(`${[program, ...args].join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`);
}
// version runs a program for its version line and prints it for the record of the run; a program that does not run fails the
// install. What is installed decides the version: the package or repository named here, or the file pinned by its sha256. The
// version an install gives is the package manager's to decide, so no line is compared.
function version(program: string, args: string[]): void {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  const line = (result.stdout || result.stderr || '').split('\n')[0] ?? '';
  console.log(line);
  if (result.status !== 0) fail(`${[program, ...args].join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`);
}

// proxysql installs the ProxySQL package, checked by its sha256; both families start a ProxySQL.
async function proxysql(): Promise<void> {
  const response = await fetch(PROXYSQL);
  if (!response.ok) fail(`${PROXYSQL} answered ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== PROXYSQL_SHA256) fail(`${PROXYSQL} has the sha256 ${digest}, not ${PROXYSQL_SHA256}`);
  writeFileSync(PROXYSQL_FILE, archive);
  run('sudo', ['apt-get', 'install', '-y', '-q', PROXYSQL_FILE], { quiet: true });
  version('proxysql', ['--version']);
}

const family = process.argv[2];
if (family !== 'mysql' && family !== 'mariadb') fail(`usage: server-programs.mts mysql | mariadb; got ${JSON.stringify(family ?? '')}`);

run('sudo', ['apt-get', 'update', '-q'], { quiet: true });
if (family === 'mariadb') {
  run('sudo', ['apt-get', 'install', '-y', '-q', 'mariadb-server-core', 'mariadb-client-core', 'mariadb-client'], { quiet: true });
  // The AppArmor profile of /usr/sbin/mariadbd is removed when the image loads one, as the one of mysqld below.
  if (spawnSync('sudo', ['grep', '-qs', '^/usr/sbin/mariadbd ', '/sys/kernel/security/apparmor/profiles']).status === 0)
    run('sudo', ['tee', '/sys/kernel/security/apparmor/.remove'], { quiet: true, input: '/usr/sbin/mariadbd' });
  version('mariadbd', ['--version']);
  await proxysql();
  process.exit(0);
}
run('sudo', ['apt-get', 'install', '-y', '-q', 'postgresql-common', 'sqlite3', 'mysql-server-core', 'mysql-client-core'], { quiet: true });
run('sudo', ['/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh', '-y'], { quiet: true });
run('sudo', ['apt-get', 'install', '-y', '-q', 'postgresql-17', 'pgbouncer'], { quiet: true });
await proxysql();
// The AppArmor profile of /usr/sbin/mysqld is removed when the image loads one.
if (spawnSync('sudo', ['grep', '-qs', '^/usr/sbin/mysqld ', '/sys/kernel/security/apparmor/profiles']).status === 0)
  run('sudo', ['tee', '/sys/kernel/security/apparmor/.remove'], { quiet: true, input: '/usr/sbin/mysqld' });
const mysqld = spawnSync('sh', ['-c', 'command -v mysqld'], { encoding: 'utf8' }).stdout.trim();
if (mysqld !== '/usr/sbin/mysqld') fail(`mysqld on PATH is ${JSON.stringify(mysqld)}, not /usr/sbin/mysqld`);
version('mysqld', ['--version']);
version('/usr/lib/postgresql/17/bin/postgres', ['--version']);
version('pgbouncer', ['--version']);
version('sqlite3', ['--version']);
const githubPath = process.env['GITHUB_PATH'];
if (githubPath) appendFileSync(githubPath, '/usr/lib/postgresql/17/bin\n');
