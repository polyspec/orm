<?php
// statement_events coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
// tests/events/vectors.json의 모든 case를 case마다 새 case database(case_database.php)로
// 실행하고 기대 event와 비교한다(statement_events_run.php). bench database는 읽거나 쓰지 않는다.
declare(strict_types=1);

require_once __DIR__ . '/statement_events_run.php';
require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageStatementEventsTest extends TestCase
{
    public function test_statement_events(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver] = coverageItem();
            statementEventsModels();
            foreach (statementEventsVector()['cases'] as $case) {
                with_case_database($driver, static function (string $text): void {}, static fn(string $dsn) => runCase($case, $driver, $dsn));
            }
        }
    }
}
