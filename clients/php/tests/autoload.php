<?php
declare(strict_types=1);
// Test autoloader: Orm\ → clients/php/src, App\Orm\ → clients/php/gen. Composer replaces this in S5.
$root = dirname(__DIR__, 3);
spl_autoload_register(function (string $class) use ($root): void {
    $map = ['Orm\\' => "$root/clients/php/src/", 'App\\Orm\\' => "$root/clients/php/gen/"];
    foreach ($map as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $rel = substr($class, strlen($prefix));
            // Orm\Row, Orm\Collection, Orm\Page, Orm\Registry, Orm\Names live in Row.php; Orm\W/Q/Req in Query.php; Db/Tx/Transform in Db.php; Config/OrmException in Orm.php
            $file = match (true) {
                $prefix === 'Orm\\' && in_array($rel, ['Row', 'Rows', 'Collection', 'Page', 'Registry', 'Names'], true) => $dir . 'Row.php',
                $prefix === 'Orm\\' && in_array($rel, ['W', 'Q', 'Req'], true) => $dir . 'Query.php',
                $prefix === 'Orm\\' && in_array($rel, ['Db', 'Tx', 'Transform'], true) => $dir . 'Db.php',
                $prefix === 'Orm\\' && in_array($rel, ['Orm', 'Config', 'OrmException'], true) => $dir . 'Orm.php',
                $prefix === 'Orm\\' && in_array($rel, ['Transport', 'Assemble'], true) => $dir . 'Transport.php',
                $prefix === 'App\\Orm\\' => $dir . preg_replace('/(Row|Where)$/', '', $rel) . '.php',
                default => null,
            };
            if ($file !== null && is_file($file)) {
                require_once $file;
            }
        }
    }
});
require_once "$root/clients/php/gen/bootstrap.php";

