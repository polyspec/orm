<?php
declare(strict_types=1);

// 확장 orm_dbspec의 dbspec 인터페이스(Orm\Dbspec\Native\Dbspec)를 공유 vector와 순수 PHP client로 확인한다.
// - tests/dbspec/cases.json의 canonical, normalize, invalid case: vector가 정한 emission이나 diagnostic
//   (rule, line, column), 같은 입력에 대한 순수 PHP client Orm\Dbspec\Dbspec의 결과와 같다. message는 client마다
//   다르므로(docs/dbspec.md "Verification") 비교하지 않는다.
// - files case: readFile과 readBytes의 diagnostic과 message, 또는 text.
// - hashes case: manifest의 다섯 값이 순수 PHP client와 같다.
// - tests/dbspec/ddl.json: 세 dialect의 render statement가 순수 PHP client와 같다.
// - PHP 문자열이 byte이므로 생기는 경우(UTF-8이 아닌 text), 인자 오류와 결과 객체의 규칙.
//
// Usage: php -d extension=<orm_dbspec library> clients/php-extension/tests/dbspec_test.php

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Native\Dbspec as NativeDbspec;

$root = dirname(__DIR__, 3);
require "$root/clients/php/tests/autoload.php";
require "$root/clients/php/tests/dbspec_cases.php";
require_once "$root/tests/testcase.php";

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

/** @return list<string> diagnostic마다 "rule line column" */
function located(array $diagnostics): array
{
    return array_map(static fn(object $d): string => "{$d->rule} {$d->line} {$d->column}", $diagnostics);
}

/** @return list<string> diagnostic마다 "rule line column message" */
function described(array $diagnostics): array
{
    return array_map(static fn(object $d): string => "{$d->rule} {$d->line} {$d->column} {$d->message}", $diagnostics);
}

function same(string $what, mixed $want, mixed $got): void
{
    if ($want !== $got) {
        throw new RuntimeException("$what differs\n  want " . json_encode($want, JSON_UNESCAPED_SLASHES) . "\n  got  " . json_encode($got, JSON_UNESCAPED_SLASHES));
    }
}

/** $body가 $class 예외를 $message로 던지는지 확인한다. */
function throws(string $what, string $class, string $message, callable $body): void
{
    try {
        $body();
    } catch (Throwable $error) {
        same("$what exception", [$class, $message], [get_class($error), $error->getMessage()]);
        return;
    }
    throw new RuntimeException("$what threw nothing; expected $class: $message");
}

/** 문서 집합의 각 문서를 다른 문서를 집합으로 parse한다. 하나라도 diagnostic이 있으면 null이다. */
function parsed_set(string $dbspec, array $documents): ?array
{
    $names = array_keys($documents);
    sort($names, SORT_STRING);
    $texts = dbspec_documents($documents, false);
    $parsed = [];
    foreach ($names as $name) {
        $set = $texts;
        unset($set[$name]);
        $result = $dbspec::parse($texts[$name], $set);
        if ($result->document === null) {
            return null;
        }
        $parsed[] = $result->document;
    }
    return $parsed;
}

$cases = json_decode(file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);
$ddl = json_decode(file_get_contents("$root/tests/dbspec/ddl.json"), true, 512, JSON_THROW_ON_ERROR);
$failed = 0;
$run = static function (string $name, callable $body) use (&$failed): void {
    if (!testcase_run($name, TESTCASE_COMPUTE, $body)) {
        $failed++;
    }
};

foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    $run("php-extension/$kind", static function (callable $step) use ($cases, $kind): void {
        foreach ($cases[$kind] as $case) {
            $id = "$kind/{$case['id']}";
            $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
            $native = NativeDbspec::parse($texts[$case['main']], $texts);
            $php = Dbspec::parse($texts[$case['main']], $texts);
            same("$id diagnostics against the PHP client", located($php->diagnostics), located($native->diagnostics));
            if ($kind === 'invalid') {
                same("$id diagnostics", array_map(static fn(array $e): string => "{$e['rule']} {$e['line']} {$e['column']}", $case['errors']), located($native->diagnostics));
                same("$id document", null, $native->document);
                continue;
            }
            $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
            same("$id emission", $want, NativeDbspec::emit($native->document));
            $again = NativeDbspec::parse($want, $texts);
            same("$id emission of the emission", $want, NativeDbspec::emit($again->document));
        }
        $step(count($cases[$kind]) . ' cases');
    });
}

$run('php-extension/files', static function (callable $step) use ($cases, $root): void {
    $messages = ['signature' => ' is not a dbspec document', 'encoding' => ' is not valid UTF-8'];
    foreach ($cases['files'] as $case) {
        $path = "$root/tests/dbspec/{$case['path']}";
        $reads = [
            'file' => [$path, NativeDbspec::readFile($path)],
            'bytes' => [$case['path'], NativeDbspec::readBytes($case['path'], (string) file_get_contents($path))],
        ];
        foreach ($reads as $kind => [$name, $read]) {
            $id = "files/{$case['id']}/$kind";
            $want = array_map(static fn(array $e): string => "{$e['rule']} {$e['line']} {$e['column']} $name{$messages[$e['rule']]}", $case['errors']);
            same("$id diagnostics", $want, described($read->diagnostics));
            same("$id text", $case['errors'] === [] ? file_get_contents($path) : null, $read->text);
        }
    }
    $step(count($cases['files']) . ' files read twice');
});

$run('php-extension/hashes', static function (callable $step) use ($cases): void {
    foreach ($cases['hashes'] as $case) {
        $native = parsed_set(NativeDbspec::class, $case['documents']);
        $php = parsed_set(Dbspec::class, $case['documents']);
        same("hashes/{$case['id']} parse", $php === null, $native === null);
        $nativeManifest = NativeDbspec::manifest($native)->manifest;
        $phpManifest = Dbspec::manifest($php)->manifest;
        foreach (['manifestText', 'schemaText', 'manifestHash', 'schemaHash', 'externalText'] as $field) {
            same("hashes/{$case['id']} $field", $phpManifest->$field, $nativeManifest->$field);
        }
    }
    $step(count($cases['hashes']) . ' manifests');
});

$run('php-extension/render', static function (callable $step) use ($ddl): void {
    $count = 0;
    foreach ($ddl['cases'] as $case) {
        $native = parsed_set(NativeDbspec::class, $case['documents']);
        $php = parsed_set(Dbspec::class, $case['documents']);
        same("render/{$case['id']} parse", $php === null, $native === null);
        if ($native === null) {
            continue;
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $nativeResult = NativeDbspec::render($native, $dialect);
            $phpResult = Dbspec::render($php, $dialect);
            same("render/{$case['id']}/$dialect diagnostics", located($phpResult->diagnostics), located($nativeResult->diagnostics));
            same("render/{$case['id']}/$dialect statements", $phpResult->statements, $nativeResult->statements);
            $count++;
        }
    }
    $step("$count renderings");
});

$run('php-extension/manifest-set-diagnostics', static function (callable $step): void {
    // 같은 이름의 문서 둘은 name.duplicate diagnostic 하나이고 manifest와 statement가 없다.
    $text = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
    $set = [NativeDbspec::parse($text, [])->document, NativeDbspec::parse($text, [])->document];
    $phpSet = [Dbspec::parse($text, [])->document, Dbspec::parse($text, [])->document];
    $manifest = NativeDbspec::manifest($set);
    same('manifest', null, $manifest->manifest);
    same('manifest diagnostics', located(Dbspec::manifest($phpSet)->diagnostics), located($manifest->diagnostics));
    $render = NativeDbspec::render($set, 'sqlite');
    same('render statements', null, $render->statements);
    same('render diagnostics', located(Dbspec::render($phpSet, 'sqlite')->diagnostics), located($render->diagnostics));
    $step('name.duplicate');
});

$run('php-extension/bytes', static function (callable $step): void {
    // PHP 문자열은 byte다. UTF-8이 아닌 text는 순수 PHP client와 같은 encoding diagnostic 하나다.
    $texts = [
        'invalid byte' => "dbspec 1 shop\n\ntable t\xFF {\n",
        'invalid byte after a lone carriage return' => "dbspec 1 shop\r\ntable \rt\xFF {\n",
        'byte order mark and an invalid byte' => "\xEF\xBB\xBFdbspec 1 shop\n\xC3\n",
        'invalid byte in the header' => "dbspec 1 sh\xE9p\n",
        'truncated sequence at the end' => "dbspec 1 shop\n# caf\xC3",
    ];
    foreach ($texts as $what => $text) {
        $native = NativeDbspec::parse($text, []);
        same("$what document", null, $native->document);
        same("$what diagnostics", described(Dbspec::parse($text, [])->diagnostics), described($native->diagnostics));
    }
    $step(count($texts) . ' texts');
});

$run('php-extension/arguments', static function (callable $step) use ($root): void {
    $text = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
    $document = NativeDbspec::parse($text, [])->document;
    $set = 'The declared document set maps document names to texts';
    throws('an integer document name', InvalidArgumentException::class, $set, static fn() => NativeDbspec::parse($text, [1 => $text]));
    throws('an integer document name in the PHP client', InvalidArgumentException::class, $set, static fn() => Dbspec::parse($text, [1 => $text]));
    throws('a document text that is not a string', InvalidArgumentException::class, $set, static fn() => NativeDbspec::parse($text, ['core' => 1]));
    throws('a used document that is not UTF-8', InvalidArgumentException::class, 'The text of the declared document `core` is not valid UTF-8',
        static fn() => NativeDbspec::parse($text, ['core' => "dbspec 1 core\xFF"]));
    $dialect = 'Unknown dialect `oracle`; the dialects are mysql, postgres and sqlite';
    throws('an unknown dialect', InvalidArgumentException::class, $dialect, static fn() => NativeDbspec::render([$document], 'oracle'));
    throws('an unknown dialect in the PHP client', InvalidArgumentException::class, $dialect, static fn() => Dbspec::render([Dbspec::parse($text, [])->document], 'oracle'));
    $documents = 'The document set lists Orm\\Dbspec\\Native\\Document objects';
    throws('a manifest of a text', InvalidArgumentException::class, $documents, static fn() => NativeDbspec::manifest([$text]));
    throws('a rendering of a PHP client document', InvalidArgumentException::class, $documents, static fn() => NativeDbspec::render([Dbspec::parse($text, [])->document], 'mysql'));
    $missing = "$root/tests/dbspec/files/missing.dbs";
    throws('a missing file', RuntimeException::class, "cannot read $missing: No such file or directory (os error 2)", static fn() => NativeDbspec::readFile($missing));
    $directory = "$root/tests/dbspec/files";
    $read = null;
    try {
        $read = NativeDbspec::readFile($directory);
    } catch (RuntimeException $error) {
        if (!str_starts_with($error->getMessage(), "cannot read $directory: ")) {
            throw $error;
        }
    }
    same('a directory read', null, $read);
    throws('a path that is not UTF-8', InvalidArgumentException::class, 'The path is not valid UTF-8', static fn() => NativeDbspec::readFile("$root/\xFF.dbs"));
    $step('arguments rejected');
});

$run('php-extension/objects', static function (callable $step): void {
    $result = NativeDbspec::parse("dbspec 1 shop\n\ntable users {\n  id i64\n  primary key (id)\n}\n", []);
    same('the same document object', true, $result->document === $result->document);
    same('the signature', Dbspec::SIGNATURE, NativeDbspec::SIGNATURE);
    $diagnostic = NativeDbspec::parse('x', [])->diagnostics[0];
    // 결과 객체는 순수 PHP client처럼 readonly이고 동적 property를 갖지 않으며 확장만 만든다.
    throws('a write', Error::class, 'Cannot modify readonly property Orm\\Dbspec\\Native\\Diagnostic::$line', static function () use ($diagnostic): void {
        $diagnostic->line = 2;
    });
    throws('a dynamic property', Error::class, 'Cannot create dynamic property Orm\\Dbspec\\Native\\Diagnostic::$extra', static function () use ($diagnostic): void {
        $diagnostic->extra = 1;
    });
    throws('a new diagnostic', Error::class, 'Call to private Orm\\Dbspec\\Native\\Diagnostic::__construct() from global scope', static fn() => new Orm\Dbspec\Native\Diagnostic());
    throws('a new document', Exception::class, 'You cannot instantiate this class from PHP.', static fn() => new Orm\Dbspec\Native\Document());
    same('the properties in declaration order', ['rule', 'line', 'column', 'message'], array_keys(get_object_vars($diagnostic)));
    $step('readonly results');
});

exit($failed === 0 ? 0 : 1);
