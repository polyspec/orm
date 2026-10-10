<?php
declare(strict_types=1);
// PHP UnicodeWord의 표(Go의 Unicode 자료에서 tests/dbspec/unicode 생성기가 쓴 표)가 모든 code point에서 그 구간과 같은지 본다.
// Go의 구간은 그 생성기의 test가 Go와 맞춰 본다.
// Usage: php packages/orm-php/tests/dbspec_unicode_test.php
require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\UnicodeWord;

const LAST_CODE_POINT = 0x10FFFF;

$cases = new TestCases();
$cases->run('dbspec/unicode every code point', TESTCASE_COMPUTE, function (callable $step): void {
    // listed[cp]는 cp가 표의 구간 하나에 들면 '1'이다.
    $listed = str_repeat('0', LAST_CODE_POINT + 1);
    foreach (UnicodeWord::RANGES as [$lo, $hi]) {
        $listed = substr_replace($listed, str_repeat('1', $hi - $lo + 1), $lo, $hi - $lo + 1);
    }
    $step('the ranges are expanded to ' . (LAST_CODE_POINT + 1) . ' code points');

    $disagree = [];
    for ($cp = 0; $cp <= LAST_CODE_POINT; $cp++) {
        if (UnicodeWord::contains($cp) !== ($listed[$cp] === '1')) {
            $disagree[] = sprintf('U+%04X', $cp);
            if (count($disagree) === 10) {
                break;
            }
        }
    }
    if ($disagree !== []) {
        throw new RuntimeException('UnicodeWord::contains differs from its ranges at ' . implode(', ', $disagree) . '; run go run ./tests/dbspec/unicode -write');
    }
    $step('UnicodeWord::contains agrees at all ' . (LAST_CODE_POINT + 1) . ' code points');
});
$cases->finish();
