<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class ModelStreamWarningWrapper
{
    use WarningStreamProtocol;

    protected function warningMessage(): string
    {
        return 'original stream read warning';
    }
}
