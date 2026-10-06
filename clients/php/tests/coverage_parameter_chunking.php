<?php
declare(strict_types=1);
// parameter_chunking feature coverage: 모든 driver의 bind 한도보다 긴 root IN
// 목록은 나뉘어 실행되고 중복 값은 한 번만 읽히며, 나뉜 목록과 limit을 함께 쓰면
// IR_INVALID다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Code;

runCoverageCases($argv, [
    'root_in_chunking' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            // seq 1..70000, 그중 1..200의 중복, 없는 seq 200001..200100.
            $values = array_merge(range(1, 70000), range(1, 200), range(200001, 200100));
            $count = (new Author)($db)->seq($values)->getCount();
            coverageWant($count === 70000, "count of the split IN list is $count, want 70000");
            $limited = coverageCode(fn() => (new Author)($db)->seq($values)->limit(0, 10)->gets());
            coverageWant($limited === Code::IR_INVALID, "a limited split IN list is $limited, want IR_INVALID");
        } finally {
            $db->close();
        }
    },
]);
