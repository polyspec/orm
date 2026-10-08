<?php
declare(strict_types=1);
// Wraps a SQLite PDO to inject failures into Polyspec\Orm\Dbspec apply and checks
// that no error is lost (docs/plans.md "Apply"): a failing lock release
// after an event stops apply, a failing foreign key restore after a failing
// BEGIN EXCLUSIVE, a rollback of an applied row whose recorded step lies
// outside the plan, an effect query that returns no row, and a result that
// cannot be closed.
// Usage: php packages/orm-php/tests/dbspec_apply_cleanup_test.php
require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\ApplyCleanupError;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Effect;
use Polyspec\Orm\Dbspec\PlanApply;

// CASE_DEADLINE_MS는 case 하나의 기한이다. case는 memory SQLite database에 plan 하나를 적용한다.
const CASE_DEADLINE_MS = 20000;

/**
 * 정한 statement 에 error 를 주입하고 정한 query 를 다른 query 로 바꾸는 SQLite connection.
 * 바꾼 query 는 원래 query 의 parameter 없이 실행한다.
 */
final class FailingPdo extends PDO
{
    /**
     * @param array<string, PDOException> $fail statement 마다 exec 가 던질 error
     * @param array<string, string> $replace query 마다 대신 보낼 query
     * @param list<string> $failClose 닫기가 실패하는 query
     */
    public function __construct(string $path, private readonly array $fail, private readonly array $replace, array $failClose)
    {
        parent::__construct("sqlite:$path", null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_STATEMENT_CLASS => [FailingStatement::class, [array_values($replace), $failClose]],
        ]);
    }

    public function exec(string $statement): int|false
    {
        if (isset($this->fail[$statement])) {
            throw $this->fail[$statement];
        }
        return parent::exec($statement);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        return parent::query($this->replace[$query] ?? $query, $fetchMode, ...$fetchModeArgs);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return parent::prepare($this->replace[$query] ?? $query, $options);
    }
}

/** 바꾼 query 를 parameter 없이 실행하고, 정한 query 의 result 닫기가 실패하는 statement. */
final class FailingStatement extends PDOStatement
{
    /**
     * @param list<string> $replacements 바꿔 보낸 query
     * @param list<string> $failClose
     */
    protected function __construct(private readonly array $replacements, private readonly array $failClose)
    {
    }

    public function execute(?array $params = null): bool
    {
        return parent::execute(in_array($this->queryString, $this->replacements, true) ? null : $params);
    }

    public function closeCursor(): bool
    {
        return in_array($this->queryString, $this->failClose, true) ? false : parent::closeCursor();
    }
}

$root = dirname(__DIR__, 3);
$vectors = json_decode(file_get_contents("$root/tests/dbspec/plans.json"), true, 512, JSON_THROW_ON_ERROR);
$plans = [];
foreach ($vectors['cases'] as $case) {
    if ($case['id'] === 'create-from-empty') {
        $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
        $plans[] = $parsed->plan ?? throw new RuntimeException('create-from-empty: ' . json_encode($parsed->diagnostics));
    }
}
if (count($plans) !== 1) {
    throw new RuntimeException('plans.json has no create-from-empty case');
}
$now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
$run = 'apply_cleanup_php_' . getmypid();
$fileIndex = 0;

/**
 * 새 SQLite file 위의 FailingPdo.
 *
 * @param array<string, PDOException> $fail
 * @param array<string, string> $replace
 * @param list<string> $failClose
 */
function failing_pdo(array $fail, array $replace = [], array $failClose = []): FailingPdo
{
    global $run, $fileIndex;
    $fileIndex++;
    $path = sys_get_temp_dir() . sprintf('/%s_%02d.sqlite', $run, $fileIndex);
    if (file_exists($path)) {
        throw new RuntimeException("SQLite file $path already exists");
    }
    register_shutdown_function(static function () use ($path): void {
        foreach (['', '-journal'] as $suffix) {
            if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                throw new RuntimeException("$path$suffix cannot be removed");
            }
        }
    });
    return new FailingPdo($path, $fail, $replace, $failClose);
}

/**
 * operation 이 failure 로 실패하고 그 뒤 정리 error 가 정확히 cleanup 인지 확인한다.
 * failure 는 기대한 첫 error 인지 판단한다.
 *
 * @param Closure(Throwable): bool $failure
 * @param list<Throwable> $cleanup
 */
function want_cleanup(Closure $operation, Closure $failure, array $cleanup): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        if (!$e instanceof ApplyCleanupError) {
            throw new RuntimeException(get_class($e) . ' "' . $e->getMessage() . '" alone; want it with the cleanup errors', 0, $e);
        }
        if (!$failure($e->getPrevious()) || $e->cleanup !== $cleanup) {
            throw new RuntimeException('cleanup error "' . $e->getMessage() . '" holds other errors', 0, $e);
        }
        echo "  {$e->getMessage()}\n";
        return;
    }
    throw new RuntimeException('succeeded; want the failure with the cleanup errors');
}

/** operation 이 메시지가 want 인 error 로 실패하는지 확인한다. */
function want_message(Closure $operation, string $want): void
{
    try {
        $operation();
    } catch (Throwable $e) {
        if ($e->getMessage() !== $want) {
            throw new RuntimeException(get_class($e) . ' "' . $e->getMessage() . "\"; want \"$want\"", 0, $e);
        }
        echo "  {$e->getMessage()}\n";
        return;
    }
    throw new RuntimeException("no error; want \"$want\"");
}

$effect = static fn(PDO $c): bool => PlanApply::effectOn($c, 'sqlite', new Effect('table', 'orders', '', true));
$tablesQuery = PlanApply::EFFECT_QUERIES['sqlite']['table'];

/** @var list<array{0: string, 1: Closure(): void}> $cases */
$cases = [
    ['apply/cleanup-errors/release', static function () use ($plans, $now): void {
        $stop = new RuntimeException('stop');
        $release = new PDOException('release failed');
        $pdo = failing_pdo(['PRAGMA locking_mode = normal' => $release]);
        $events = static function (ApplyEvent $event) use ($stop): void {
            if ($event->kind === 'applied') {
                throw $stop;
            }
        };
        want_cleanup(static fn() => Dbspec::apply($pdo, 'sqlite', $plans, $now, $events), static fn(?Throwable $e): bool => $e === $stop, [$release]);
    }],
    ['apply/cleanup-errors/begin-restore', static function () use ($plans, $now): void {
        $begin = new PDOException('begin failed');
        $restore = new PDOException('restore failed');
        $pdo = failing_pdo(['BEGIN EXCLUSIVE' => $begin, 'PRAGMA foreign_keys = 0' => $restore]);
        want_cleanup(
            static fn() => Dbspec::apply($pdo, 'sqlite', $plans, $now, null),
            static fn(?Throwable $e): bool => $e instanceof ApplyError && $e->code_ === 'locked' && $e->getPrevious() === $begin,
            [$restore],
        );
    }],
    ['apply/rollback-step-outside', static function () use ($plans, $now): void {
        $pdo = failing_pdo([]);
        Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        $pdo->exec('UPDATE "dbspec$plans" SET step = 99');
        want_message(static fn() => Dbspec::rollback($pdo, 'sqlite', $plans, $now, null), "chain {$plans[0]->name}: the recorded step 99 is outside the plan's 4 steps");
    }],
    ['apply/effect-row', static function () use ($effect, $tablesQuery): void {
        $pdo = failing_pdo([], [$tablesQuery => 'SELECT 1 WHERE 0']);
        want_message(static fn() => $effect($pdo), "$tablesQuery returned no row");
    }],
    ['apply/effect-close', static function () use ($effect, $tablesQuery): void {
        $pdo = failing_pdo([], [$tablesQuery => 'SELECT 1'], ['SELECT 1']);
        want_message(static fn() => $effect($pdo), "closing the result of $tablesQuery failed");
    }],
];

$failed = 0;
foreach ($cases as [$id, $case]) {
    if (!testcase_run($id, CASE_DEADLINE_MS / 1000, static fn() => $case())) {
        $failed++;
    }
}
if ($failed > 0) {
    exit(1);
}
