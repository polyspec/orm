<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The markdown message recipe of a text that is not UTF-8, tests/bind/messages-raw-text.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4): a PHP string holds any bytes. Requirements: PRT-67.
#[Medium]
class BindMessagesRawTextRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/bind/messages-raw-text.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
