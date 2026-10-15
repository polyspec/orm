<?php
declare(strict_types=1);
/*
 * tests/markdown/cases.json의 모든 case를 그 순서대로, FLOWMARK가 가리키는 flowmark build의 server
 * 하나에 대해 PHP client로 실행한다(tests/markdown/README.md). 그 build는 flowmark.version이 고정한
 * build여야 하고, 없거나 다른 build이면 실행은 실패한다(건너뛰지 않는다). case는 앞 case가 쓴 corpus를
 * 읽으므로 첫 실패에서 멈춘다(make target이 PHPUnit을 --stop-on-defect로 실행한다). case마다 cases.json의 id로
 * 이름 붙은 data set이다.
 *
 * Usage: FLOWMARK=<flowmark> vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
 */
require_once dirname(__DIR__) . '/markdownmodel/bootstrap.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\MarkdownModel\Logs;
use Polyspec\Orm\Tests\MarkdownModel\People;
use Polyspec\Orm\Tests\MarkdownModel\Tasks;
use function Polyspec\Orm\Tests\MarkdownModel\connect;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/** test가 시작한 flowmark server와 그 corpus다. */
final class Served
{
    public ?Db $db = null;
    /** @var resource|null flowmark serve process */
    public $process = null;
    public string $root = '';
    public string $dir = '';
    public string $corpus = 'conformance';
    public string $port = '';
    public string $token = '';
    public string $stderr = '';

    public function dsn(string $corpus, string $token): string
    {
        return "markdown://127.0.0.1:{$this->port}/$corpus?token=$token";
    }
}

/** transaction을 rollback시키려고 callback이 던지는 오류다. */
final class Stop extends RuntimeException
{
}

#[Large]
final class MarkdownConformanceTest extends TestCase
{
    // conformanceDir는 공유 suite의 directory다: cases.json, flowmark.version, corpus/.
    private const MARKDOWN_CONFORMANCE_DIR = __DIR__ . '/../../../tests/markdown';
    // FLOWMARK가 가리키는 build의 main module이어야 하는 module path다.
    private const FLOWMARK_MODULE = 'github.com/polyspec/flowmark';

    /** @return list<array{id: string, expect: mixed}> */
    private static function load_cases(): array
    {
        $doc = json_decode((string) file_get_contents(self::MARKDOWN_CONFORMANCE_DIR . '/cases.json'), true, 512, JSON_THROW_ON_ERROR);
        $seen = [];
        foreach ($doc['cases'] as $case) {
            $id = $case['id'] ?? '';
            if (!is_string($id) || $id === '' || isset($seen[$id])) {
                throw new RuntimeException("cases.json: case id \"$id\" is empty or repeated");
            }
            $seen[$id] = true;
        }
        return $doc['cases'];
    }

    /**
     * FLOWMARK가 가리키는 flowmark binary다. `go version -m`이 읽은 build 정보가 flowmark module의
     * flowmark.version 판이 아니면 실패한다.
     */
    private static function pinned_flowmark(): string
    {
        $pin = trim((string) file_get_contents(self::MARKDOWN_CONFORMANCE_DIR . '/flowmark.version'));
        $bin = (string) getenv('FLOWMARK');
        if ($bin === '') {
            throw new RuntimeException("FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark $pin pinned in tests/markdown/flowmark.version");
        }
        [$code, $out, $err] = self::run_process(['go', 'version', '-m', $bin]);
        $main = null;
        foreach (explode("\n", $out) as $line) {
            $fields = preg_split('/\t/', trim($line, "\r"));
            if (($fields[1] ?? '') === 'mod') {
                $main = [$fields[2] ?? '', $fields[3] ?? ''];
                break;
            }
        }
        if ($code !== 0 || $main === null) {
            throw new RuntimeException("FLOWMARK $bin is no Go build (go version -m: " . trim($err . $out) . "); run make install-flowmark, which installs the flowmark $pin pinned in tests/markdown/flowmark.version");
        }
        if ($main[0] !== self::FLOWMARK_MODULE || $main[1] !== $pin) {
            throw new RuntimeException("FLOWMARK $bin is \"{$main[0]}\" \"{$main[1]}\", not the pinned " . self::FLOWMARK_MODULE . " $pin; run make install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision");
        }
        return $bin;
    }

    /**
     * $command를 실행하고 끝나기를 기다린다.
     *
     * @param list<string> $command
     * @return array{0: int, 1: string, 2: string} 종료 코드, stdout, stderr
     */
    private static function run_process(array $command): array
    {
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if ($process === false) {
            throw new RuntimeException('cannot start ' . implode(' ', $command));
        }
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $out, $err];
    }

    /** $path와 그 아래를 지운다. */
    private static function remove_tree(string $path): void
    {
        if (!file_exists($path) && !is_link($path)) {
            return;
        }
        if (is_dir($path) && !is_link($path)) {
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    self::remove_tree("$path/$entry");
                }
            }
            rmdir($path);
            return;
        }
        unlink($path);
    }

    /**
     * corpus/를 새 corpus로 install하고 그 server를 시작해 연결한다. stop_serving이 연결을 닫고
     * server를 멈춘 뒤 끝나기를 기다리고 directory를 지운다.
     */
    private static function serve(Served $s, string $bin, callable $step): void
    {
        $s->root = sys_get_temp_dir() . '/markdown-conformance-' . getmypid() . '-' . bin2hex(random_bytes(4));
        $s->dir = "{$s->root}/{$s->corpus}";
        if (!mkdir("{$s->dir}/dbspec", 0o755, true)) {
            throw new RuntimeException("cannot create {$s->dir}/dbspec");
        }
        if (!copy(self::MARKDOWN_CONFORMANCE_DIR . '/corpus/dbspec/conformance.dbs', "{$s->dir}/dbspec/conformance.dbs")) {
            throw new RuntimeException('cannot copy the corpus catalog');
        }
        $step("flowmark install {$s->dir}");
        [$code, $out, $err] = self::run_process([$bin, 'install', $s->dir]);
        if ($code !== 0) {
            throw new RuntimeException("flowmark install exited $code:\n$out$err");
        }
        $step("flowmark serve {$s->dir} --port 0");
        $s->stderr = "{$s->root}/serve.stderr";
        $process = proc_open([$bin, 'serve', $s->dir, '--port', '0'], [1 => ['pipe', 'w'], 2 => ['file', $s->stderr, 'w']], $pipes);
        if ($process === false) {
            throw new RuntimeException('cannot start flowmark serve');
        }
        $s->process = $process;
        $line = fgets($pipes[1]);
        fclose($pipes[1]);
        $listening = '/^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$/';
        if ($line === false || preg_match($listening, rtrim($line, "\n"), $m) !== 1 || $m[2] !== $s->corpus) {
            throw new RuntimeException('flowmark serve printed ' . json_encode($line) . ", not its listening line; stderr:\n" . (string) @file_get_contents($s->stderr));
        }
        $s->port = $m[1];
        $file = json_decode((string) file_get_contents("{$s->dir}/.flowmark/server.json"), true, 512, JSON_THROW_ON_ERROR);
        $s->token = (string) ($file['token'] ?? '');
        try {
            $s->db = connect($s->dsn($s->corpus, $s->token), new Config());
        } catch (OrmException $e) {
            throw new RuntimeException("connect: {$e->code_} {$e->getMessage()}; stderr:\n" . (string) @file_get_contents($s->stderr), 0, $e);
        }
    }

    /** 연결을 닫고 server를 멈춘 뒤 끝나기를 기다리고 corpus directory를 지운다. */
    private static function stop_serving(Served $s): void
    {
        try {
            $s->db?->close();
        } finally {
            if ($s->process !== null) {
                proc_terminate($s->process, 2);
                proc_close($s->process);
                $s->process = null;
            }
            if ($s->root !== '') {
                self::remove_tree($s->root);
            }
        }
    }

    /** 날짜 하나다. */
    private static function day(string $text): DateTimeImmutable
    {
        return new DateTimeImmutable($text, new DateTimeZone('UTC'));
    }

    /**
     * cases.json의 id마다 그 case를 실행하는 함수다. 함수는 README가 정한 결과 값을 돌려주고,
     * OrmException은 그 code의 {"error": code} 결과가 된다.
     *
     * @return array<string, Closure(Served): mixed>
     */
    public static function conformance_cases(): array
    {
        return [
            'insert_one' => static function (Served $s): mixed {
                $m = (new People())->connect($s->db)->setName('Ann')->setEmail('ann@example.com')->setAge(30)->setScore('1.50')->create();
                return ['id' => $m->getId()];
            },
            'insert_rows' => static function (Served $s): mixed {
                $bob = (new People())->setName('Bob')->setEmail('bob@example.com')->setAge(25)->setScore('2.00');
                $cara = (new People())->setName('Cara')->setEmail(null)->setAge(null)->setScore('0.50');
                return (new People())->connect($s->db)->creates([$bob, $cara]);
            },
            'insert_rows_tasks' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->creates([
                    (new Tasks())->setOwner('P1')->setTitle('write spec')->setPoints(3)->setDue(self::day('2026-10-01')),
                    (new Tasks())->setOwner('P1')->setTitle('review')->setPoints(5)->setDue(null),
                    (new Tasks())->setOwner('P2')->setTitle('ship')->setPoints(8)->setDue(self::day('2026-10-05')),
                ]);
            },
            'insert_identity' => static function (Served $s): mixed {
                $m = (new Logs())->connect($s->db)->setTask('T1')->setNote('started')->create();
                return ['id' => $m->getId()];
            },
            'one' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->removeAllColumns()->addColumnName()->addColumnEmail()->addColumnAge()->addColumnActive()->addColumnScore()->id('P1')->get()->toArray();
            },
            'one_no_rows' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->id('P9')->get()->toArray();
            },
            'all' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->removeAllColumns()->addColumnName()->addColumnAge()->orderByNameDesc()->gets()->toArray();
            },
            'count' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->owner('P1')->getCount();
            },
            'group_count' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->groupByOwner()->orderByOwnerAsc()->getsCount()->toArray();
            },
            'sum' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->sumPoints()->getSum();
            },
            'avg' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->avgAge()->getAvg();
            },
            'paginate' => static function (Served $s): mixed {
                $page = (new People())->connect($s->db)->removeAllColumns()->addColumnName()->orderByNameAsc()->getsPage(2, 2);
                return ['items' => $page->items->toArray(), 'total_count' => $page->totalCount, 'total_pages' => $page->totalPages];
            },
            'join' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->removeAllColumns()->addColumnTitle()
                    ->joinOwnerWithId((new People())->removeAllColumns()->addColumnName())
                    ->orderByTitleAsc()->gets()->toArray();
            },
            'relation_many' => static function (Served $s): mixed {
                $out = (new People())->connect($s->db)->removeAllColumns()->addColumnName()
                    ->relations((new Tasks())->removeAllColumns()->addColumnDue()->matchIdWithOwner()->orderByTitleAsc())
                    ->id('P1')->get()->toArray();
                // date 값은 runtime value model의 text YYYY-MM-DD다(README "Results"). PHP의 array form은 date를
                // datetime text로 쓰므로 relation 행의 due를 그 text로 쓴다.
                foreach ($out['tasks_models'] as $i => $task) {
                    if ($task['due'] !== null) {
                        $out['tasks_models'][$i]['due'] = (new \DateTimeImmutable($task['due']))->format('Y-m-d');
                    }
                }
                return $out;
            },
            'relation_one' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->removeAllColumns()->addColumnTitle()
                    ->relation((new People())->removeAllColumns()->addColumnName()->matchOwnerWithId())
                    ->id('T3')->get()->toArray();
            },
            'update' => static function (Served $s): mixed {
                $m = (new People())->connect($s->db)->id('P2')->get();
                $m->setAge(26)->update();
                return (new People())->connect($s->db)->removeAllColumns()->addColumnAge()->id('P2')->get()->toArray();
            },
            'update_optimistic_conflict' => static function (Served $s): mixed {
                $stale = (new People())->connect($s->db)->id('P2')->get();
                $fresh = (new People())->connect($s->db)->id('P2')->get();
                $fresh->setName('Bobby')->update();
                return $stale->setAge(27)->update(true)->toArray();
            },
            'insert_on_duplicate' => static function (Served $s): mixed {
                $m = (new People())->connect($s->db)->setName('Ann B')->setEmail('ann@example.com')
                    ->duplication((new People())->setName('Ann B'))->create();
                $read = (new People())->connect($s->db)->id('P1')->get();
                return ['created' => $m->getId(), 'name' => $read->getName()];
            },
            'delete' => static function (Served $s): mixed {
                (new Tasks())->connect($s->db)->id('T2')->get()->delete();
                return (new Tasks())->connect($s->db)->getCount();
            },
            'delete_referenced' => static function (Served $s): mixed {
                (new Tasks())->connect($s->db)->id('T1')->get()->delete();
                return null;
            },
            'soft_delete' => static function (Served $s): mixed {
                (new People())->connect($s->db)->id('P3')->get()->delete();
                return (new People())->connect($s->db)->getCount();
            },
            'restore' => static function (Served $s): mixed {
                $m = (new People())->connect($s->db)->setId('P3')->restore();
                $n = (new People())->connect($s->db)->getCount();
                return ['id' => $m->getId(), 'name' => $m->getName(), 'count' => $n];
            },
            'transaction_commit' => static function (Served $s): mixed {
                $s->db->transaction(static function (): void {
                    (new Logs())->setTask('T3')->setNote('committed')->create();
                });
                return (new Logs())->connect($s->db)->getCount();
            },
            'transaction_rollback' => static function (Served $s): mixed {
                try {
                    $s->db->transaction(static function (): void {
                        (new Logs())->setTask('T3')->setNote('rolled back')->create();
                        throw new Stop('stop');
                    });
                    throw new RuntimeException('the transaction ended without its callback\'s error');
                } catch (Stop) {
                }
                return (new Logs())->connect($s->db)->getCount();
            },
            'savepoint_rollback' => static function (Served $s): mixed {
                $s->db->transaction(static function () use ($s): void {
                    (new Logs())->setTask('T3')->setNote('outer')->create();
                    try {
                        $s->db->transaction(static function (): void {
                            (new Logs())->setTask('T3')->setNote('inner')->create();
                            throw new Stop('stop');
                        });
                        throw new RuntimeException('the savepoint ended without its callback\'s error');
                    } catch (Stop) {
                    }
                });
                $notes = [];
                foreach ((new Logs())->connect($s->db)->orderByIdAsc()->gets()->all() as $m) {
                    $notes[] = $m->getNote();
                }
                return $notes;
            },
            'read_only_write' => static function (Served $s): mixed {
                $s->db->transaction(static function (): void {
                    (new Logs())->setTask('T3')->setNote('read only')->create();
                }, readOnly: true);
                return null;
            },
            'lock_update' => static function (Served $s): mixed {
                return $s->db->transaction(static function () use ($s): array {
                    return (new People())->connect($s->db)->removeAllColumns()->id('P1')->forUpdate()->get()->toArray();
                });
            },
            'lock_nowait' => static function (Served $s): mixed {
                $s->db->transaction(static function () use ($s): void {
                    (new People())->connect($s->db)->id('P1')->forUpdateNoWait()->get();
                });
                return null;
            },
            'get_query' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->getQuery();
            },
            'isolation' => static function (Served $s): mixed {
                $s->db->transaction(static function (): void {}, isolation: 'serializable');
                return null;
            },
            'write_conflict' => static function (Served $s): mixed {
                $code = null;
                try {
                    $s->db->transaction(static function () use ($s): void {
                        (new People())->id('P1')->get()->setName('Ann C')->update();
                        // engine 밖의 편집: transaction이 쓸 file을 commit 전에 바꾼다.
                        $path = "{$s->dir}/people.flowmark.md";
                        $text = (string) file_get_contents($path);
                        if (!str_contains($text, 'Cara')) {
                            throw new RuntimeException("$path holds no Cara to edit:\n$text");
                        }
                        file_put_contents($path, preg_replace('/Cara/', 'Carol', $text, 1));
                    });
                } catch (OrmException $e) {
                    $code = $e->code_;
                }
                $read = (new People())->connect($s->db)->id('P1')->get();
                return ['error' => $code, 'name' => $read->getName()];
            },
            'connect_corpus_mismatch' => static function (Served $s): mixed {
                connect($s->dsn('other', $s->token), new Config())->close();
                return null;
            },
            'connect_token_mismatch' => static function (Served $s): mixed {
                connect($s->dsn($s->corpus, str_repeat('0', 32)), new Config())->close();
                return null;
            },
        ];
    }

    /** 결과를 JSON으로 썼다 읽고 object의 member를 이름 순서로 둔 값이다: cases.json의 expect와 같은 형태다. */
    public static function normalize(mixed $v): mixed
    {
        $sorted = static function (mixed $v) use (&$sorted): mixed {
            if (!is_array($v)) {
                return $v;
            }
            if (!array_is_list($v)) {
                ksort($v, SORT_STRING);
            }
            return array_map($sorted, $v);
        };
        return $sorted(json_decode(json_encode($v, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), true, 512, JSON_THROW_ON_ERROR));
    }

    public static function json_text(mixed $v): string
    {
        return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /** The flowmark server of the run, started once for the class and stopped when the class ends. */
    private static ?Served $served = null;

    /**
     * The cases of tests/markdown/cases.json in their order, each a data set named by its id. Every case of cases.json has a
     * PHP body and every PHP body a case; a difference fails here.
     *
     * @return iterable<string, array{array{id: string, expect: mixed}}>
     */
    public static function cases(): iterable
    {
        $cases = self::load_cases();
        $ids = array_column($cases, 'id');
        $funcs = self::conformance_cases();
        $missing = array_values(array_diff($ids, array_keys($funcs)));
        $extra = array_values(array_diff(array_keys($funcs), $ids));
        sort($extra, SORT_STRING);
        if ($missing !== [] || $extra !== []) {
            throw new RuntimeException('cases.json and the PHP cases differ: missing in PHP ' . self::json_text($missing) . ', not in cases.json ' . self::json_text($extra));
        }
        foreach ($cases as $case) {
            yield $case['id'] => [$case];
        }
    }

    public static function setUpBeforeClass(): void
    {
        self::$served = new Served();
        self::serve(self::$served, self::pinned_flowmark(), static function (string $step): void {});
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$served !== null) {
            self::stop_serving(self::$served);
        }
    }

    /**
     * A case reads the corpus that the cases before it wrote, so the make target runs PHPUnit with --stop-on-defect: the
     * run stops at the first failure.
     *
     * @param array{id: string, expect: mixed} $case
     */
    #[DataProvider('cases')]
    public function test_markdown_conformance(array $case): void
    {
        $error = null;
        try {
            $got = self::conformance_cases()[$case['id']](self::$served);
        } catch (OrmException $e) {
            $error = $e;
            $got = ['error' => $e->code_];
        }
        $actual = self::normalize($got);
        $expect = self::normalize($case['expect']);
        $detail = $error === null ? '' : " (error {$error->code_}: {$error->getMessage()})";
        self::assertSame($expect, $actual, "{$case['id']}: got " . self::json_text($actual) . ', want ' . self::json_text($expect) . $detail);
    }
}
