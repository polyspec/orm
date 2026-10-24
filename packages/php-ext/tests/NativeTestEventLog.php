<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

function subscribeToNativeTestEvents(\Polyspec\Orm\Db $db, array &$events): \Closure
{
    return $db->subscribe(static function ($event) use (&$events): void {
        $events[] = $event;
    });
}
