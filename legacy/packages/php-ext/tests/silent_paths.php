<?php

declare(strict_types=1);

// Runs with the extension alone (php -n): no library class is loaded, so Polyspec\Orm\OrmException is
// missing. A call that must fail with an OrmException must throw an Error that names the missing class.
// A call that returns with no exception is a silent failure, and this script exits 1 for it (T182-2-4).

$cases = [
    'Validator::restoreKey' => static fn(): mixed => Polyspec\Orm\Validator::restoreKey(['name' => 'x'], []),
    'Validator::conflictKey' => static fn(): mixed =>
        Polyspec\Orm\Validator::conflictKey(['name' => 'x'], [['bad' => 1]]),
];
$failures = 0;
foreach ($cases as $name => $call) {
    try {
        $result = $call();
        echo "$name: returned ", json_encode($result), " with no exception\n";
        $failures++;
    } catch (Error $e) {
        if (!str_contains($e->getMessage(), 'Polyspec\Orm\OrmException')) {
            echo "$name: wrong error: ", $e->getMessage(), "\n";
            $failures++;
        } else {
            echo "$name: ok\n";
        }
    }
}
exit($failures === 0 ? 0 : 1);
