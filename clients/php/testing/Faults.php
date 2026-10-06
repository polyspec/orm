<?php
declare(strict_types=1);

namespace Polyspec\Orm\Testing;

use Polyspec\Orm\Db;

/**
 * PHP client의 test entry point다. package autoloader는 이 file을 map하지 않으므로,
 * process는 package의 `testing/Faults.php`를 path로 require한 뒤에만 이 class를
 * 가진다.
 */
final class Faults
{
    /**
     * connection에 test fault를 설정한다: callback이 실패한 다음 transaction의
     * rollback은 실행된 뒤 rollback 오류로 FAULT 오류를 보고하므로, transaction은
     * callback 오류와 fault를 가진 ROLLBACK 오류를 throw한다. fault는 그런
     * rollback이 소비할 때까지 남는다.
     */
    public static function failNextRollback(Db $db): void
    {
        (\Closure::bind(static function (Db $db): void {
            $db->rollbackFault = true;
        }, null, Db::class))($db);
    }
}
