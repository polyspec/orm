<?php
// Statement events (docs/usage.md "Statement events"), on SQLite, MySQL and
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
// StatementEventsTest.php와 statement_events coverage가 이 실행부를 쓴다: statementEventsModels로 model을 만든
// 뒤 runCase와 runServerTransactions를 PHPUnit test 안에서 부른다. 각 확인은 PHPUnit assertion이다.
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
 * contracts/fixtures/statement_events.dbs의 model을 이 process의 임시 directory에 한 번 만들고 autoload한다.
 * directory는 process가 끝날 때 지운다.
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

/** 실패하는 transaction callback의 오류다. step의 error "callback"이 이 오류를 기대한다. */
final class CallbackFailed extends RuntimeException
{
}

/** case 하나를 실행하는 상태다. */
final class EventRun
{
    /** @var list<array<string, mixed>> */
    public array $records = [];
    /** @var array<int, int> 연결의 transaction 번호를 case 안에서 처음 나온 순서의 번호로 바꾼다. */
    private array $numbers = [];
    public ?Closure $stopRecording = null;
    public ?Closure $stopFailing = null;
    /** fail_subscriber가 던진 오류다. SUBSCRIBER 오류의 previous가 이 오류다. */
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

    /** step 하나를 실행한다. 오류는 던진다. */
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
     * step을 실행하고 그 오류가 step이 기대한 것인지 확인한다. 기대하지 않은 오류는 case를
     * 끝낸다. 기대한 오류는 삼켜 바깥 transaction의 callback이 이어진다.
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

/** JSON으로 다시 읽은 값이다. bind의 숫자와 빈 목록이 vector와 같은 형태가 된다. */
function normalized(array $records): mixed
{
    return json_decode(json_encode($records, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION), true, 512, JSON_THROW_ON_ERROR);
}

/** record의 key 순서를 vector와 같게 한다. */
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
 * vector의 server_transactions를 PostgreSQL case database에서 실행한다. probe가 돌려주는 backend의
 * local transaction 번호 차이로 page 실행 한 번의 server transaction을 센다. PHP 연결은 요청 하나
 * 동안만 살므로 요청마다 첫 실행이고, first_run_clients의 PHP는 첫 실행도 event마다 transaction
 * 하나여야 한다.
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
        // pooler를 거치면 pooler가 startup parameter를 server connection에 SET으로 적용하므로
        // source는 client를 말하지 않는다. source는 server에 바로 닿을 때만 비교한다.
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
