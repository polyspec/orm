<?php

// The unit test of the step deadline of a PHP recipe case (CaseDeadline, FCV-4): the deadlines that it sends to the
// test runner as timeout events. A case starts with its step budget bounded by the 120 second stall limit, so a case
// whose budget is below that limit ends at its budget even with no apply event; each later event moves the deadline to
// the elapsed time plus the stall limit, bounded by the budget, in steps of at least ten seconds.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class CaseDeadlineTest extends TestCase
{
    private static function deadline(int $steps): CaseDeadline
    {
        $deadline = CaseDeadline::of(['deadline' => ['steps' => $steps]], self::class . '::case');
        self::assertNotNull($deadline);
        return $deadline;
    }

    public function testACaseWithoutStepsKeepsTheDeadlineOfItsClass(): void
    {
        self::assertNull(CaseDeadline::of(['id' => 'case'], self::class . '::case'));
    }

    public function testTheStepBudgetIsAQuarterSecondAStepAndAMinute(): void
    {
        self::assertSame(60_250, CaseDeadline::stepBudget(1));
        self::assertSame(335_000, CaseDeadline::stepBudget(1100));
    }

    public function testABudgetBelowTheStallLimitIsTheFirstDeadline(): void
    {
        $deadline = self::deadline(1);
        self::assertSame(60_250, $deadline->first());
        // The first deadline is already the budget, which no event moves.
        self::assertNull($deadline->next(0));
        self::assertNull($deadline->next(50_000));
    }

    public function testTheStallLimitIsTheFirstDeadlineOfALongerBudget(): void
    {
        $deadline = self::deadline(1100);
        self::assertSame(120_000, $deadline->first());
    }

    public function testAnEventMovesTheDeadlineByTenSecondsOrToTheBudget(): void
    {
        $deadline = self::deadline(1100);
        self::assertNull($deadline->next(5_000), 'a move of five seconds is not sent');
        self::assertSame(130_000, $deadline->next(10_000));
        self::assertSame(335_000, $deadline->next(300_000), 'the deadline is at most the budget');
    }
}
