<?php
declare(strict_types=1);
// model_generation feature coverage: commit된 생성 명령과 같은 인자로
// orm-gen의 check mode를 실행하면 clients/php/gen이 generator 출력과 같다고
// 보고하고, 한 byte를 바꾼 사본은 다르다고 보고한다.

require __DIR__ . '/coverage_cases.php';

/** @return array{int, string} 저장소 root에서 실행한 orm-gen check의 종료 코드와 출력 */
function generationCheck(string $root, string $out): array
{
    [$status, $stdout, $stderr] = coverageProcess(
        [PHP_BINARY, 'clients/php/bin/orm-gen', 'gen', '--out', $out, '--namespace', 'Polyspec\\Orm\\Tests\\Model', '--check', 'schema/bench.dbs'],
        $root,
    );
    return [$status, $stdout . $stderr];
}

runCoverageCases($argv, [
    'model_generation_check' => function (): void {
        $root = dirname(__DIR__, 3);
        [$status, $output] = generationCheck($root, 'clients/php/gen');
        coverageWant($status === 0 && $output === '', "check of the committed models exited $status: $output");
        $copy = sys_get_temp_dir() . '/orm-php-coverage-generation-' . getmypid();
        if (!mkdir($copy, 0o700, true)) {
            throw new RuntimeException("cannot create $copy");
        }
        try {
            foreach (glob("$root/clients/php/gen/*.php") ?: [] as $file) {
                if (!copy($file, "$copy/" . basename($file))) {
                    throw new RuntimeException("cannot copy $file");
                }
            }
            [$status, $output] = generationCheck($root, $copy);
            coverageWant($status === 0 && $output === '', "check of the unchanged copy exited $status: $output");
            // 생성된 PHP 본문의 한 byte를 바꾼다: `final class Author`의 `B`를 `C`로.
            $changed = "$copy/Author.php";
            $text = file_get_contents($changed);
            $at = $text === false ? false : strpos($text, 'final class Author');
            if ($at === false) {
                throw new RuntimeException("cannot read the class line of $changed");
            }
            $text[$at + strlen('final class ')] = 'C';
            if (file_put_contents($changed, $text) !== strlen($text)) {
                throw new RuntimeException("cannot write $changed");
            }
            [$status, $output] = generationCheck($root, $copy);
            coverageWant($status === 1 && $output === "differs: $changed\n", "check of the changed copy exited $status: $output");
        } finally {
            exec('rm -rf ' . escapeshellarg($copy), $removed, $code);
            if ($code !== 0) {
                throw new RuntimeException("cannot remove $copy");
            }
        }
    },
]);
