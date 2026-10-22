<?php

declare(strict_types=1);

/*
 * Runs every case of tests/markdown/cases.json, in order, with the PHP client against the server of the flowmark build that FLOWMARK points at,
 * one at a time (tests/markdown/README.md). That build must be the one pinned by flowmark.version; if it is missing or a different build, the run fails (it does not skip). A case reads
 * the corpus that the earlier case wrote, so it stops at the first failure (the make target runs PHPUnit with --stop-on-defect).
 * Each case is
 * a data set named by its id in cases.json.
 *
 * Usage: FLOWMARK=<flowmark> vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist --stop-on-defect packages/php/tests/MarkdownConformanceTest.php
 */

use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\MarkdownModel\Logs;
use Polyspec\Orm\Tests\MarkdownModel\People;
use Polyspec\Orm\Tests\MarkdownModel\Tasks;
use function Polyspec\Orm\Tests\MarkdownModel\connect;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/** The flowmark server the test started, and its corpus. */
final class Served
{
    public string $bin = '';
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

/** The error the callback throws to roll back the transaction. */
final class Stop extends RuntimeException
{
}

#[Large]
final class MarkdownConformanceTest extends TestCase
{
    // conformanceDir is the directory of the shared suite: cases.json, flowmark.version, corpus/.
    private const MARKDOWN_CONFORMANCE_DIR = __DIR__ . '/../../../tests/markdown';
    // The module path, which must be the main module of the build that FLOWMARK points at.
    private const FLOWMARK_MODULE = 'github.com/polyspec/flowmark';

    /** @return list<array{id: string, expect: mixed}> */
    private static function loadCases(): array
    {
        $doc = json_decode(
            (string) file_get_contents(self::MARKDOWN_CONFORMANCE_DIR . '/cases.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
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
     * The flowmark binary that FLOWMARK points at. Fails unless the build information that `go version -m` reads is the
     * flowmark module's flowmark.version pin.
     */
    private static function pinnedFlowmark(): string
    {
        $pin = trim((string) file_get_contents(self::MARKDOWN_CONFORMANCE_DIR . '/flowmark.version'));
        $bin = (string) getenv('FLOWMARK');
        if ($bin === '') {
            throw new RuntimeException(
                "FLOWMARK is not set; run make markdown-conformance-check, which passes the path of the flowmark $pin pinned in tests/markdown/flowmark.version"
            );
        }
        [$code, $out, $err] = self::runProcess(['go', 'version', '-m', $bin]);
        $main = null;
        foreach (explode("\n", $out) as $line) {
            $fields = preg_split('/\t/', trim($line, "\r"));
            if (($fields[1] ?? '') === 'mod') {
                $main = [$fields[2] ?? '', $fields[3] ?? ''];
                break;
            }
        }
        if ($code !== 0 || $main === null) {
            throw new RuntimeException(
                "FLOWMARK $bin is no Go build (go version -m: " . trim(
                    $err . $out
                ) . "); run make orm-install-flowmark, which installs the flowmark $pin pinned in tests/markdown/flowmark.version"
            );
        }
        if ($main[0] !== self::FLOWMARK_MODULE || $main[1] !== $pin) {
            throw new RuntimeException(
                "FLOWMARK $bin is \"{$main[
                    0
                ]}\" \"{$main[
                    1
                ]}\", not the pinned " . self::FLOWMARK_MODULE . " $pin; run make orm-install-flowmark, or give FLOWMARK a build of a flowmark checkout at that revision"
            );
        }
        return $bin;
    }

    /**
     * Runs $command and waits for it to finish.
     *
     * @param list<string> $command
     * @return array{0: int, 1: string, 2: string} exit code, stdout, stderr
     */
    private static function runProcess(array $command): array
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

    /** Removes $path and everything under it. */
    private static function removeTree(string $path): void
    {
        if (!file_exists($path) && !is_link($path)) {
            return;
        }
        if (is_dir($path) && !is_link($path)) {
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry !== '.' && $entry !== '..') {
                    self::removeTree("$path/$entry");
                }
            }
            rmdir($path);
            return;
        }
        unlink($path);
    }

    /**
     * Installs corpus/ as a new corpus, starts that server, and connects to it. stopServing closes the connection
     * and waits for the server to stop, then removes the directory.
     */
    private static function serve(Served $s, string $bin, callable $step): void
    {
        $s->bin = $bin;
        $s->root = sys_get_temp_dir() . '/markdown-conformance-' . getmypid() . '-' . bin2hex(random_bytes(4));
        $s->dir = "{$s->root}/{$s->corpus}";
        if (!mkdir("{$s->dir}/dbspec", 0o755, true)) {
            throw new RuntimeException("cannot create {$s->dir}/dbspec");
        }
        if (
            !copy(
                self::MARKDOWN_CONFORMANCE_DIR . '/corpus/dbspec/conformance.dbs',
                "{$s->dir}/dbspec/conformance.dbs"
            )
        ) {
            throw new RuntimeException('cannot copy the corpus catalog');
        }
        $step("flowmark install {$s->dir}");
        [$code, $out, $err] = self::runProcess([$bin, 'install', $s->dir]);
        if ($code !== 0) {
            throw new RuntimeException("flowmark install exited $code:\n$out$err");
        }
        $step("flowmark serve {$s->dir} --port 0");
        $s->stderr = "{$s->root}/serve.stderr";
        $process = proc_open(
            [$bin, 'serve', $s->dir, '--port', '0'],
            [1 => ['pipe', 'w'], 2 => ['file', $s->stderr, 'w']],
            $pipes
        );
        if ($process === false) {
            throw new RuntimeException('cannot start flowmark serve');
        }
        $s->process = $process;
        $line = fgets($pipes[1]);
        fclose($pipes[1]);
        $listening = '/^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$/';
        if ($line === false || preg_match($listening, rtrim($line, "\n"), $m) !== 1 || $m[2] !== $s->corpus) {
            throw new RuntimeException(
                'flowmark serve printed ' . json_encode(
                    $line
                ) . ", not its listening line; stderr:\n" . (string) @file_get_contents(
                    $s->stderr
                )
            );
        }
        $s->port = $m[1];
        $file = json_decode(
            (string) file_get_contents("{$s->dir}/.flowmark/server.json"),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $s->token = (string) ($file['token'] ?? '');
        try {
            $s->db = connect($s->dsn($s->corpus, $s->token), new Config());
        } catch (OrmException $e) {
            throw new RuntimeException(
                "connect: {$e->code_} {$e->getMessage()}; stderr:\n" . (string) @file_get_contents($s->stderr),
                0,
                $e
            );
        }
    }

    /** Closes the connection, stops the server, waits for it to finish, and removes the corpus directory. */
    private static function stopServing(Served $s): void
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
                self::removeTree($s->root);
            }
        }
    }

    /** One date. */
    /** The text form of a date, which the date setters take; the text is checked by its parse. */
    private static function day(string $text): string
    {
        new DateTimeImmutable($text, new DateTimeZone('UTC'));
        return $text;
    }

    /**
     * The function that runs the case of each cases.json id. It returns the result value that the README fixes,
     * and an OrmException becomes the result {"error": code} with that code.
     *
     * @return array<string, Closure(Served): mixed>
     */
    public static function conformanceCases(): array
    {
        return [
            'insert_one' => static function (Served $s): mixed {
                $m = (new People())->connect($s->db)
                    ->setName('Ann')
                    ->setEmail('ann@example.com')
                    ->setAge(30)
                    ->setScore('1.50')
                    ->create();
                return ['id' => $m->getId()];
            },
            'insert_rows' => static function (Served $s): mixed {
                $bob = (new People())->setName('Bob')->setEmail('bob@example.com')->setAge(25)->setScore('2.00');
                $cara = (new People())->setName('Cara')->setEmail(null)->setAge(null)->setScore('0.50');
                return (new People())->connect($s->db)->creates([$bob, $cara], 2);
            },
            'insert_rows_tasks' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->creates([
                    (new Tasks())->setOwner('P1')
                        ->setTitle('write spec')
                        ->setPoints(3)
                        ->setDue(self::day('2026-10-01')),
                    (new Tasks())->setOwner('P1')->setTitle('review')->setPoints(5)->setDue(null),
                    (new Tasks())->setOwner('P2')->setTitle('ship')->setPoints(8)->setDue(self::day('2026-10-05')),
                ], 3);
            },
            'insert_identity' => static function (Served $s): mixed {
                $m = (new Logs())->connect($s->db)->setTask('T1')->setNote('started')->create();
                return ['id' => $m->getId()];
            },
            'one' => static function (Served $s): mixed {
                return (new People())->connect($s->db)
                    ->removeAllColumns()
                    ->addColumnName()
                    ->addColumnEmail()
                    ->addColumnAge()
                    ->addColumnActive()
                    ->addColumnScore()
                    ->id('P1')
                    ->get()
                    ->toArray();
            },
            'one_no_rows' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->id('P9')->get()?->toArray();
            },
            'all' => static function (Served $s): mixed {
                return (new People())->connect($s->db)
                    ->removeAllColumns()
                    ->addColumnName()
                    ->addColumnAge()
                    ->orderByNameDesc()
                    ->gets()
                    ->toArray();
            },
            'count' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->owner('P1')->getCount();
            },
            'group_count' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->groupByOwner()->orderByOwnerAsc()->getsCount()->toArray();
            },
            'group_count_no_rows' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)
                    ->owner('P9')
                    ->groupByOwner()
                    ->orderByOwnerAsc()
                    ->getsCount()
                    ->toArray();
            },
            'sum' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->sumPoints()->getSum();
            },
            'avg' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->avgAge()->getAvg();
            },
            'paginate' => static function (Served $s): mixed {
                $page = (new People())->connect($s->db)
                    ->removeAllColumns()
                    ->addColumnName()
                    ->orderByNameAsc()
                    ->getsPage(2, 2);
                return [
                    'items' => $page->items->toArray(),
                    'total_count' => $page->totalCount,
                    'total_pages' => $page->totalPages
                ];
            },
            'join' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->removeAllColumns()->addColumnTitle()
                    ->joinOwnerWithId((new People())->removeAllColumns()->addColumnName())
                    ->orderByTitleAsc()->gets()->toArray();
            },
            'relation_many' => static function (Served $s): mixed {
                return (new People())->connect($s->db)->removeAllColumns()->addColumnName()
                    ->relations(
                        (new Tasks())->removeAllColumns()->addColumnDue()->matchIdWithOwner()->orderByTitleAsc()
                    )
                    ->id('P1')->get()->toArray();
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
                $s->db->transaction(static function (): void {
                }, isolation: 'serializable');
                return null;
            },
            'write_conflict' => static function (Served $s): mixed {
                $code = null;
                try {
                    $s->db->transaction(static function () use ($s): void {
                        (new People())->id('P1')->get()->setName('Ann C')->update();
                        // Edit outside the engine: changes the file the transaction writes before the commit.
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
            // A transaction that reads P1 and writes its own name back, with retry options: the commit's code (null
            // when it commits) and how many times the callback ran. WRITE_CONFLICT is never retried, DEADLOCK is
            // (contracts/fixtures/ir_answers.json).
            'transaction_retry_commit' => static function (Served $s): mixed {
                $runs = 0;
                $code = null;
                try {
                    $s->db->transaction(static function () use (&$runs): void {
                        $runs++;
                        $m = (new People())->id('P1')->get();
                        $m->setName($m->getName())->update();
                    }, retry: 3);
                } catch (OrmException $e) {
                    $code = $e->code_;
                }
                return ['error' => $code, 'runs' => $runs];
            },
            'connect_corpus_mismatch' => static function (Served $s): mixed {
                connect($s->dsn('other', $s->token), new Config())->close();
                return null;
            },
            'connect_token_mismatch' => static function (Served $s): mixed {
                connect($s->dsn($s->corpus, str_repeat('0', 32)), new Config())->close();
                return null;
            },
            // NULL sorts before every value ascending and after every value descending (docs/spec/dialects.md DIA-156).
            'order_nulls' => static function (Served $s): mixed {
                return [
                    'asc' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->addColumnAge()
                        ->orderByAgeAsc()
                        ->gets()
                        ->toArray(),
                    'desc' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->addColumnAge()
                        ->orderByAgeDesc()
                        ->gets()
                        ->toArray(),
                ];
            },
            // orderByRandom is supported and not seeded, so the case answers the keys sorted (DIA-182).
            'order_random' => static function (Served $s): mixed {
                $keys = [];
                foreach ((new People())->connect($s->db)->removeAllColumns()->orderByRandom()->gets() as $m) {
                    $keys[] = $m->getId();
                }
                sort($keys, SORT_STRING);
                return $keys;
            },
            // The key t3 equals T3 without regard to case: a plain insert is DUPLICATE_KEY, and an on_duplicate insert
            // meets T3, which keeps its key (DIA-164).
            'primary_key_case' => static function (Served $s): mixed {
                $duplicate = self::codeOf(
                    static fn () => (new Tasks())->connect($s->db)
                        ->setId('t3')
                        ->setOwner('P2')
                        ->setTitle('dup')
                        ->setPoints(1)
                        ->create()
                );
                (new Tasks())->connect($s->db)->setId('t3')->setOwner('P2')->setTitle('ship it')->setPoints(8)
                    ->duplication((new Tasks())->setTitle('ship it'))->create();
                $met = (new Tasks())->connect($s->db)->removeAllColumns()->addColumnTitle()->id('T3')->get()->toArray();
                return [
                    'duplicate' => $duplicate,
                    'met' => $met,
                    'count' => (new Tasks())->connect($s->db)->getCount()
                ];
            },
            // Two columns compared with a list of value groups, IN and NOT IN (DIA-168).
            'tuple_in' => static function (Served $s): mixed {
                $pairs = [['T1', 'P1'], ['T3', 'P1']];
                return [
                    'in' => (new Tasks())->connect($s->db)
                        ->removeAllColumns()
                        ->tupleIdWithOwner($pairs)
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                    'not_in' => (new Tasks())->connect($s->db)
                        ->removeAllColumns()
                        ->neTupleIdWithOwner($pairs)
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                ];
            },
            // The sum of each person's task points as a scalar Sub aggregate, and the owners of a task through an IN
            // subquery (DIA-168).
            'subquery_aggregate' => static function (Served $s): mixed {
                $sums = [];
                foreach (
                    (new People())->connect($s->db)->removeAllColumns()
                    ->addColumnTaskPoints(static fn (People $p) => (new Tasks())->sumPoints()->ownerEqId($p))
                        ->orderByIdAsc()
                        ->gets() as $m
                ) {
                    $v = $m->getTaskPoints();
                    $sums[] = [$m->getId(), $v === null ? null : (int) $v];
                }
                $owners = (new People())->connect($s->db)
                    ->removeAllColumns()
                    ->id((new Tasks())->addColumnOwner())
                    ->orderByIdAsc()
                    ->gets()
                    ->toArray();
                return ['sums' => $sums, 'owners' => $owners];
            },
            // The title of each person's first task, a column subquery with limit 1 and an order by the primary key;
            // without the limit it is IR_INVALID (DIA-169).
            'scalar_column_subquery' => static function (Served $s): mixed {
                $first = [];
                foreach (
                    (new People())->connect($s->db)->removeAllColumns()
                    ->addColumnFirstTask(
                        static fn (People $p) => (new Tasks())->removeAllColumns()
                            ->addColumnTitle()
                            ->ownerEqId($p)
                            ->orderByIdAsc()
                            ->limit(0, 1)
                    )
                    ->orderByIdAsc()->gets() as $m
                ) {
                    $first[] = [$m->getId(), $m->getFirstTask()];
                }
                $unlimited = self::codeOf(static fn () => (new People())->connect($s->db)->removeAllColumns()
                    ->addColumnFirstTask(
                        static fn (People $p) => (new Tasks())->removeAllColumns()
                            ->addColumnTitle()
                            ->ownerEqId($p)
                            ->orderByIdAsc()
                    )
                    ->orderByIdAsc()->gets());
                return ['first' => $first, 'unlimited' => $unlimited];
            },
            // varchar with varchar meet; i32 with varchar do not and are OPERATOR_NOT_ALLOWED (DIA-170).
            'column_pairs' => static function (Served $s): mixed {
                $p = new People();
                $meet = (new Tasks())->connect($s->db)->joinOwnerWithId($p)->titleNeName($p)->getCount();
                $q = new People();
                return [
                    'meet' => $meet,
                    'refused' => self::codeOf(
                        static fn () => (new Tasks())->connect($s->db)
                            ->joinOwnerWithId($q)
                            ->pointsEqName($q)
                            ->getCount()
                    )
                ];
            },
            // Lk: A-Z and a-z without regard to case, % literal (DIA-171).
            'contains' => static function (Served $s): mixed {
                return [
                    'fold' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->lkName('ANN')
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                    'literal' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->lkName('%')
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                ];
            },
            // Lb: compared by code point (DIA-172).
            'contains_binary' => static function (Served $s): mixed {
                return [
                    'exact' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->lbName('Ann')
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                    'folded' => (new People())->connect($s->db)
                        ->removeAllColumns()
                        ->lbName('ann')
                        ->orderByIdAsc()
                        ->gets()
                        ->toArray(),
                ];
            },
            // The default now of joined, a datetime(0), holds no fraction, and a relative time function past 9999-12-31
            // is NULL and matches no row (DIA-173).
            'now_truncated' => static function (Served $s): mixed {
                $joined = (new People())->connect($s->db)->id('P1')->get()->getJoined();
                $far = Orm::secondsLater(1000000000000000);
                return [
                    'fraction' => (int) $joined->format('u'),
                    'out_of_range' => [
                        (new People())->connect($s->db)->andGtJoined($far)->getCount(),
                        (new People())->connect($s->db)->andLeJoined($far)->getCount()
                    ],
                ];
            },
            // A read through the column of the index ix_tasks_owner, which the corpus derives in memory (DIA-176).
            'index_read' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->removeAllColumns()->owner('P2')->gets()->toArray();
            },
            // An index hint, which the corpus does not name: CAPABILITY_UNSUPPORTED (DIA-186).
            'force_index' => static function (Served $s): mixed {
                return (new Tasks())->connect($s->db)->forceIndexIxTasksOwner()->owner('P1')->gets()->toArray();
            },
            // A heading of another table in tasks.flowmark.md is format.block: a read of tasks fails CONSTRAINT naming
            // the file, and reads again once the file is restored (DIA-190).
            'unavailable_table' => static function (Served $s): mixed {
                $path = "{$s->dir}/tasks.flowmark.md";
                $text = (string) file_get_contents($path);
                file_put_contents($path, $text . "\n## people row P1\n");
                $broken = null;
                $namesFile = false;
                try {
                    (new Tasks())->connect($s->db)->getCount();
                } catch (OrmException $e) {
                    $broken = $e->code_;
                    $namesFile = str_contains($e->getMessage(), 'tasks.flowmark.md');
                }
                file_put_contents($path, $text);
                return [
                    'broken' => $broken,
                    'names_file' => $namesFile,
                    'restored' => (new Tasks())->connect($s->db)->getCount()
                ];
            },
            // A catalog with an aes column is a schema error on a corpus (DIA-178).
            'install_refuses_aes' => static function (Served $s): mixed {
                return self::refusedInstall($s, 'aes');
            },
            // A catalog with an audit setting is a schema error on a corpus (DIA-179).
            'install_refuses_audit' => static function (Served $s): mixed {
                return self::refusedInstall($s, 'audit');
            },
        ];
    }

    /** The orm code of the error that $f throws, or null when it returns. */
    private static function codeOf(callable $f): ?string
    {
        try {
            $f();
            return null;
        } catch (OrmException $e) {
            return $e->code_;
        }
    }

    /**
     * The code that flowmark install prints when it refuses tests/markdown/refused/<name>.dbs, ['error' => code]; an
     * install that succeeds is ['error' => null].
     *
     * @return array{error: ?string}
     */
    private static function refusedInstall(Served $s, string $name): array
    {
        $root = sys_get_temp_dir() . '/markdown-refused-' . getmypid() . '-' . bin2hex(random_bytes(4));
        $dir = "$root/$name";
        try {
            if (
                !mkdir("$dir/dbspec", 0o755, true) || !copy(
                    self::MARKDOWN_CONFORMANCE_DIR . "/refused/$name.dbs",
                    "$dir/dbspec/$name.dbs"
                )
            ) {
                throw new RuntimeException("cannot write the catalog $dir/dbspec/$name.dbs");
            }
            $process = proc_open([$s->bin, 'install', $dir], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes);
            if (!is_resource($process)) {
                throw new RuntimeException("cannot run {$s->bin} install $dir");
            }
            $out = (string) stream_get_contents($pipes[1]);
            fclose($pipes[1]);
            if (proc_close($process) === 0) {
                return ['error' => null];
            }
            if (preg_match('/^flowmark install: ([A-Z_]+):/m', $out, $m) !== 1) {
                throw new RuntimeException("flowmark install $dir failed without a refusal code:\n$out");
            }
            return ['error' => $m[1]];
        } finally {
            if (is_file("$dir/dbspec/$name.dbs")) {
                unlink("$dir/dbspec/$name.dbs");
            }
            foreach (["$dir/dbspec", $dir, $root] as $d) {
                if (is_dir($d)) {
                    rmdir($d);
                }
            }
        }
    }

    /**
     * The result, written as JSON and read back, with the object's members in name order: the same shape as expect in
     * cases.json.
     */
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
        return $sorted(
            json_decode(
                json_encode($v, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                true,
                512,
                JSON_THROW_ON_ERROR
            )
        );
    }

    public static function jsonText(mixed $v): string
    {
        return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /** The flowmark server of the run, started once for the class and stopped when the class ends. */
    private static ?Served $served = null;

    /**
     * The cases of tests/markdown/cases.json in their order, each a data set named by its id. Every case of cases.json
     * has a PHP body and every PHP body a case; a difference fails here.
     *
     * @return iterable<string, array{array{id: string, expect: mixed}}>
     */
    public static function cases(): iterable
    {
        $cases = self::loadCases();
        $ids = array_column($cases, 'id');
        $funcs = self::conformanceCases();
        $missing = array_values(array_diff($ids, array_keys($funcs)));
        $extra = array_values(array_diff(array_keys($funcs), $ids));
        sort($extra, SORT_STRING);
        if ($missing !== [] || $extra !== []) {
            throw new RuntimeException(
                'cases.json and the PHP cases differ: missing in PHP ' . self::jsonText(
                    $missing
                ) . ', not in cases.json ' . self::jsonText($extra)
            );
        }
        foreach ($cases as $case) {
            yield $case['id'] => [$case];
        }
    }

    public static function setUpBeforeClass(): void
    {
        self::$served = new Served();
        self::serve(self::$served, self::pinnedFlowmark(), static function (string $step): void {
        });
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$served !== null) {
            self::stopServing(self::$served);
        }
    }

    /**
     * A case reads the corpus that the cases before it wrote, so the make target runs PHPUnit with --stop-on-defect:
     * the run stops at the first failure.
     *
     * @param array{id: string, expect: mixed} $case
     */
    #[DataProvider('cases')]
    public function testMarkdownConformance(array $case): void
    {
        $error = null;
        try {
            $got = self::conformanceCases()[$case['id']](self::$served);
        } catch (OrmException $e) {
            $error = $e;
            $got = ['error' => $e->code_];
        }
        $actual = self::normalize($got);
        $expect = self::normalize($case['expect']);
        $detail = $error === null ? '' : " (error {$error->code_}: {$error->getMessage()})";
        self::assertSame(
            $expect,
            $actual,
            "{$case['id']}: got " . self::jsonText($actual) . ', want ' . self::jsonText($expect) . $detail
        );
    }
}
