<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class ModelReadWarningStream
{
    public $context;

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        return true;
    }
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_read(int $count): string|false
    {
        trigger_error('native stream read warning', E_USER_WARNING);
        return false;
    }
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_eof(): bool
    {
        return false;
    }
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_stat(): array|false
    {
        return [];
    }
}
