<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/**
 * The step deadline of a recipe case that states its steps (`deadline.steps`, FCV-4), as the other runners keep
 * it: the case gets the step budget of its steps (STEP_BUDGET_MS a step plus FIXED_BUDGET_MS, the Go testcase
 * package's StepBudget) instead of the 120 second deadline of its #[Medium] class, and fails when no apply event
 * comes within that 120 seconds (the stall guard). The deadline lives in the test runner, which watches the running
 * test: start sends it, as a timeout event of the test's id, the step budget bounded by DATABASE_MS, so a case with
 * a budget below DATABASE_MS ends at its budget even with no apply event; progress sends the elapsed time plus
 * DATABASE_MS, bounded by the step budget. An event is sent when it moves the deadline by at least RESOLUTION_MS, so
 * a long case writes one line every RESOLUTION_MS, not one per step, and the stall limit is between
 * DATABASE_MS - RESOLUTION_MS and DATABASE_MS after the last step. The runner writes the line of a test that ran out
 * of its deadline, so its text is the runner's own.
 */
final class CaseDeadline
{
    /** Several times the 28 to 35 ms a step of the MySQL stress plan on the slowest CI runs. */
    public const STEP_BUDGET_MS = 250;
    /** The work around the steps, such as creating and dropping a database. */
    public const FIXED_BUDGET_MS = 60_000;
    /** The deadline of a database case, timeoutForMediumTests of phpunit.xml.dist; the stall limit. */
    public const DATABASE_MS = 120_000;
    private const RESOLUTION_MS = 10_000;

    /** @var resource|null */
    private static $events = null;

    private float $started;
    /** The deadline that the runner holds for the case: the first one from the start on. */
    private int $sent;

    private function __construct(private readonly string $id, private readonly int $budget)
    {
        $this->started = hrtime(true) / 1e6;
        $this->sent = $this->first();
    }

    /** The step budget of `steps` steps applied one after another. */
    public static function stepBudget(int $steps): int
    {
        return $steps * self::STEP_BUDGET_MS + self::FIXED_BUDGET_MS;
    }

    /**
     * The deadline of the case `id` (`Class::method with data set "name"`, the id of the runner), or null for a case
     * that states no steps and keeps the deadline of its class.
     *
     * @param array<string, mixed> $case
     */
    public static function of(array $case, string $id): ?self
    {
        $steps = $case['deadline']['steps'] ?? null;
        return is_int($steps) ? new self($id, self::stepBudget($steps)) : null;
    }

    /** The deadline that start sends: the step budget, at most DATABASE_MS, the stall limit before the first event. */
    public function first(): int
    {
        return min($this->budget, self::DATABASE_MS);
    }

    /** Sends the first deadline of the case; the case calls it when it starts. */
    public function start(): void
    {
        self::send($this->id, $this->first());
    }

    /**
     * The deadline to send at an apply event elapsedMs after the start: the elapsed time plus DATABASE_MS, at most the
     * step budget, or null when it moves the sent deadline by less than RESOLUTION_MS and is not the budget.
     */
    public function next(int $elapsedMs): ?int
    {
        $want = min($this->budget, $elapsedMs + self::DATABASE_MS);
        if ($want === $this->sent || ($want - $this->sent < self::RESOLUTION_MS && $want !== $this->budget)) {
            return null;
        }
        return $want;
    }

    /** Records an apply event: it sends the deadline that next gives, if any. */
    public function progress(): void
    {
        $want = $this->next((int) (hrtime(true) / 1e6 - $this->started));
        if ($want === null) {
            return;
        }
        $this->sent = $want;
        self::send($this->id, $want);
    }

    private static function send(string $id, int $timeoutMs): void
    {
        $descriptor = getenv('KIT_TEST_EVENTS');
        if (!is_string($descriptor) || !ctype_digit($descriptor)) {
            throw new \RuntimeException('KIT_TEST_EVENTS must name the deadline event pipe; run PHPUnit through Kit');
        }
        if (self::$events === null) {
            $events = fopen('php://fd/' . $descriptor, 'wb');
            if ($events === false) {
                throw new \RuntimeException('could not open the Kit test event pipe');
            }
            self::$events = $events;
        }
        $line = json_encode(['kind' => 'timeout', 'id' => $id, 'timeoutMs' => $timeoutMs], JSON_THROW_ON_ERROR) . "\n";
        if (fwrite(self::$events, $line) !== strlen($line) || !fflush(self::$events)) {
            throw new \RuntimeException('could not write the deadline event of ' . $id);
        }
    }
}
