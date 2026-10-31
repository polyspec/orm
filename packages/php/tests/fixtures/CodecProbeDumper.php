<?php

declare(strict_types=1);

namespace Purr\Yaml\Dumper;

final class Dumper
{
    public static ?\Throwable $failure = null;

    public function dumpDocument(\Purr\Yaml\Document $document): never
    {
        throw self::$failure ?? new \LogicException('no YAML dump failure was configured');
    }
}
