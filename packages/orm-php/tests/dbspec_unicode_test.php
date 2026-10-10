<?php
declare(strict_types=1);
// The word table of PHP's UnicodeWord (generated from Go's unicode data by go run ./tests/dbspec/unicode -write)
// agrees with its own ranges at every code point. Go's ranges are checked against Go by that generator's test.
require __DIR__ . '/autoload.php';

use Polyspec\Orm\Dbspec\UnicodeWord;

const LAST_CODE_POINT = 0x10FFFF;

// listed[cp] is '1' exactly when cp lies in one of the table's ranges.
$listed = str_repeat('0', LAST_CODE_POINT + 1);
foreach (UnicodeWord::RANGES as [$lo, $hi]) {
    $listed = substr_replace($listed, str_repeat('1', $hi - $lo + 1), $lo, $hi - $lo + 1);
}

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
fwrite(STDOUT, 'dbspec unicode: ' . (LAST_CODE_POINT + 1) . " code points agree\n");
