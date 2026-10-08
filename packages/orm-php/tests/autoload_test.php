<?php
// PHP test autoloader(packages/orm-php/tests/autoload.php)의 unit test다. 모든 PHP test가 autoloader를
// 쓰므로, 그 변경은 모든 기능의 검증이 아니라 이 test가 검사한다(contracts/features.json의
// helpers). 전체 검증은 make check가 실행한다.
// Usage: php packages/orm-php/tests/autoload_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

testcase_begin('autoload/classes', TESTCASE_COMPUTE);
$failures = [];
// 자기 file의 class, 다른 file에 함께 정의된 class(Frame은 Model.php), 하위 namespace의 class를 찾는다.
foreach (['Polyspec\\Orm\\Model', 'Polyspec\\Orm\\Frame', 'Polyspec\\Orm\\OrmException', 'Polyspec\\Orm\\Dbspec\\Dbspec'] as $class) {
    if (!class_exists($class)) {
        $failures[] = "$class is not found";
    }
}
// 없는 class는 찾지 못한다.
if (class_exists('Polyspec\\Orm\\NoSuchClass')) {
    $failures[] = 'Polyspec\\Orm\\NoSuchClass is found';
}
testcase_end($failures === [] ? null : implode('; ', $failures));
exit($failures === [] ? 0 : 1);
