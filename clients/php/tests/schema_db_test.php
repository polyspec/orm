<?php
// Schema tool database test: import, validate, migrate, and db: sources give
// the same results as the Go tooling, and a live table takes an incremental
// migration, on SQLite and, when ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN
// name scratch databases, on MySQL and PostgreSQL. The test drops every table
// in those databases.
// The Go tool is built from this repository (or taken from $ORMGEN_BIN).
// Usage: php clients/php/tests/schema_db_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\SchemaBuilder;
use Orm\SchemaChecks;
use Orm\SchemaDdl;
use Orm\SchemaDiff;
use Orm\SchemaImport;
use Orm\SchemaMigrate;
use Orm\SchemaParser;
use Orm\SchemaPlan;
use Orm\SchemaTool;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-schema-db-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$ormgen = getenv('ORMGEN_BIN') ?: "$work/ormgen";
if (!getenv('ORMGEN_BIN')) {
    exec('cd ' . escapeshellarg($root) . ' && GOWORK=off go build -o ' . escapeshellarg($ormgen) . ' ./cmd/ormgen 2>&1', $output, $code);
    if ($code !== 0) {
        fwrite(STDERR, "php schema db test: cannot build ormgen:\n" . implode("\n", $output) . "\n");
        exit(1);
    }
}

$failures = 0;
$current = '';
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

/** @return array{int, string, string} exit status, stdout, stderr */
function php(array $args): array
{
    ob_start();
    $stderr = fopen('php://memory', 'w+');
    $code = SchemaTool::run($args, $stderr);
    $out = (string) ob_get_clean();
    rewind($stderr);
    return [$code, $out, (string) stream_get_contents($stderr)];
}

/** @return array{int, string, string} */
function go(array $args): array
{
    global $ormgen;
    $proc = proc_open(array_merge([$ormgen], $args), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($proc), (string) $out, (string) $err];
}

function wipe(string $driver, string $dsn): void
{
    [, $pdo] = SchemaImport::connect($dsn);
    if ($driver === 'mysql') {
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach ($pdo->query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE `$t`");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
    } elseif ($driver === 'postgres') {
        foreach ($pdo->query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()")->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE IF EXISTS \"$t\" CASCADE");
        }
    } else {
        foreach ($pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $pdo->exec("DROP TABLE \"$t\"");
        }
    }
}

function same(array $php, array $go, string $what): void
{
    $strip = static fn(string $s): string => str_replace(['orm-gen: ', 'ormgen: '], '', $s);
    check($php[0] === $go[0], "$what exit status php={$php[0]} go={$go[0]}\n{$php[2]}\n{$go[2]}");
    check($php[1] === $go[1], "$what output\n--- php\n{$php[1]}--- go\n{$go[1]}");
    if ($php[0] !== 0) {
        check($strip($php[2]) === $strip($go[2]), "$what error\n--- php\n{$php[2]}--- go\n{$go[2]}");
    }
}

/**
 * Creates a table with an automatic key, clock defaults, an update-time
 * column, a full-text index, a CHECK constraint, and comments; compares it
 * with its declaration; adds a commented column in the middle of the
 * declaration; and removes it again.
 */
function liveCycle(string $driver, string $dsn): void
{
    $base = "erDiagram\n"
        . "  live_article {\n"
        . "    bigint       seq         PK \"auto\"\n"
        . "    varchar(191) title\n"
        . "    text         body           \"?\"\n"
        . "    int          quantity       \"=0\"\n"
        . "    datetime(6)  created_ts     \"=now\"\n"
        . "    datetime(6)  updated_ts     \"=now onupdate\"\n"
        . "  }\n"
        . "  %% fulltext live_article (title, body)\n"
        . "  %% check live_article live_article_quantity : `quantity` >= 0 AND `quantity` IN (0, 1, 2, 5)\n"
        . "  %% column_comment live_article title \"headline\"\n";
    $targetSrc = str_replace("    text         body", "    varchar(32)  subtitle       \"?\"\n    text         body", $base)
        . "  %% column_comment live_article subtitle \"secondary headline\"\n";
    $build = static fn(string $src): array => SchemaBuilder::build([SchemaParser::parse($src)]);
    $base = $build($base);
    $target = $build($targetSrc);
    [, $db] = SchemaImport::connect($dsn);
    $q = SchemaDdl::quoter($driver);
    $db->exec('DROP TABLE IF EXISTS ' . $q('live_article'));
    $state = static function (array $want) use ($db, $driver): array {
        $all = SchemaImport::liveManifest($db, $driver);
        check(isset($all['entities']['live_article']), 'live_article is missing from the database');
        $live = ['schema_hash' => $all['schema_hash'], 'order' => ['live_article'], 'entities' => ['live_article' => $all['entities']['live_article']], 'orm' => [], 'external_fks' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []];
        SchemaChecks::alignLive($db, $driver, $live, $want);
        return $live;
    };
    SchemaMigrate::execute($db, $driver, SchemaDdl::renderCreate($base, $driver));
    $db->exec('INSERT INTO ' . $q('live_article') . ' (' . $q('title') . ', ' . $q('quantity') . ") VALUES ('kept', 2)");
    // a db: source aligned with a declaration carries the hash of its new
    // content, so a plan that embeds it loads again
    $source = SchemaTool::source("db:$dsn", $driver);
    $before = $source['schema_hash'];
    $declared = $target;
    SchemaChecks::alignSources("db:$dsn", 'target.mmd', $source, $declared);
    check($source['entities']['live_article']['checks'][0]['expr'] === $target['entities']['live_article']['checks'][0]['expr'], 'live check was not aligned');
    check($source['schema_hash'] !== $before, 'aligned source kept its previous schema hash');
    $plan = json_decode(SchemaPlan::render($source, $target, $driver, '20260917-live-source', 'live source'), true);
    check($plan['from_schema_hash'] === $source['schema_hash'] && $plan['from_schema']['schema_hash'] === $source['schema_hash'], 'plan source hash');
    SchemaBuilder::load(json_encode($plan['from_schema']));
    $live = $state($base);
    check(SchemaMigrate::schemaMatches($base, $live, $driver), 'created schema does not match: ' . implode('; ', SchemaImport::differences($base, $live)));
    $unchanged = SchemaDiff::render($live, $base, $driver, false);
    check(str_contains($unchanged, '-- no changes'), "unchanged table has a diff:\n$unchanged");
    $forward = SchemaDiff::render($live, $target, $driver, false);
    check(!str_contains($forward, '__orm_rebuild_'), "adding a nullable column rebuilds the table:\n$forward");
    SchemaMigrate::execute($db, $driver, $forward);
    $live = $state($target);
    check(SchemaMigrate::schemaMatches($target, $live, $driver), 'added column does not verify: ' . implode('; ', SchemaImport::differences($target, $live)));
    $repeat = SchemaDiff::render($live, $target, $driver, false);
    check(str_contains($repeat, '-- no changes'), "repeat after add column:\n$repeat");
    SchemaMigrate::execute($db, $driver, SchemaDiff::render($live, $base, $driver, true));
    $live = $state($base);
    check(SchemaMigrate::schemaMatches($base, $live, $driver), 'removed column does not verify: ' . implode('; ', SchemaImport::differences($base, $live)));
    $final = SchemaDiff::render($live, $base, $driver, false);
    check(str_contains($final, '-- no changes'), "repeat after remove column:\n$final");
    $row = $db->query('SELECT ' . $q('title') . ', ' . $q('quantity') . ' FROM ' . $q('live_article'))->fetch(PDO::FETCH_NUM);
    check($row !== false && $row[0] === 'kept' && (int) $row[1] === 2, 'row: ' . json_encode($row));
    $db->exec('DROP TABLE IF EXISTS ' . $q('live_article'));
}

$bench = (string) file_get_contents("$root/schema/bench.mmd");
file_put_contents("$work/bench.mmd", $bench . "\n  %% table_comment battle \"physical battle table\"\n  %% column_comment battle name \"physical battle name\"\n");
$small = <<<'MMD'
erDiagram
  team {
    bigint        seq   PK "auto"
    varchar(80)   name
  }
  member {
    bigint        seq      PK "auto"
    bigint        team_seq FK
    varchar(80)   name
    int           score       "=0"
  }
  team ||--o{ member : team_seq
  %% table_comment team "teams"

MMD;
file_put_contents("$work/v1.mmd", $small);
file_put_contents("$work/v2.mmd", str_replace("    int           score       \"=0\"\n", "    int           score       \"=0\"\n    varchar(40)   note        \"?\"\n", $small)
    . "  tag {\n    bigint seq PK \"auto\"\n    varchar(40) label\n  }\n  %% index member (note) ix_note\n");

$targets = ['sqlite' => "sqlite://$work/schema.sqlite"];
foreach (['mysql' => 'ORM_TOOLS_MYSQL_DSN', 'postgres' => 'ORM_TOOLS_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if (is_string($v) && $v !== '') {
        $targets[$driver] = $v;
    }
}

foreach ($targets as $driver => $dsn) {
    $current = $driver;
    try {
        wipe($driver, $dsn);
        $logs = "$work/logs-$driver";

        // the bench schema: initial plan, apply, repeat, live source, import, validate
        same(php(['migrate', '--dsn', $dsn, '--schema', "$work/bench.mmd", '--dry-run']),
            go(['migrate', '--dsn', $dsn, '--schema', "$work/bench.mmd", '--dry-run']), 'initial plan');
        $applied = php(['migrate', '--dsn', $dsn, '--schema', "$work/bench.mmd", '--migration-id', 'bench', '--log-dir', $logs]);
        check($applied[0] === 0 && str_contains($applied[1], 'status=applied'), 'apply bench: ' . $applied[1] . $applied[2]);
        same(php(['migrate', '--dsn', $dsn, '--schema', "$work/bench.mmd", '--migration-id', 'bench', '--log-dir', $logs]),
            go(['migrate', '--dsn', $dsn, '--schema', "$work/bench.mmd", '--migration-id', 'bench', '--log-dir', $logs]), 'repeated migration');
        same(php(['migrate', '--dsn', $dsn, '--schema', "$work/v1.mmd", '--migration-id', 'bench', '--log-dir', $logs]),
            go(['migrate', '--dsn', $dsn, '--schema', "$work/v1.mmd", '--migration-id', 'bench', '--log-dir', $logs]), 'history conflict');
        same(php(['ddl', '--schema', "db:$dsn", '--dialect', $driver, '--out', "$work/php-live.sql"]),
            go(['ddl', '--schema', "db:$dsn", '--dialect', $driver, '--out', "$work/go-live.sql"]), 'live source');
        check(file_get_contents("$work/php-live.sql") === file_get_contents("$work/go-live.sql"), 'live source DDL');
        if ($driver !== 'sqlite') {
            file_put_contents("$work/php.mmd", "erDiagram\n  battle {\n    bigint seq PK \"auto lazy\"\n  }\n");
            copy("$work/php.mmd", "$work/go.mmd");
            same(php(['import', '--dsn', $dsn, '--out', "$work/php.mmd"]), go(['import', '--dsn', $dsn, '--out', "$work/go.mmd"]), 'import');
            check(file_get_contents("$work/php.mmd") === file_get_contents("$work/go.mmd"), "import text\n--- php\n" . file_get_contents("$work/php.mmd") . "--- go\n" . file_get_contents("$work/go.mmd"));
            same(php(['import', '--dsn', $dsn, '--out', "$work/php-subset.mmd", '--tables', 'user, service']),
                go(['import', '--dsn', $dsn, '--out', "$work/go-subset.mmd", '--tables', 'user, service']), 'import subset');
            check(file_get_contents("$work/php-subset.mmd") === file_get_contents("$work/go-subset.mmd"), 'import subset text');
            same(php(['validate', '--dsn', $dsn, '--schema', "$root/schema/schema.json"]), go(['validate', '--dsn', $dsn, '--schema', "$root/schema/schema.json"]), 'validate');
            [, $pdo] = SchemaImport::connect($dsn);
            $pdo->exec($driver === 'mysql' ? 'ALTER TABLE `service` DROP COLUMN `name`' : 'ALTER TABLE "service" DROP COLUMN "name"');
            $pdo->exec($driver === 'mysql' ? 'ALTER TABLE `user` ADD COLUMN `extra` int NULL' : 'ALTER TABLE "user" ADD COLUMN "extra" integer NULL');
            $drift = php(['validate', '--dsn', $dsn, '--schema', "$root/schema/schema.json"]);
            check($drift[0] === 1 && str_contains($drift[1], 'service.name: column missing in the database') && str_contains($drift[1], 'user.extra: column exists'), 'drift: ' . $drift[1]);
            same($drift, go(['validate', '--dsn', $dsn, '--schema', "$root/schema/schema.json"]), 'validate drift');
        }

        // a schema change: added column, index, and table
        wipe($driver, $dsn);
        $applied = php(['migrate', '--dsn', $dsn, '--schema', "$work/v1.mmd", '--migration-id', 'v1', '--log-dir', $logs]);
        check($applied[0] === 0 && str_contains($applied[1], 'status=applied'), 'apply v1: ' . $applied[1] . $applied[2]);
        same(php(['migrate', '--dsn', $dsn, '--schema', "$work/v2.mmd", '--migration-id', 'v2', '--dry-run']),
            go(['migrate', '--dsn', $dsn, '--schema', "$work/v2.mmd", '--migration-id', 'v2', '--dry-run']), 'change plan');
        $applied = php(['migrate', '--dsn', $dsn, '--schema', "$work/v2.mmd", '--migration-id', 'v2', '--log-dir', $logs]);
        check($applied[0] === 0 && str_contains($applied[1], 'status=applied'), 'apply v2: ' . $applied[1] . $applied[2]);
        same(php(['migrate', '--dsn', $dsn, '--schema', "$work/v2.mmd", '--migration-id', 'v2', '--log-dir', $logs]),
            go(['migrate', '--dsn', $dsn, '--schema', "$work/v2.mmd", '--migration-id', 'v2', '--log-dir', $logs]), 'repeated change');
        same(php(['diff', '--from', "db:$dsn", '--to', "$work/v1.mmd", '--dialect', $driver, '--out', "$work/php-down.sql"]),
            go(['diff', '--from', "db:$dsn", '--to', "$work/v1.mmd", '--dialect', $driver, '--out', "$work/go-down.sql"]), 'reverse diff');
        same(php(['diff', '--from', "db:$dsn", '--to', "$work/v1.mmd", '--dialect', $driver, '--out', "$work/php-down.sql", '--allow-destructive']),
            go(['diff', '--from', "db:$dsn", '--to', "$work/v1.mmd", '--dialect', $driver, '--out', "$work/go-down.sql", '--allow-destructive']), 'destructive reverse diff');
        check(file_get_contents("$work/php-down.sql") === file_get_contents("$work/go-down.sql"), "reverse diff SQL\n--- php\n" . file_get_contents("$work/php-down.sql") . "--- go\n" . file_get_contents("$work/go-down.sql"));
        wipe($driver, $dsn);

        // an incremental migration of a live table
        liveCycle($driver, $dsn);
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "schema tools/$driver\n";
}

if ($failures > 0) {
    fwrite(STDERR, "php schema db test: $failures failures\n");
    exit(1);
}
echo 'php schema db test: ' . count($targets) . " databases passed\n";
