<?php

declare(strict_types=1);

namespace Symfony\Component\Yaml;

final class Yaml
{
    public const int DUMP_EXCEPTION_ON_INVALID_TYPE = 1;
    public const int DUMP_EMPTY_ARRAY_AS_SEQUENCE = 2;
    public const int DUMP_NUMERIC_KEY_AS_STRING = 4;

    public static ?\Throwable $failure = null;

    public static function dump(mixed $input, int $inline = 20, int $indent = 2, int $flags = 0): never
    {
        throw self::$failure ?? new \LogicException('no YAML dump failure was configured');
    }
}
