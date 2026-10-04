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
// statement_events_test.php와 coverage_statement_events.php가 이 실행부를 쓴다.
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use Orm\StatementEvent;
use StatementEventsCase\Orm\EventProbe;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 자기 case database를 만들고
// fixture를 설치한 뒤 statement 열 개 안팎을 실행하고 database를 지운다.
const CASE_DEADLINE_SECONDS = TESTCASE_DATABASE;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-statement-events-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$fixture = (string) file_get_contents("$root/contracts/fixtures/statement_events.dbs");
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['statement_events.dbs' => $fixture])), "$work/models", 'StatementEventsCase\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'StatementEventsCase\\Orm\\')) {
        require "$work/models/" . substr($class, strlen('StatementEventsCase\\Orm\\')) . '.php';
    }
});
require "$work/models/bootstrap.php";

$vector = json_decode((string) file_get_contents("$root/tests/events/vectors.json"), true, 512, JSON_THROW_ON_ERROR);

$failures = 0;
$current = '';
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
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

    public function __construct(public readonly Db $db)
    {
    }

    public function record(StatementEvent $e): void
    {
        check($e->elapsed >= 0, "event {$e->sql} has a negative elapsed time {$e->elapsed}");
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
                    check($n === $s['result'], "count = $n, want {$s['result']}");
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
                $this->db->utils()->schema()->install(\StatementEventsCase\Orm\schema());
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
        } catch (Throwable $e) {
            if ($want === '') {
                throw $e;
            }
            if ($want === 'callback') {
                check($e instanceof CallbackFailed, "step {$s['op']} = " . $e::class . ": {$e->getMessage()}, want the callback error");
                return;
            }
            $code = $e instanceof OrmException ? $e->code_ : $e::class;
            check($code === $want, "step {$s['op']} = $code: {$e->getMessage()}, want $want");
            if ($want === Code::SUBSCRIBER) {
                check($e->getPrevious() !== null && $e->getPrevious() === $this->refused, 'the SUBSCRIBER error keeps the subscriber error as its previous exception');
            }
            return;
        }
        check($want === '', "step {$s['op']} succeeded, want $want");
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
    $db = Orm::connectSchema($dsn, \StatementEventsCase\Orm\schema(), new Config());
    try {
        if ($case['install'] ?? true) {
            $db->utils()->schema()->install(\StatementEventsCase\Orm\schema());
        }
        $run = new EventRun($db);
        $run->stopRecording = $db->subscribe($run->record(...));
        foreach ($case['steps'] as $step) {
            $run->checked($step);
        }
        $got = $run->records;
        if (($case['compare'] ?? '') === 'tables') {
            $got = array_values(array_filter($got, static fn(array $r): bool => $r['tables'] !== []));
        }
        $got = normalized(ordered($got));
        $want = normalized(ordered($case['events'][$driver]));
        if ($got !== $want) {
            $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
            check(false, "$driver events\n got " . json_encode($got, $flags) . "\nwant " . json_encode($want, $flags));
        }
    } finally {
        $db->close();
    }
}
