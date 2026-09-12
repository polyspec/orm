<?php
declare(strict_types=1);
// Test autoloader: Orm\ → clients/php/src, App\Orm\ → clients/php/gen. Composer replaces this in S5.
$root = dirname(__DIR__, 3);
$composer = "$root/clients/php/vendor/autoload.php";
if (is_file($composer)) {
    require_once $composer;
}
spl_autoload_register(function (string $class) use ($root): void {
    $map = ['Orm\\' => "$root/clients/php/src/", 'App\\Orm\\' => "$root/clients/php/gen/"];
    foreach ($map as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $rel = substr($class, strlen($prefix));
            // Orm\Row, Orm\Collection, Orm\Page, Orm\Registry, Orm\Names live in Row.php; Orm\W/Q/Req in Query.php; Compat/CompatQuery/CompatWhere in Compat.php; Db/Tx/Transform in Db.php; Config/OrmException in Orm.php; Code.php (generated), Toml.php and Codec.php are one class each
            $file = match (true) {
                $prefix === 'Orm\\' && in_array($rel, ['Row', 'Rows', 'Collection', 'Page', 'Registry', 'Names'], true) => $dir . 'Row.php',
                $prefix === 'Orm\\' && in_array($rel, ['W', 'Q', 'Req', 'ColRef'], true) => $dir . 'Query.php',
                $prefix === 'Orm\\' && in_array($rel, ['Compat', 'CompatQuery', 'CompatWhere'], true) => $dir . 'Compat.php',
                $prefix === 'Orm\\' && in_array($rel, ['Db', 'Tx', 'Transform'], true) => $dir . 'Db.php',
                $prefix === 'Orm\\' && in_array($rel, ['Orm', 'Config', 'OrmException'], true) => $dir . 'Orm.php',
                $prefix === 'Orm\\' && in_array($rel, ['Transport', 'Assemble'], true) => $dir . 'Transport.php',
                $prefix === 'Orm\\' && in_array($rel, ['Codec', 'Code', 'Toml', 'ConnectionBinding', 'Binding', 'Wire', 'CompilerBridge', 'CompilerTransport', 'ConnectCompiler'], true) => $dir . $rel . '.php',
                $prefix === 'App\\Orm\\' => $dir . preg_replace('/(Row|Where|Cols)$/', '', $rel) . '.php',
                default => null,
            };
            if ($file !== null && is_file($file)) {
                require_once $file;
            }
        }
    }
});
require_once "$root/clients/php/gen/bootstrap.php";

/** The database under test: ORM_TEST_DRIVER (mysql | postgres | sqlite; mysql when unset), as the Go test reads it. */
function orm_test_driver(): string
{
    $env = getenv('ORM_TEST_DRIVER');
    return is_string($env) && $env !== '' ? $env : 'mysql';
}

/**
 * The DSN the runners connect with when none is given: MySQL from ORM_MYSQL_DSN_PHP (CI) or the local socket,
 * PostgreSQL the local server of deploy/local-postgres.md, SQLite the seeded bench file — the Go runner's defaults.
 */
function orm_default_dsn(string $driver): string
{
    $env = getenv('ORM_MYSQL_DSN_PHP');
    return match ($driver) {
        'postgres' => 'pgsql:host=localhost;port=5432;dbname=orm_bench;user=maxkwon',
        'sqlite' => '/tmp/orm_bench.sqlite',
        default => is_string($env) && $env !== '' ? $env : 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4',
    };
}

/**
 * The DSN the tests connect with: ORM_TEST_DSN when set; for MySQL else ORM_MYSQL_DSN_PHP or the local socket.
 * The other drivers require ORM_TEST_DSN (the tests write rows: the database is named, never assumed), like Go.
 */
function orm_test_dsn(): string
{
    $env = getenv('ORM_TEST_DSN');
    if (is_string($env) && $env !== '') {
        return $env;
    }
    $driver = orm_test_driver();
    if ($driver !== 'mysql') {
        fwrite(STDERR, "ORM_TEST_DSN is required for driver $driver\n");
        exit(2);
    }
    return orm_default_dsn('mysql');
}

/** Opens the database of the given driver: MySQL as root without a password (the bench server), the others by DSN alone. */
function orm_open_db(string $driver, string $dsn, bool $persistent = true): \Orm\Db
{
    return match ($driver) {
        'mysql' => \Orm\Db::mysql($dsn, 'root', '', $persistent),
        'postgres' => \Orm\Db::postgres($dsn, null, null, $persistent),
        'sqlite' => \Orm\Db::sqlite($dsn, $persistent),
        default => throw new \Orm\OrmException(\Orm\Code::CONFIG, "driver $driver: want mysql, postgres or sqlite"),
    };
}

/** The statement in MySQL spelling (backticks, `?`) so SQL assertions read the same on every dialect. */
function orm_norm_sql(string $sql): string
{
    return orm_test_driver() === 'mysql' ? $sql : preg_replace('/\$\d+/', '?', str_replace('"', '`', $sql));
}
