<?php
declare(strict_types=1);

/*
 * markdown IR executor의 unit case다(docs/protocol.md §5): markdown DSN, client가 보내는 connect와
 * control message와 error 줄의 해석, server가 거절한 connect, markdown 연결이 거절하는 SQL 전용
 * surface, 그리고 message encoder가 parameter마다 slot의 form을 읽는 Validator::paramUses다.
 * flowmark server 대신 markdown_fake_server.php가 한 연결의 message를 받아 적고 정한 답을 쓴다.
 */

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;

const MARKDOWN_TOKEN = '0123456789abcdef0123456789abcdef';
const MARKDOWN_CONNECT_LINE = '{"op":"connect","corpus":"tracker","token":"' . MARKDOWN_TOKEN . '"}';

/** 오류 code다. 던지지 않으면 null이다. */
function markdown_error(Closure $fn): ?OrmException
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e;
    }
    return null;
}

/**
 * markdown_fake_server.php를 $answers로 시작한다. 돌려주는 값은 [process, stdout, dsn]이다.
 *
 * @param list<string> $answers
 * @return array{0: resource, 1: resource, 2: string}
 */
function markdown_fake_server(array $answers): array
{
    $process = proc_open([PHP_BINARY, __DIR__ . '/markdown_fake_server.php', ...$answers], [1 => ['pipe', 'w'], 2 => STDERR], $pipes);
    if ($process === false) {
        throw new RuntimeException('cannot start markdown_fake_server.php');
    }
    $port = trim((string) fgets($pipes[1]));
    if (preg_match('/^[0-9]+$/', $port) !== 1) {
        throw new RuntimeException("markdown_fake_server.php printed \"$port\", not its port");
    }
    return [$process, $pipes[1], "markdown://127.0.0.1:$port/tracker?token=" . MARKDOWN_TOKEN];
}

/**
 * fake server가 받은 message 줄이다. server가 끝나기를 기다린다.
 *
 * @param array{0: resource, 1: resource, 2: string} $server
 * @return list<string>
 */
function markdown_received(array $server): array
{
    $line = (string) stream_get_contents($server[1]);
    fclose($server[1]);
    proc_close($server[0]);
    return json_decode($line, true, 512, JSON_THROW_ON_ERROR);
}

testcase_begin('markdown/parse_dsn', TESTCASE_COMPUTE);
$got = Orm::parseMarkdownDsn('markdown://127.0.0.1:4100/tracker?token=' . MARKDOWN_TOKEN);
if ($got !== ['127.0.0.1:4100', 'tracker', MARKDOWN_TOKEN]) {
    throw new RuntimeException('parseMarkdownDsn() = ' . json_encode($got));
}
foreach ([
    'markdown://127.0.0.1:4100/tracker',
    'markdown://127.0.0.1:4100/tracker?token=',
    'markdown://127.0.0.1:4100/tracker?token=a&token=b',
    'markdown://127.0.0.1:4100/tracker?token=a&mode=ro',
    'markdown://127.0.0.1/tracker?token=a',
    'markdown://127.0.0.1:0/tracker?token=a',
    'markdown://127.0.0.1:port/tracker?token=a',
    'markdown://localhost:4100/tracker?token=a',
    'markdown://10.0.0.1:4100/tracker?token=a',
    'markdown://user@127.0.0.1:4100/tracker?token=a',
    'markdown://127.0.0.1:4100/?token=a',
    'markdown://127.0.0.1:4100/a/b?token=a',
] as $input) {
    $e = markdown_error(static fn() => Orm::parseMarkdownDsn($input));
    if ($e?->code_ !== Code::CONFIG) {
        throw new RuntimeException("parseMarkdownDsn($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
    }
    $e = markdown_error(static fn() => Orm::connect($input, new Config()));
    if ($e?->code_ !== Code::CONFIG) {
        throw new RuntimeException("connect($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
    }
}
testcase_end();

testcase_begin('markdown/session_messages', TESTCASE_PROCESS);
$server = markdown_fake_server([
    '{"ok":true}',
    '{"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":true}',
    '{"ok":true}', '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was read"}}',
]);
$db = Orm::connect($server[2], new Config());
if ($db->driver() !== 'markdown') {
    throw new RuntimeException("driver() = {$db->driver()}; want markdown");
}
$db->transaction(static function () use ($db): void {
    $db->transaction(static function (): void {});
}, readOnly: true);
$e = markdown_error(static fn() => $db->transaction(static function (): void {}));
if ($e?->code_ !== Code::WRITE_CONFLICT || $e->getMessage() !== 'WRITE_CONFLICT: people.flowmark.md:3 changed since it was read') {
    throw new RuntimeException('commit error = ' . ($e?->getMessage() ?? 'none') . "; want WRITE_CONFLICT with the server's message");
}
$db->close();
$want = [
    MARKDOWN_CONNECT_LINE,
    '{"op":"begin","read_only":true}',
    '{"op":"savepoint","name":"orm_sp_1"}',
    '{"op":"release","name":"orm_sp_1"}',
    '{"op":"commit"}',
    '{"op":"begin"}',
    '{"op":"commit"}',
];
if (($got = markdown_received($server)) !== $want) {
    throw new RuntimeException("messages:\n" . implode("\n", $got) . "\nwant:\n" . implode("\n", $want));
}
testcase_end();

testcase_begin('markdown/connect_refused', TESTCASE_PROCESS);
$server = markdown_fake_server(['{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s token"}}']);
$e = markdown_error(static fn() => Orm::connect($server[2], new Config())->close());
if ($e?->code_ !== Code::CONFIG || $e->getMessage() !== "CONFIG: connect: the token is not the corpus's token") {
    throw new RuntimeException('connect error = ' . ($e?->getMessage() ?? 'none') . "; want the server's CONFIG");
}
if (($got = markdown_received($server)) !== [MARKDOWN_CONNECT_LINE]) {
    throw new RuntimeException('messages = ' . json_encode($got));
}
testcase_end();

testcase_begin('markdown/rejected_surfaces', TESTCASE_PROCESS);
$server = markdown_fake_server(['{"ok":true}']);
$db = Orm::connect($server[2], new Config());
$surfaces = [
    'isolation' => static fn() => $db->transaction(static function (): void {}, isolation: 'serializable'),
    'timeoutMs' => static fn() => $db->transaction(static function (): void {}, timeoutMs: 100),
    'audit' => static fn() => $db->transaction(static function (): void {}, audit: ['account' => 'a']),
    'lock' => static fn() => $db->utils()->lock('k'),
    'setLocal' => static fn() => $db->utils()->setLocal('k', 'v'),
    'local' => static fn() => $db->utils()->local('k'),
    'subscribe' => static fn() => $db->subscribe(static function (): void {}),
];
foreach ($surfaces as $name => $fn) {
    $e = markdown_error($fn);
    if ($e?->code_ !== Code::CAPABILITY_UNSUPPORTED) {
        throw new RuntimeException("$name: " . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED');
    }
}
$e = markdown_error(static fn() => Orm::connect($server[2], new Config(statementTimeoutMs: 100)));
if ($e?->code_ !== Code::CAPABILITY_UNSUPPORTED) {
    throw new RuntimeException('statementTimeoutMs: ' . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED');
}
$db->close();
markdown_received($server);
testcase_end();

testcase_begin('markdown/param_uses', TESTCASE_COMPUTE);
$model = RuntimeModel::build(RuntimeModel::parse(['params.dbs' => 'dbspec 1 params

table owners {
  id varchar(16)
  name varchar(32)
  primary key (id)
}

table notes {
  id i64 identity
  owner varchar(16)
  title varchar(64)
  born date null
  at datetime(3)
  version datetime(6) null
  primary key (id)
  index ix_notes_owner (owner)
  foreign key fk_notes_owner (owner) references owners (id)
}
']));
$validator = new Validator($model);
/** paramUses의 각 use를 [type, column 이름]으로 줄인 값이다. */
$usesOf = static fn(array $uses): array => array_map(
    static fn(array $list): array => array_map(static fn(array $u): array => [$u['type'], $u['column']['name'] ?? ''], $list),
    $uses,
);
$base = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash];
$requests = [
    'read' => [$base + ['kind' => 'all', 'entity' => 'notes',
        'where' => ['items' => [
            ['pred' => ['column' => 'title', 'op' => 'eq', 'p' => 0]],
            ['pred' => ['conn' => 'and', 'column' => 'born', 'op' => 'between', 'ps' => [1, 2]]],
            ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'eq', 'fn' => ['name' => 'year'], 'p' => 3]],
            ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'gt', 'value' => ['name' => 'days_ago', 'ps' => [4]]]],
            ['pred' => ['conn' => 'and', 'column' => 'title', 'op' => 'contains', 'p' => 5]],
            ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'eq', 'fn' => ['name' => 'date'], 'p' => 6]],
            ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'lt', 'value' => ['name' => 'seconds_later', 'ps' => [7]]]],
        ]],
        'relations' => [['rel' => 'owner_model', 'kind' => 'one', 'keys' => [['left' => 'owner', 'right' => 'id']],
            'query' => ['entity' => 'owners', 'if_parent' => ['column' => 'title', 'p' => 8]]]],
        'n_params' => 9], [
        [['varchar', 'title']],
        [['date', 'born']],
        [['date', 'born']],
        [['i64', '']],
        [['i32', '']],
        [['text', '']],
        [['date', '']],
        [['f64', '']],
        [['varchar', 'title']],
    ]],
    'insert' => [$base + ['kind' => 'insert', 'entity' => 'notes',
        'set' => [['column' => 'owner', 'p' => 0], ['column' => 'title', 'p' => 1], ['column' => 'at', 'p' => 2]],
        'rows' => [[3, 4, 5]], 'n_params' => 6], [
        [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
        [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
    ]],
    'update' => [$base + ['kind' => 'update', 'entity' => 'notes',
        'where' => ['items' => [['pred' => ['column' => 'id', 'op' => 'eq', 'p' => 0]]]],
        'set' => [['column' => 'title', 'p' => 1]],
        'optimistic' => ['column' => 'version', 'p' => 2], 'n_params' => 3], [
        [['i64', 'id']], [['varchar', 'title']], [['datetime', 'version']],
    ]],
];
foreach ($requests as $name => [$request, $want]) {
    $validator->validate($request);
    if (($got = $usesOf($validator->paramUses($request))) !== $want) {
        throw new RuntimeException("$name uses = " . json_encode($got) . "\nwant " . json_encode($want));
    }
}
testcase_end();
