<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One typed cell of a grid query (docs/spec/interfaces.md, "Rust native grid query specification"). kind is one of
 * null, integer, unsigned, float32, float64, decimal, text, boolean, binary, date, time or datetime. The value of each
 * kind:
 *   - null: null;
 *   - integer: int; boolean: bool; text and binary: the string (its bytes for binary);
 *   - unsigned: the decimal digits of the value, exact over the whole unsigned range;
 * - float32 and float64: the IEEE-754 bits as lowercase hexadecimal, 8 or 16 digits, so signed zero and nonfinite
 * values
 *     are preserved;
 *   - decimal: the plain decimal text, with the scale the database declares;
 *   - date, time and datetime: the dbspec text, YYYY-MM-DD, HH:MM:SS.ffffff and YYYY-MM-DD HH:MM:SS.ffffff.
 */
final class CatalogGridCell
{
    public function __construct(
        public readonly string $kind,
        public readonly mixed $value = null,
    ) {
    }
}
