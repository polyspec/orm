<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDOException;

/**
 * The refusal of a statement on a markdown connection as the PDO driver error of a SQLite connection: the orm code and
 * the message that the flowmark server answered (docs/spec/protocol.md PRT-71), and its errorInfo, the SQLite result
 * code that the answer states, or null. OrmException::fromDriver returns the code and the message as they are.
 *
 * @internal
 */
final class MarkdownError extends PDOException
{
    public function __construct(
        public readonly string $ormCode,
        string $message,
        ?int $resultCode,
        ?\Throwable $previous,
    ) {
        parent::__construct($message, 0, $previous);
        $this->errorInfo = ['HY000', $resultCode, $message];
    }
}
