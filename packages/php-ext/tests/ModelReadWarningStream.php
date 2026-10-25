<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class ModelReadWarningStream
{
    use \Polyspec\Orm\Tests\WarningStreamProtocol;

    protected function warningMessage(): string
    {
        return 'native stream read warning';
    }
}
