<?php

// statement_events coverage: in the case database (ORM_FEATURE_DATABASE) chosen by feature-check,
// runs each case of tests/events/vectors.json in a new case database (case_database.php) per case,
// and compares with the expected events (statement_events_run.php). Does not read or write the bench database.
declare(strict_types=1);


use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageStatementEventsTest extends TestCase
{
    public function testStatementEvents(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
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
