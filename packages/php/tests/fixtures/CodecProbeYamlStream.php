<?php

declare(strict_types=1);

namespace Purr\Yaml;

final class YamlStream
{
    public static ?\Throwable $failure = null;

    public function fromString(string $text): never
    {
        throw self::$failure ?? new \LogicException('no YAML parser failure was configured');
    }
}
