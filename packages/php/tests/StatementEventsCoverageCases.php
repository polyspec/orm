<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** Shared statement event coverage case for the PHP library and native extension clients. */
trait StatementEventsCoverageCases
{
    abstract protected function coverageTestFile(): string;

    public function testStatementEvents(): void
    {
        foreach (coverageItemsOf($this->coverageTestFile()) as $item) {
            selectCoverageItem($item);
            [$driver] = coverageItem();
            statementEventsModels();
            foreach (statementEventsVector()['cases'] as $case) {
                with_case_database($driver, static function (string $text): void {
                }, static fn(string $dsn) => runCase($case, $driver, $dsn));
            }
        }
    }
}
