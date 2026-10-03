<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** Stops parsing at an encoding, header or limit error. */
final class ParseStop extends \Exception
{
}
