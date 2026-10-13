<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One error of Dbspec::readSet: its `set.*` rule, the path it concerns (the set file's path, or the joined
 * path of an entry) and a message that names the path.
 */
final readonly class SetError
{
    public function __construct(public string $rule, public string $path, public string $message)
    {
    }
}
