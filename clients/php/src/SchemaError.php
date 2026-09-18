<?php
declare(strict_types=1);

namespace Orm;

/** A schema parse or build error; the message carries the source line. */
final class SchemaError extends \RuntimeException
{
    public function __construct(public readonly int $sourceLine, public readonly string $detail)
    {
        parent::__construct($sourceLine > 0 ? "line $sourceLine: $detail" : $detail);
    }

    /** A parse error always names its line, including line 0. */
    public static function parse(int $line, string $detail): self
    {
        $e = new self($line, $detail);
        $e->message = "line $line: $detail";
        return $e;
    }
}
