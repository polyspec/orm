<?php
declare(strict_types=1);

$root = dirname(__DIR__);
require "$root/clients/php/tests/autoload.php";
$runtime = "$root/.runtime";
if (!is_dir($runtime) && !mkdir($runtime, 0700, true) && !is_dir($runtime)) {
    throw new RuntimeException('cannot create decimal test runtime directory');
}
$name = 'orm_decimal_case';
$marker = "$runtime/decimal-owned";
$owned = is_file($marker) && trim((string) file_get_contents($marker)) === $name;
if (is_file($marker) && !$owned) {
    throw new RuntimeException('decimal test ownership marker is invalid');
}

function connection(string $uri): PDO
{
    $u = parse_url($uri);
    if (!is_array($u) || !isset($u['scheme'], $u['host'], $u['port'], $u['path'], $u['user'])) {
        throw new RuntimeException('database URI is incomplete');
    }
    $driver = $u['scheme'] === 'postgres' ? 'pgsql' : $u['scheme'];
    if (!in_array($driver, ['mysql', 'pgsql'], true)) {
        throw new RuntimeException('database URI must be mysql or postgres');
    }
    $database = ltrim($u['path'], '/');
    $dsn = "$driver:host={$u['host']};port={$u['port']};dbname=$database";
    return new PDO($dsn, rawurldecode($u['user']), rawurldecode($u['pass'] ?? ''), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

function databaseUri(string $uri, string $database): string
{
    $u = parse_url($uri);
    if (!is_array($u) || !isset($u['path']) || $u['path'] === '') {
        throw new RuntimeException('database URI has no database name');
    }
    return substr_replace($uri, '/' . $database, (int) strpos($uri, $u['path']), strlen($u['path']));
}

// decimal fixture document를 dialect의 문장으로 렌더링해 설치한다.
function install(PDO $pdo, string $dialect): void
{
    $file = dirname(__DIR__) . '/contracts/fixtures/decimal_schema.dbspec';
    $text = file_get_contents($file);
    if ($text === false) {
        throw new RuntimeException("cannot read $file");
    }
    $parsed = Orm\Dbspec\Dbspec::parse($text, ['decimal_schema' => $text]);
    if ($parsed->document === null) {
        throw new RuntimeException("$file: " . json_encode($parsed->diagnostics));
    }
    $rendered = Orm\Dbspec\Dbspec::render([$parsed->document], $dialect);
    if ($rendered->statements === null) {
        throw new RuntimeException("$file ($dialect): " . json_encode($rendered->diagnostics));
    }
    foreach ($rendered->statements as $statement) {
        $pdo->exec($statement);
    }
}

$sources = [
    'mysql' => getenv('BENCH_MYSQL_DSN'),
    'postgres' => getenv('BENCH_POSTGRES_DSN'),
];
$admins = [];
$existing = [];
foreach ($sources as $dialect => $source) {
    if (!is_string($source) || $source === '') {
        throw new RuntimeException("BENCH_" . strtoupper($dialect) . '_DSN is required');
    }
    $admin = connection($source);
    $admins[$dialect] = $admin;
    $existing[$dialect] = $dialect === 'mysql'
        ? $admin->query("SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME = '$name'")->fetchColumn()
        : $admin->query("SELECT datname FROM pg_database WHERE datname = '$name'")->fetchColumn();
}
if (!$owned) {
    foreach ($existing as $dialect => $exists) {
        if ($exists !== false) {
            throw new RuntimeException("$dialect decimal database exists without ownership marker");
        }
    }
    if (file_put_contents($marker, "$name\n", LOCK_EX) === false) {
        throw new RuntimeException('cannot record decimal database ownership');
    }
}
foreach ($sources as $dialect => $source) {
    $admin = $admins[$dialect];
    $exists = $existing[$dialect];
    if ($exists === false) {
        $admin->exec("CREATE DATABASE $name");
    }
    $target = connection(databaseUri($source, $name));
    $table = $dialect === 'mysql'
        ? $target->query("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'decimal_case'")->fetchColumn()
        : $target->query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'decimal_case'")->fetchColumn();
    if ($table === false) {
        install($target, $dialect);
    }
    $type = $dialect === 'mysql'
        ? $target->query("SELECT column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'decimal_case' AND column_name = 'amount'")->fetchColumn()
        : $target->query("SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'decimal_case' AND column_name = 'amount'")->fetchColumn();
    $expected = $dialect === 'mysql' ? 'decimal(13,4)' : 'numeric(13,4)';
    if ($type !== $expected) {
        throw new RuntimeException("$dialect decimal amount type is " . var_export($type, true) . ", expected $expected");
    }
    echo "$dialect decimal_case amount $type\n";
}

$sqlite = "$runtime/decimal-case.sqlite";
if (!is_file($sqlite)) {
    $pdo = new PDO("sqlite:$sqlite", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    install($pdo, 'sqlite');
}
$pdo = new PDO("sqlite:$sqlite", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$type = $pdo->query("SELECT type FROM pragma_table_info('decimal_case') WHERE name = 'amount'")->fetchColumn();
if ($type !== 'DECIMALINT(13,4)') {
    throw new RuntimeException('SQLite decimal amount type is invalid');
}
echo "sqlite decimal_case amount $type\n";

$uris = [
    'DECIMAL_MYSQL_DSN' => databaseUri($sources['mysql'], $name),
    'DECIMAL_POSTGRES_DSN' => databaseUri($sources['postgres'], $name),
    'DECIMAL_SQLITE_DSN' => 'sqlite://' . $sqlite . '?_pragma=busy_timeout(5000)&timezone=%2B00:00',
];
$lines = [];
foreach ($uris as $key => $value) {
    if (str_contains($value, "\n") || str_contains($value, "\r")) {
        throw new RuntimeException("$key contains a newline");
    }
    $lines[] = 'export ' . $key . "='" . str_replace("'", "'\\''", $value) . "'";
}
umask(0077);
if (file_put_contents("$runtime/decimal-env", implode("\n", $lines) . "\n", LOCK_EX) === false) {
    throw new RuntimeException('cannot write decimal test environment');
}
