<?php
declare(strict_types=1);
// Test autoloader: Orm\ → clients/php/src, App\Orm\ → clients/php/gen. Composer replaces this in S5.
$root = dirname(__DIR__, 3);
spl_autoload_register(function (string $class) use ($root): void {
    $map = ['Orm\\' => "$root/clients/php/src/", 'App\\Orm\\' => "$root/clients/php/gen/"];
    foreach ($map as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $rel = substr($class, strlen($prefix));
            // Orm\Row, Orm\Collection, Orm\Page, Orm\Registry, Orm\Names live in Row.php; Orm\W/Q/Req in Query.php; Db/Tx/Transform in Db.php; Config/OrmException in Orm.php; Code.php (generated), Toml.php and Codec.php are one class each
            $file = match (true) {
                $prefix === 'Orm\\' && in_array($rel, ['Row', 'Rows', 'Collection', 'Page', 'Registry', 'Names'], true) => $dir . 'Row.php',
                $prefix === 'Orm\\' && in_array($rel, ['W', 'Q', 'Req', 'ColRef'], true) => $dir . 'Query.php',
                $prefix === 'Orm\\' && in_array($rel, ['Db', 'Tx', 'Transform'], true) => $dir . 'Db.php',
                $prefix === 'Orm\\' && in_array($rel, ['Orm', 'Config', 'OrmException'], true) => $dir . 'Orm.php',
                $prefix === 'Orm\\' && in_array($rel, ['Transport', 'Assemble'], true) => $dir . 'Transport.php',
                $prefix === 'Orm\\' && in_array($rel, ['Codec', 'Code', 'Toml'], true) => $dir . $rel . '.php',
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

/** The PDO DSN the tests, the conformance runner and the demo connect with: ORM_MYSQL_DSN_PHP when set, else the local socket. */
function orm_test_dsn(): string
{
    $env = getenv('ORM_MYSQL_DSN_PHP');
    return is_string($env) && $env !== '' ? $env : 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_bench;charset=utf8mb4';
}

