<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

/**
 * A catalog value rule that one driver value breaks (docs/spec/interfaces.md "Catalog value rules", INT-165): its code
 * and its text, which names no value and no column. Catalog names the column by its 1-based position and raises the
 * rule as an OrmException `CODE: column n: text`; a driver or library failure (INT-172) is the previous exception.
 *
 * @internal
 */
final class CatalogRule extends \RuntimeException
{
    public function __construct(public readonly string $ruleCode, string $text, ?\Throwable $cause = null)
    {
        parent::__construct($text, 0, $cause);
    }
}
