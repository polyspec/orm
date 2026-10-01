<?php
declare(strict_types=1);
// The statement vectors of tests/dbspec/ddl.json through
// Orm\Dbspec\Dbspec::render, and the unknown dialect rule.
require __DIR__ . '/autoload.php';

use Orm\Dbspec\Dbspec;

$started = hrtime(true);
echo "RUN dbspec_render\n";
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
    $caseStarted = hrtime(true);
    echo "RUN ddl/{$case['id']}\n";
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
            $got = Dbspec::render($set, $dialect);
            for ($i = 0; $i < max(count($got), count($want)); $i++) {
                if (($got[$i] ?? null) !== ($want[$i] ?? null)) {
                    throw new RuntimeException("{$case['id']}/$dialect: statement $i differs\n--- want\n" . ($want[$i] ?? '(none)') . "\n--- got\n" . ($got[$i] ?? '(none)'));
                }
            }
        }
    }
    echo "PASS ddl/{$case['id']} elapsedMs=" . ((hrtime(true) - $caseStarted) / 1e6) . "\n";
}

echo "RUN render/unknown-dialect\n";
try {
    Dbspec::render([], 'oracle');
    throw new RuntimeException('unknown dialect oracle was accepted');
} catch (InvalidArgumentException $e) {
    if (!str_contains($e->getMessage(), 'oracle')) {
        throw new RuntimeException('unknown dialect message does not name it: ' . $e->getMessage());
    }
}
echo "PASS render/unknown-dialect\n";

$elapsed = (hrtime(true) - $started) / 1e6;
if ($elapsed > 10000) {
    throw new RuntimeException("dbspec_render deadline of 10 s exceeded ($elapsed ms)");
}
echo 'PASS dbspec_render cases=' . count($vectors['cases']) . " elapsedMs=$elapsed\n";
