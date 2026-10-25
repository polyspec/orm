<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class ModelStreamWarningWrapper
{
    public $context;

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        return true;
    }

    public function stream_read(int $count): string|false
    {
        trigger_error('original stream read warning', E_USER_WARNING);
        return false;
    }

    public function stream_eof(): bool
    {
        return false;
    }

    public function stream_stat(): array|false
    {
        return [];
    }
}
