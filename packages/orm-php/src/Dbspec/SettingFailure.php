<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * 설정 줄 하나를 첫 syntax 오류에서 멈춘다. 진단은 이미 기록되었고 줄은 버려진다.
 *
 * @internal
 */
final class SettingFailure extends \Exception
{
}
