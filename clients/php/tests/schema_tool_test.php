<?php
// Schema tool unit test: SQL splitting, live SQLite reading, import rendering,
// schema sources, and migration execution, history, and logs.
// Usage: php clients/php/tests/schema_tool_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\SchemaBuilder;
use Orm\SchemaDdl;
use Orm\SchemaDiff;
use Orm\SchemaImport;
use Orm\SchemaMigrate;
use Orm\SchemaParser;
use Orm\SchemaTool;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-schema-tool-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$failures = 0;
$tests = [];

function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

function error(callable $fn): string
{
    try {
        $fn();
    } catch (RuntimeException|InvalidArgumentException $e) {
        return $e->getMessage();
    }
    return 'no error';
}

function sqlite(string $path): PDO
{
    return SchemaImport::connect("sqlite://$path")[1];
}

function manifest(string $src): array
{
    return SchemaBuilder::build([SchemaParser::parse($src)]);
}

function tool(array $args): array
{
    ob_start();
    $stderr = fopen('php://memory', 'w+');
    $code = SchemaTool::run($args, $stderr);
    $out = (string) ob_get_clean();
    rewind($stderr);
    return [$code, $out, (string) stream_get_contents($stderr)];
}

$tests['split SQL keeps quoted semicolons'] = function (): void {
    $got = SchemaDdl::splitSql("INSERT INTO x VALUES ('a;b'); -- comment ;\nDO $$ BEGIN PERFORM 'c;d'; END $$; SELECT `e;f`; /* ; */ SELECT 1;");
    check(count($got) === 4, 'statements: ' . json_encode($got));
    check(str_contains($got[0], 'a;b') && str_contains($got[1], 'c;d') && str_contains($got[2], 'e;f'), 'quoted content: ' . json_encode($got));
    mt_srand(7);
    $alphabet = ["'", '"', '`', ';', '-', '/', '*', '$', 'a', '_', '1', ' ', "\n", '\\'];
    for ($i = 0; $i < 2000; $i++) {
        $input = '';
        for ($j = mt_rand(0, 40); $j > 0; $j--) {
            $input .= $alphabet[mt_rand(0, count($alphabet) - 1)];
        }
        foreach (SchemaDdl::splitSql($input) as $statement) {
            if ($statement === '') {
                check(false, 'empty statement for ' . json_encode($input));
            }
        }
    }
};

$tests['SQLite import reads named and unnamed checks'] = function () use ($work): void {
    $db = sqlite("$work/import.sqlite");
    $db->exec('CREATE TABLE probe (
		id INTEGER PRIMARY KEY,
		quantity INTEGER NOT NULL,
		label TEXT,
		CONSTRAINT positive_quantity CHECK (quantity >= 0),
		CHECK (length(label) <= 20)
	)');
    $tables = SchemaImport::readTables($db, 'sqlite');
    check(count($tables) === 1 && count($tables[0]['checks']) === 2, 'tables: ' . json_encode($tables));
    check($tables[0]['checks'][0] === ['name' => 'positive_quantity', 'expr' => 'quantity >= 0'], 'named check');
    check($tables[0]['checks'][1] === ['name' => 'check_probe_2', 'expr' => 'length(label) <= 20'], 'unnamed check');
    $source = SchemaImport::renderMermaid($tables, null);
    check(str_contains($source, '%% check probe positive_quantity : quantity >= 0') && str_contains($source, '%% check probe check_probe_2 : length(label) <= 20'), "directives:\n$source");
    manifest($source);
    check(str_contains(error(fn() => SchemaImport::sqliteChecks('probe', 'CREATE TABLE probe (value INTEGER CHECK (value > 0')), 'unbalanced'), 'malformed check');
};

$tests['import keeps foreign key targets and actions'] = function (): void {
    $col = static fn(string $name, string $key = ''): array => ['name' => $name, 'type' => 'bigint', 'nullable' => false, 'default' => null, 'extra' => '', 'key' => $key, 'comment' => ''];
    $table = static fn(string $name, array $columns, array $fks = []): array => ['name' => $name, 'comment' => '', 'columns' => $columns, 'indexes' => [], 'foreign_keys' => $fks, 'checks' => []];
    $source = SchemaImport::renderMermaid([
        $table('owner', [$col('id', 'PRI')]),
        $table('item', [$col('id', 'PRI'), $col('owner_id')], [['name' => 'fk_item_owner_id', 'columns' => ['owner_id'], 'target' => 'owner', 'target_columns' => ['id'], 'on_delete' => 'cascade']]),
    ], null);
    check(str_contains($source, ': owner_id cascade'), "foreign key metadata:\n$source");
    $m = manifest($source);
    $item = $m['entities']['item'];
    check($item['columns'][$item['cols']['owner_id']]['ref'] === ['entity' => 'owner', 'column' => 'id'], 'foreign key target');
    check(($item['relations']['owner']['on_delete'] ?? '') === 'cascade', 'foreign key action');

    $source = SchemaImport::renderMermaid([
        $table('account', [$col('tenant_id', 'PRI'), $col('id', 'PRI')]),
        $table('membership', [$col('tenant_id', 'PRI'), $col('account_id', 'PRI')], [['name' => 'fk_membership_account', 'columns' => ['tenant_id', 'account_id'], 'target' => 'account', 'target_columns' => ['tenant_id', 'id'], 'on_delete' => 'cascade']]),
    ], null);
    check(str_contains($source, ': (tenant_id, account_id) (') && str_contains($source, ') cascade'), "composite syntax:\n$source");
    $relation = null;
    foreach (manifest($source)['entities']['membership']['relations'] as $r) {
        if ($r['target'] === 'account') {
            $relation = $r;
        }
    }
    check($relation !== null && $relation['on_delete'] === 'cascade'
        && $relation['keys'] === [['local' => 'tenant_id', 'target' => 'tenant_id'], ['local' => 'account_id', 'target' => 'id']], 'composite relation: ' . json_encode($relation));
};

$tests['PostgreSQL full-text index definitions'] = function (): void {
    $definition = "CREATE INDEX item_ft_name_body ON public.item USING gin (to_tsvector('simple'::regconfig, (((COALESCE(name, ''::character varying))::text || ' '::text) || COALESCE(body, ''::text))))";
    check(SchemaImport::postgresFulltextColumns($definition) === ['name', 'body'], 'columns');
    check(str_contains(error(fn() => SchemaImport::postgresFulltextColumns('CREATE INDEX custom ON item USING gin (jsonb_path_ops(data))')), 'unsupported'), 'unknown expression');
};

$tests['tool DSNs are client URIs'] = function (): void {
    foreach ([
        'mysql://app:secret@db:3306/app?timezone=%2B09:00' => ['mysql', 'mysql://app:xxxxx@db:3306/app?timezone=%2B09:00'],
        'mysql://root@localhost/app?socket=/tmp/mysql.sock' => ['mysql', 'mysql://root@localhost/app?socket=/tmp/mysql.sock'],
        'postgres:///app?host=/tmp&timezone=Asia/Seoul' => ['postgres', 'postgres:///app?host=/tmp&timezone=Asia/Seoul'],
        'sqlite:///var/lib/app.sqlite' => ['sqlite', 'sqlite:///var/lib/app.sqlite'],
    ] as $raw => [$dialect, $redacted]) {
        check(SchemaImport::dialect($raw) === $dialect, "dialect $raw");
        check(SchemaImport::redact($raw) === $redacted, "redact $raw: " . SchemaImport::redact($raw));
    }
    foreach (['root@unix(/tmp/mysql.sock)/app', '/var/lib/app.sqlite', 'sqlite://relative.sqlite', 'mysql://localhost', 'postgres://localhost', 'oracle://localhost/app'] as $raw) {
        check(str_starts_with(error(fn() => SchemaImport::connect($raw)), 'MIGRATION_CONFIG:'), "reject $raw: " . error(fn() => SchemaImport::connect($raw)));
    }
    check(str_starts_with(error(fn() => SchemaImport::connect('mysql://nobody:pw@127.0.0.1:1/app')), 'MIGRATION_CONNECT: dsn=mysql://nobody:xxxxx@127.0.0.1:1/app: '), 'connect error');
};

$tests['SQLite import filters tables and reads keys and clock defaults'] = function () use ($work): void {
    $db = sqlite("$work/import.sqlite");
    $db->exec('CREATE TABLE "kept" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "created_ts" TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%d %H:%M:%f\', \'now\') || \'000\'))');
    $db->exec('CREATE TABLE "other" ("id" INTEGER PRIMARY KEY)');
    $tables = SchemaImport::readTables($db, 'sqlite', ['kept' => true]);
    check(count($tables) === 1 && $tables[0]['name'] === 'kept', 'filtered');
    check($tables[0]['columns'][0]['extra'] === 'auto_increment', 'auto key');
    check($tables[0]['columns'][2]['default'] === 'CURRENT_TIMESTAMP', 'clock default: ' . var_export($tables[0]['columns'][2]['default'], true));
    $other = SchemaImport::readTables($db, 'sqlite');
    check($other[1]['columns'][0]['extra'] === '', 'integer key without AUTOINCREMENT');
};

$tests['schema sources keep the manifest'] = function () use ($work): void {
    $src = "erDiagram\n  account {\n    bigint id PK\n    bigint tenant_id\n    varchar(32) secret \"aes hex\"\n    int aes_key_version \"=1\"\n  }\n  %% table_comment account \"accounts\"\n  %% column_comment account secret \"encrypted\"\n";
    $want = manifest($src);
    file_put_contents("$work/schema.mmd", $src);
    file_put_contents("$work/schema.json", rtrim(SchemaBuilder::json($want), "\n"));
    foreach (["$work/schema.mmd", "$work/schema.json"] as $path) {
        check(SchemaTool::source($path, 'sqlite')['schema_hash'] === $want['schema_hash'], "source $path");
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $driver) {
        file_put_contents("$work/schema.$driver.sql", SchemaDdl::render($want, $driver));
        check(SchemaTool::source("$work/schema.$driver.sql", $driver)['schema_hash'] === $want['schema_hash'], "sql source $driver");
    }
    $db = sqlite("$work/live.sqlite");
    $db->exec('CREATE TABLE item (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL)');
    check(isset(SchemaTool::source("db:sqlite://$work/live.sqlite", 'sqlite')['entities']['item']), 'live source');
    file_put_contents("$work/external.sql", "CREATE TABLE item (id integer);\n");
    check(str_contains(error(fn() => SchemaTool::source("$work/external.sql", 'sqlite')), 'MIGRATION_SOURCE_LOSS'), 'lossy SQL');
    check(str_starts_with(error(fn() => SchemaTool::source("db:sqlite://$work/live.sqlite", 'mysql')), "MIGRATION_CONFIG: db source sqlite://$work/live.sqlite is sqlite, not mysql"), 'db source dialect');
};

$tests['every source produces its target schema'] = function () use ($work): void {
    $src = "erDiagram\n  item {\n    bigint id PK\n    varchar(32) name\n  }\n";
    $want = manifest($src);
    file_put_contents("$work/item.mmd", $src);
    file_put_contents("$work/item.json", rtrim(SchemaBuilder::json($want), "\n"));
    $ddl = SchemaDdl::render($want, 'sqlite');
    file_put_contents("$work/item.sql", $ddl);
    SchemaMigrate::execute(sqlite("$work/source.sqlite"), 'sqlite', $ddl);
    $empty = ['schema_hash' => '', 'order' => [], 'entities' => [], 'orm' => [], 'external_fks' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []];
    foreach (["$work/item.mmd", "$work/item.json", "$work/item.sql", "db:sqlite://$work/source.sqlite"] as $i => $source) {
        $target = SchemaTool::source($source, 'sqlite');
        $diff = SchemaDiff::render($empty, $target, 'sqlite', false);
        check(SchemaDdl::splitSql($diff) !== [], "plan for $source");
        $dest = sqlite("$work/target-$i.sqlite");
        SchemaMigrate::execute($dest, 'sqlite', $diff);
        $actual = SchemaImport::liveManifest($dest, 'sqlite');
        check(SchemaMigrate::schemaMatches($target, $actual, 'sqlite'), "$source target: " . implode('; ', SchemaImport::differences($target, $actual)));
    }
};

$tests['SQLite migration detects drift'] = function () use ($work, $root): void {
    $db = sqlite("$work/drift.sqlite");
    $want = SchemaBuilder::load((string) file_get_contents("$root/schema/schema.json"));
    $ddl = SchemaDdl::renderCreate($want, 'sqlite');
    check(SchemaDdl::splitSql($ddl) !== [], 'initial operations');
    SchemaMigrate::execute($db, 'sqlite', $ddl);
    check(SchemaMigrate::schemaMatches($want, SchemaImport::liveManifest($db, 'sqlite'), 'sqlite'), 'initial state');
    $db->exec('ALTER TABLE "battle" ADD COLUMN "external_drift" TEXT');
    check(!SchemaMigrate::schemaMatches($want, SchemaImport::liveManifest($db, 'sqlite'), 'sqlite'), 'external change');
};

$tests['a live schema may lack the AES version column'] = function () use ($work): void {
    $db = sqlite("$work/aes-upgrade.sqlite");
    $db->exec('CREATE TABLE account (seq INTEGER PRIMARY KEY, aes_hex_email varchar(255) NOT NULL)');
    $live = SchemaImport::liveManifest($db, 'sqlite');
    $target = manifest("erDiagram\n  account {\n    integer seq PK\n    varchar(255) aes_hex_email\n    integer aes_key_version \"=1\"\n  }\n");
    $plan = SchemaDiff::render($live, $target, 'sqlite', false);
    check(str_contains($plan, 'ADD COLUMN "aes_key_version" INTEGER NOT NULL DEFAULT 1'), "plan: $plan");
};

$tests['migration logs are named by time and checked against history'] = function () use ($work): void {
    $dir = "$work/logs";
    $started = new DateTimeImmutable('2026-09-12 13:30:00.123456', new DateTimeZone('UTC'));
    $record = ['id' => '20260912-initial', 'name' => 'initial', 'from' => 'from', 'to' => 'to', 'checksum' => 'plan', 'status' => 'applied', 'operations' => 3];
    SchemaMigrate::writeLog($dir, SchemaMigrate::log($record, 'sqlite', $started, $started->modify('+1 second')));
    $entries = array_values(array_diff(scandir($dir) ?: [], ['.', '..']));
    check($entries === ['20260912T133000.123456Z__20260912-initial.json'], 'log file: ' . json_encode($entries));
    SchemaMigrate::verifyLog($dir, $record, 'sqlite');
    check(str_contains(error(fn() => SchemaMigrate::verifyLog($dir, ['checksum' => 'different'] + $record, 'sqlite')), 'MIGRATION_LOG_CONFLICT'), 'conflict');
};

$tests['comments are part of DDL and diffs'] = function (): void {
    $old = "erDiagram\n  account {\n    bigint seq PK\n    varchar(64) email\n  }\n  %% table_comment account \"old table\"\n  %% column_comment account email \"old email\"\n";
    $new = str_replace(['old table', 'old email'], ['new table', 'new email'], $old);
    $sql = SchemaDiff::render(manifest($old), manifest($new), 'sqlite', false);
    check(str_contains($sql, 'orm_schema_comments') && str_contains($sql, 'new table') && str_contains($sql, 'new email'), "diff: $sql");
    $ddl = SchemaDdl::renderCreate(manifest($new), 'sqlite');
    check(str_contains($ddl, 'CREATE TABLE IF NOT EXISTS orm_schema_comments') && str_contains($ddl, 'new email'), "ddl: $ddl");
};

$tests['a failed SQLite migration rolls back'] = function () use ($work): void {
    $db = sqlite("$work/rollback.sqlite");
    $message = error(fn() => SchemaMigrate::execute($db, 'sqlite', 'CREATE TABLE first (id INTEGER); CREATE TABLE broken (id INTEGER;)'));
    check(str_contains($message, 'rollback issued') && str_contains($message, 'operation=2'), $message);
    check((int) $db->query("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='first'")->fetchColumn() === 0, 'first table left behind');
};

$tests['a concurrent SQLite writer blocks the migration'] = function () use ($work): void {
    $holder = sqlite("$work/locked.sqlite");
    $holder->exec('BEGIN IMMEDIATE');
    $db = sqlite("$work/locked.sqlite");
    $db->setAttribute(PDO::ATTR_TIMEOUT, 0);
    check(str_contains(error(fn() => SchemaMigrate::execute($db, 'sqlite', 'CREATE TABLE blocked (id INTEGER);')), 'MIGRATION_LOCK_BUSY'), 'lock');
    $holder->exec('ROLLBACK');
};

$tests['the migrate command repeats as a no-op'] = function () use ($work): void {
    $m = manifest("erDiagram\n  command_probe {\n    bigint seq PK\n    varchar(32) name\n  }\n");
    file_put_contents("$work/command.json", SchemaBuilder::json($m));
    $args = ['migrate', '--dsn', "sqlite://$work/command.sqlite", '--schema', "$work/command.json", '--migration-id', '20260912-command', '--log-dir', "$work/command-logs"];
    [$code, $first] = tool($args);
    check($code === 0 && str_contains($first, 'status=applied'), "first: $first");
    [$code, $second] = tool($args);
    check($code === 0 && str_contains($second, 'status=noop operations=0'), "repeat: $second");
    [$code, , $err] = tool(['migrate', '--schema', "$work/command.json"]);
    check($code === 1 && str_contains($err, 'MIGRATION_CONFIG'), "missing dsn: $err");
    [$code, , $err] = tool(['ddl', '--schema']);
    check($code === 2 && str_contains($err, 'usage: orm-gen ddl'), "usage: $err");
};

foreach ($tests as $current => $test) {
    try {
        $test();
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}
if ($failures > 0) {
    fwrite(STDERR, "php schema tool test: $failures failures\n");
    exit(1);
}
echo 'php schema tool test: ' . count($tests) . " tests passed\n";
