// make install-server-programs installs, on the Linux runner of CI, the programs from which make test-servers starts the
// servers of the database checks, as it does locally: MySQL 8.4.11 from the Ubuntu packages, PostgreSQL 17 and PgBouncer
// from the PostgreSQL apt repository, and ProxySQL 3.0.9 from its Ubuntu 24.04 arm64 package, checked by its sha256,
// whose dependencies Ubuntu 26.04 provides. make test-servers finds mysqld at its package path /usr/sbin/mysqld on PATH.
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
// version runs a program for its version line, prints it for the record of the run and requires the pattern.
function version(program: string, args: string[], pattern: RegExp): void {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  const line = (result.stdout || result.stderr).split('\n')[0] ?? '';
  console.log(line);
  if (result.status !== 0 || !pattern.test(line)) fail(`${[program, ...args].join(' ')} printed ${JSON.stringify(line)}, not ${pattern}`);
}

run('sudo', ['apt-get', 'update', '-q'], { quiet: true });
run('sudo', ['apt-get', 'install', '-y', '-q', 'postgresql-common', 'sqlite3', 'mysql-server-core', 'mysql-client-core'], { quiet: true });
run('sudo', ['/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh', '-y'], { quiet: true });
run('sudo', ['apt-get', 'install', '-y', '-q', 'postgresql-17', 'pgbouncer'], { quiet: true });
const response = await fetch(PROXYSQL);
if (!response.ok) fail(`${PROXYSQL} answered ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== PROXYSQL_SHA256) fail(`${PROXYSQL} has the sha256 ${digest}, not ${PROXYSQL_SHA256}`);
writeFileSync(PROXYSQL_FILE, archive);
run('sudo', ['apt-get', 'install', '-y', '-q', PROXYSQL_FILE], { quiet: true });
// The AppArmor profile of /usr/sbin/mysqld is removed when the image loads one.
if (spawnSync('sudo', ['grep', '-qs', '^/usr/sbin/mysqld ', '/sys/kernel/security/apparmor/profiles']).status === 0)
  run('sudo', ['tee', '/sys/kernel/security/apparmor/.remove'], { quiet: true, input: '/usr/sbin/mysqld' });
const mysqld = spawnSync('sh', ['-c', 'command -v mysqld'], { encoding: 'utf8' }).stdout.trim();
if (mysqld !== '/usr/sbin/mysqld') fail(`mysqld on PATH is ${JSON.stringify(mysqld)}, not /usr/sbin/mysqld`);
version('mysqld', ['--version'], / Ver 8\.4\.11[- ]/);
version('proxysql', ['--version'], /ProxySQL version 3\.0\.9-/);
// The PostgreSQL apt repository keeps only the newest minor release of PostgreSQL 17 and of PgBouncer, so the major release
// is what can be pinned; the versions are printed for the record of the run.
version('/usr/lib/postgresql/17/bin/postgres', ['--version'], /^postgres \(PostgreSQL\) 17\./);
version('pgbouncer', ['--version'], /./);
version('sqlite3', ['--version'], /./);
const githubPath = process.env['GITHUB_PATH'];
if (githubPath) appendFileSync(githubPath, '/usr/lib/postgresql/17/bin\n');
