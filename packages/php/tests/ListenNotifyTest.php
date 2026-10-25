<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ListenNotifyTest extends TestCase
{
    use ListenNotifyCases;

    public function testListenNotify(): void
    {
        $this->runListenNotifyCases();
    }
}
