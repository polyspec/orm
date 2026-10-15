<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * @internal the one table of which two columns compare alike on the three databases. dbspec's check validation and the
 * IR validator both read it, so the two cannot drift (docs/dbspec.md "Checks").
 */
final class Meet
{
    /** The class of the types that share one: integers meet integers, and varchar meets text. */
    private const CLASSES = ['i16' => 'integer', 'i32' => 'integer', 'i64' => 'integer', 'varchar' => 'string', 'text' => 'string'];

    /**
     * The class of a column type: two columns meet when their kinds are equal. A decimal carries its scale and a time or
     * datetime its precision, since a different scale or precision compares differently; every other type is its own
     * class.
     */
    public static function kind(string $type, int $scale, int $precision): string
    {
        return self::CLASSES[$type] ?? match ($type) {
            'decimal' => "decimal scale $scale",
            'time', 'datetime' => "$type precision $precision",
            default => $type,
        };
    }
}
