<?php

// The model write chains recipe, contracts/fixtures/model_writes_chain/model_writes_chain.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ModelWritesChainRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/model_writes_chain/model_writes_chain.json';
    }
}
