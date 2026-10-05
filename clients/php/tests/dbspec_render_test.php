<?php
declare(strict_types=1);
// The statement vectors of tests/dbspec/ddl.json through
// Orm\Dbspec\Dbspec::render, and the unknown dialect rule.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';

use Orm\Dbspec\Dbspec;

$started = caseClockStart();
$root = dirname(__DIR__, 3);
$vectors = json_decode(file_get_contents("$root/tests/dbspec/ddl.json"), true, 512, JSON_THROW_ON_ERROR);
if (($vectors['cases'] ?? []) === []) {
    throw new RuntimeException('Missing ddl vectors');
}

/** @param list<string> $lines */
function render_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

$dialects = ['mysql', 'postgres', 'sqlite'];
foreach ($vectors['cases'] as $case) {
    // 각 vector는 memory 안에서 문서 하나를 세 dialect로 렌더링한다.
    testcase_begin("ddl/{$case['id']}", TESTCASE_COMPUTE);
    $documents = [];
    foreach ($case['documents'] as $name => $lines) {
        $set = [];
        foreach ($case['documents'] as $other => $otherLines) {
            if ($other !== $name) {
                $set[$other] = render_text($otherLines);
            }
        }
        $result = Dbspec::parse(render_text($lines), $set);
        if ($result->document === null) {
            throw new RuntimeException("{$case['id']}/$name: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $result->diagnostics)));
        }
        $documents[] = $result->document;
    }
    foreach ($dialects as $dialect) {
        $want = $case['statements'][$dialect] ?? throw new RuntimeException("{$case['id']}: no $dialect statements");
        // 문서 집합의 순서는 결과를 바꾸지 않는다.
        foreach ([$documents, array_reverse($documents)] as $set) {
            $rendered = Dbspec::render($set, $dialect);
            $got = $rendered->statements ?? throw new RuntimeException("{$case['id']}/$dialect: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $rendered->diagnostics)));
            for ($i = 0; $i < max(count($got), count($want)); $i++) {
                if (($got[$i] ?? null) !== ($want[$i] ?? null)) {
                    throw new RuntimeException("{$case['id']}/$dialect: statement $i differs\n--- want\n" . ($want[$i] ?? '(none)') . "\n--- got\n" . ($got[$i] ?? '(none)'));
                }
            }
        }
    }
    testcase_end();
}

testcase_begin('render/unknown-dialect', TESTCASE_COMPUTE);
try {
    Dbspec::render([], 'oracle');
    throw new RuntimeException('unknown dialect oracle was accepted');
} catch (InvalidArgumentException $e) {
    if (!str_contains($e->getMessage(), 'oracle')) {
        throw new RuntimeException('unknown dialect message does not name it: ' . $e->getMessage());
    }
}
testcase_end();

// 모든 vector를 합친 CPU 시간을 출력하고, 10 s 기준값을 넘으면 경고한다.
testcase_begin('dbspec_render/cpu-total', TESTCASE_COMPUTE);
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    testcase_warning(sprintf('dbspec_render used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s; machine %s %s, PHP %s', $cpuMs, $wallMs, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION));
}
testcase_step('cases=' . count($vectors['cases']) . " cpuMs=$cpuMs wallMs=$wallMs");
testcase_end();
