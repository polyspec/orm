<?php
declare(strict_types=1);
// Test autoloader: Orm\ → clients/php/src, Polyspec\Orm\Tests\Model\ → clients/php/gen.
$root = dirname(__DIR__, 3);
require_once "$root/clients/php/vendor/autoload.php";
spl_autoload_register(static function (string $class) use ($root): void {
    $files = [
        'Orm\\' => [
            'dir' => "$root/clients/php/src/",
            'shared' => [
                'Frame' => 'Model', 'Request' => 'Model', 'Assembly' => 'Model', 'PendingTime' => 'Model',
                'TxFrame' => 'Db', 'Transform' => 'Db',
                'Config' => 'Orm', 'OrmException' => 'Orm',
                'Page' => 'Collection', 'GroupRow' => 'GroupRows',
                'PlanScope' => 'Planner', 'PlanRelation' => 'Planner', 'PlanBinds' => 'Planner', 'PlanSteps' => 'Planner', 'PlanStep' => 'Planner', 'PlanAssemble' => 'Planner', 'PlanChild' => 'Planner',
                'Stats' => 'Utils', 'SchemaUtils' => 'Utils', 'PrivilegeUtils' => 'Utils', 'AesUtils' => 'Utils',
                'Assemble' => 'Engine', 'Bytes' => 'Codec', 'AesRotationStatus' => 'AesKeyring',
            ],
        ],
        'Polyspec\\Orm\\Tests\\Model\\' => ['dir' => "$root/clients/php/gen/", 'shared' => []],
    ];
    foreach ($files as $prefix => $spec) {
        if (!str_starts_with($class, $prefix)) {
            continue;
        }
        $name = substr($class, strlen($prefix));
        if (str_contains($name, '\\')) {
            // A sub-namespace maps to its directory, as composer's PSR-4 rule does.
            $file = $spec['dir'] . str_replace('\\', '/', $name) . '.php';
            if (is_file($file)) {
                require_once $file;
            }
            return;
        }
        $file = $spec['dir'] . ($spec['shared'][$name] ?? $name) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});
require_once "$root/clients/php/gen/bootstrap.php";
