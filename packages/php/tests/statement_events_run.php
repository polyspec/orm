<?php
// Statement events (docs/operations/usage.md "Statement events"), on SQLite, MySQL and
// PostgreSQL. Every case of the shared vector tests/events/vectors.json runs
// in a case database of its own (case_database.php) with the fixture
// contracts/fixtures/statement_events.dbs installed unless the case says
// install false. The case opens a new connection, registers one recording
// subscriber, runs its steps and compares the recorded events with the
// events the vector states for the database: sql, binds, kind, tables,
// transaction (renumbered from 1 in the order of appearance, null outside a
// transaction) and error (the code of the statement's error, or null).
// elapsed must not be negative. The test fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is unset.
// StatementEventsTest.php and the statement_events coverage use this runner: the model is made by statementEventsModels,
// then runCase and runServerTransactions are called inside a PHPUnit test. Each check is a PHPUnit assertion.
declare(strict_types=1);

require_once __DIR__ . '/case_database.php';

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Tests\StatementEventsCase\EventProbe;

/**
 * The model of contracts/fixtures/statement_events.dbs is created once in a temporary directory of this process and autoloaded.
 * The directory is removed when the process ends.
 */
function statementEventsModels(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $root = dirname(__DIR__, 3);
    $work = sys_get_temp_dir() . '/orm-php-statement-events-' . getmypid();
    @mkdir($work, 0o700, true);
    register_shutdown_function(static function () use ($work): void {
        exec('rm -rf ' . escapeshellarg($work));
    });
    $fixture = (string) file_get_contents("$root/contracts/fixtures/statement_events.dbs");
    Generator::generate(RuntimeModel::build(RuntimeModel::parse(['statement_events.dbs' => $fixture])), "$work/models", 'Polyspec\\Orm\\Tests\\StatementEventsCase');
    spl_autoload_register(static function (string $class) use ($work): void {
        if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\StatementEventsCase\\')) {
            require_once "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\StatementEventsCase\\')) . '.php';
        }
    });
    require_once "$work/models/bootstrap.php";
}

/** @return array<string, mixed> tests/events/vectors.json */
function statementEventsVector(): array
{
    return json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/events/vectors.json'), true, 512, JSON_THROW_ON_ERROR);
}

/** The error of a failing transaction callback. The step's error "callback" expects this error. */
final class CallbackFailed extends RuntimeException
{
}

/** The state that runs one case. */
final class EventRun
{
    /** @var list<array<string, mixed>> */
    public array $records = [];
    /** @var array<int, int> Renumbers the transaction numbers of a connection in the order they first appear within the case. */
    private array $numbers = [];
    public ?Closure $stopRecording = null;
    public ?Closure $stopFailing = null;
    /** The error that fail_subscriber threw. The previous of a SUBSCRIBER error is this error. */
    public ?Throwable $refused = null;
    /** @var list<string> the events whose elapsed time is negative */
    public array $negative = [];

    public function assertElapsed(): void
    {
        Assert::assertSame([], $this->negative, 'elapsed must not be negative');
    }

    public function __construct(public readonly Db $db)
    {
    }

    public function record(StatementEvent $e): void
    {
        // The recorder is a subscriber: an assertion thrown here would become the statement's SUBSCRIBER error, so the
        // case asserts the recorded times after its steps (assertElapsed).
        if ($e->elapsed < 0) {
            $this->negative[] = "event {$e->sql} has a negative elapsed time {$e->elapsed}";
        }
        $transaction = null;
        if ($e->transaction !== null) {
            $this->numbers[$e->transaction] ??= count($this->numbers) + 1;
            $transaction = $this->numbers[$e->transaction];
        }
        $this->records[] = [
            'sql' => $e->sql,
            'binds' => $e->binds,
            'kind' => $e->kind,
            'tables' => $e->tables,
            'transaction' => $transaction,
            'error' => $e->error?->code_,
        ];
    }

    private function byLabel(string $label): EventProbe
    {
        return (new EventProbe)($this->db)->label($label);
    }

    /** Runs one step. Throws the error. */
    public function step(array $s): void
    {
        switch ($s['op']) {
            case 'create':
                (new EventProbe)($this->db)->setLabel($s['label'])->create();
                return;
            case 'get':
                $this->byLabel($s['label'])->get();
                return;
            case 'count':
                $n = (new EventProbe)($this->db)->getCount();
                if (isset($s['result'])) {
                    Assert::assertTrue($n === $s['result'], "count = $n, want {$s['result']}");
                }
                return;
            case 'update':
                $this->byLabel($s['label'])->get()->setLabel($s['to'])->update();
                return;
            case 'delete':
                $this->byLabel($s['label'])->get()->delete();
                return;
            case 'transaction':
                $this->db->transaction(function () use ($s): void {
                    foreach ($s['steps'] as $inner) {
                        $this->checked($inner);
                    }
                    if ($s['fail'] ?? false) {
                        throw new CallbackFailed('callback failed');
                    }
                }, retry: 0);
                return;
            case 'install':
                $this->db->utils()->schema()->install(\Polyspec\Orm\Tests\StatementEventsCase\schema());
                return;
            case 'fail_subscriber':
                $kind = $s['kind'];
                $this->stopFailing = $this->db->subscribe(function (StatementEvent $e) use ($kind): void {
                    if ($e->kind === $kind) {
                        throw $this->refused = new RuntimeException('subscriber refused the event');
                    }
                });
                return;
            case 'stop_failing':
                ($this->stopFailing)();
                return;
            case 'unsubscribe':
                ($this->stopRecording)();
                return;
        }
        throw new RuntimeException("unknown step {$s['op']}");
    }

    /**
     * Runs the step and checks that its error is the one the step expected. An unexpected error ends the case.
     * The expected error is swallowed, so the outer transaction's callback continues.
     */
    public function checked(array $s): void
    {
        $want = $s['error'] ?? '';
        try {
            $this->step($s);
        } catch (\PHPUnit\Framework\AssertionFailedError $e) {
            // A failed assertion of a step is the case's failure, not the step's error.
            throw $e;
        } catch (Throwable $e) {
            if ($want === '') {
                throw $e;
            }
            if ($want === 'callback') {
                Assert::assertTrue($e instanceof CallbackFailed, "step {$s['op']} = " . $e::class . ": {$e->getMessage()}, want the callback error");
                return;
            }
            $code = $e instanceof OrmException ? $e->code_ : $e::class;
            Assert::assertTrue($code === $want, "step {$s['op']} = $code: {$e->getMessage()}, want $want");
            if ($want === Code::SUBSCRIBER) {
                Assert::assertTrue($e->getPrevious() !== null && $e->getPrevious() === $this->refused, 'the SUBSCRIBER error keeps the subscriber error as its previous exception');
            }
            return;
        }
        Assert::assertTrue($want === '', "step {$s['op']} succeeded, want $want");
    }
}

/** The value read back from JSON. Bind numbers and empty lists take the same form as in the vector. */
function normalized(array $records): mixed
{
    return json_decode(json_encode($records, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION), true, 512, JSON_THROW_ON_ERROR);
}

/** Makes the record's key order the same as the vector's. */
function ordered(array $records): array
{
    return array_map(static fn(array $r): array => [
        'sql' => $r['sql'], 'binds' => $r['binds'], 'kind' => $r['kind'], 'tables' => $r['tables'], 'transaction' => $r['transaction'], 'error' => $r['error'],
    ], $records);
}

function runCase(array $case, string $driver, string $dsn): void
{
    $db = Orm::connectSchema($dsn, \Polyspec\Orm\Tests\StatementEventsCase\schema(), new Config());
    try {
        if ($case['install'] ?? true) {
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\StatementEventsCase\schema());
        }
        $run = new EventRun($db);
        $run->stopRecording = $db->subscribe($run->record(...));
        foreach ($case['steps'] as $step) {
            $run->checked($step);
        }
        $run->assertElapsed();
        $got = $run->records;
        if (($case['compare'] ?? '') === 'tables') {
            $got = array_values(array_filter($got, static fn(array $r): bool => $r['tables'] !== []));
        }
        $got = normalized(ordered($got));
        $want = normalized(ordered($case['events'][$driver]));
        if ($got !== $want) {
            $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
            Assert::fail("$driver events\n got " . json_encode($got, $flags) . "\nwant " . json_encode($want, $flags));
        }
    } finally {
        $db->close();
    }
}

/**
 * Runs the vector's server_transactions on the PostgreSQL case database. The backend that the probe returns
 * local transaction number difference counts the server transactions of one page run. A PHP connection lives only
 * for one request, so each request is a first run, and the PHP of first_run_clients must have one
 * transaction per event even on the first run.
 *
 * @param array<string, mixed> $spec
 * @param array<string, array<string, mixed>> $cases
 */
function runServerTransactions(array $spec, array $cases, string $dsn): void
{
    $setup = Orm::connectSchema($dsn, \Polyspec\Orm\Tests\StatementEventsCase\schema(), new Config());
    try {
        $setup->utils()->schema()->install(\Polyspec\Orm\Tests\StatementEventsCase\schema());
    } finally {
        $setup->close();
    }
    $db = Orm::connectSchema($dsn, \Polyspec\Orm\Tests\StatementEventsCase\schema(), new Config());
    try {
        $u = $db->utils();
        $zone = $db->fetch('utility', [], null, "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'");
        // Through a pooler, the pooler applies the startup parameters to the server connection as SET, so
        // the source does not name the client. The source is compared only when it reaches the server directly.
        $pooled = getenv('ORM_TEST_POSTGRES_DSN') !== getenv('ORM_TEST_POSTGRES_SERVER_DSN');
        Assert::assertTrue(count($zone) === 1 && $zone[0][0] === $spec['time_zone']['setting'] && ($pooled || $zone[0][1] === $spec['time_zone']['source']),
            'TimeZone setting and source = ' . json_encode($zone) . ', want ' . json_encode($spec['time_zone']) . ($pooled ? ' (pooled)' : ''));
        $probe = static fn(): int => (int) $u->read('utility', [], $spec['probe'], []);
        $first = $probe();
        $cost = $probe() - $first;
        $run = new EventRun($db);
        $run->stopRecording = $db->subscribe($run->record(...));
        $compareFirst = in_array('php', $spec['first_run_clients'], true);
        $before = $probe();
        foreach (['first', 'second'] as $page) {
            $run->records = [];
            foreach ($cases[$spec['page']]['steps'] as $step) {
                $run->checked($step);
            }
            $events = count(array_filter($run->records, static fn(array $r): bool => $r['sql'] !== $spec['probe']));
            $after = $probe();
            $transactions = $after - $before - $cost;
            $before = $after;
            fwrite(STDERR, "server_transactions $page run: $events events, $transactions transactions\n");
            $run->assertElapsed();
            if ($page === 'second' || $compareFirst) {
                Assert::assertTrue($transactions === $events, "$page run spent $transactions server transactions for $events statement events, want one per event");
            }
        }
    } finally {
        $db->close();
    }
}
