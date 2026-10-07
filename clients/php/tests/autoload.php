<?php
declare(strict_types=1);
// Test autoloader: Polyspec\Orm\ → clients/php/src, Polyspec\Orm\Tests\Model\ → clients/php/gen.
$root = dirname(__DIR__, 3);
require_once "$root/vendor-php/autoload.php";
spl_autoload_register(static function (string $class) use ($root): void {
    // 더 긴 prefix를 먼저 본다: test model의 namespace는 library namespace 아래에 있다.
    $files = [
        'Polyspec\\Orm\\Tests\\Model\\' => ['dir' => "$root/clients/php/gen/", 'shared' => []],
        'Polyspec\\Orm\\' => [
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
