<?php
declare(strict_types=1);
// The shared 2000-table document from tests/dbspec/stress.mjs rendered for
// SQLite, applied to a new file and introspected under the configured
// memory_limit: the document keeps its schema text and no object is
// unsupported.
require __DIR__ . '/autoload.php';

use Orm\Dbspec\Dbspec;

$started = hrtime(true);
echo 'RUN dbspec_introspect_stress memoryLimit=' . ini_get('memory_limit') . "\n";
$root = dirname(__DIR__, 3);
$process = proc_open(['node', "$root/tests/dbspec/stress.mjs"], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
if (!is_resource($process)) {
    throw new RuntimeException('node tests/dbspec/stress.mjs did not start');
}
$text = stream_get_contents($pipes[1]);
$errors = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
$status = proc_close($process);
if ($status !== 0 || $text === false || $text === '') {
    throw new RuntimeException("node tests/dbspec/stress.mjs failed with status $status: $errors");
}
$parsed = Dbspec::parse($text, []);
if ($parsed->document === null) {
    throw new RuntimeException('the stress document does not parse');
}
$rendered = Dbspec::render([$parsed->document], 'sqlite');
if ($rendered->statements === null) {
    throw new RuntimeException('the stress document does not render');
}
$want = Dbspec::manifest([$parsed->document])->manifest?->schemaText ?? throw new RuntimeException('the stress document has no manifest');
$path = sys_get_temp_dir() . '/dbspec_php_stress_' . getmypid() . '.sqlite';
if (file_exists($path)) {
    throw new RuntimeException("$path already exists");
}
// 검사에 쓴 값은 introspection 전에 놓아 그 메모리를 재지 않는다.
$statements = $rendered->statements;
unset($parsed, $rendered, $text);
try {
    $pdo = new PDO("sqlite:$path", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('BEGIN');
    foreach ($statements as $statement) {
        $pdo->exec($statement);
    }
    $pdo->exec('COMMIT');
    unset($statements);
    echo 'STEP applied elapsedMs=' . ((hrtime(true) - $started) / 1e6) . "\n";
    $introspectStarted = hrtime(true);
    $result = Dbspec::introspect($pdo, 'sqlite', 'stress');
    $introspectMs = (hrtime(true) - $introspectStarted) / 1e6;
    if ($result->unsupported !== []) {
        throw new RuntimeException('unsupported objects: ' . count($result->unsupported));
    }
    $got = Dbspec::manifest([$result->document])->manifest?->schemaText;
    if ($got !== $want) {
        throw new RuntimeException('the introspected schema text differs from the stress document');
    }
} finally {
    $pdo = null;
    foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
        if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
            throw new RuntimeException("$path$suffix cannot be removed");
        }
    }
}
echo 'PASS dbspec_introspect_stress introspectMs=' . round($introspectMs, 1) . ' peakBytes=' . memory_get_peak_usage(true)
    . ' memoryLimit=' . ini_get('memory_limit') . ' elapsedMs=' . round((hrtime(true) - $started) / 1e6, 1) . "\n";
