<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;

/** A local SQLite PDO that records the SQL and parameters run through the native Model. */
final class NativeQueryProbePdo extends PDO
{
    /** @var list<array{sql: string, params: list<mixed>}> */
    public array $executions = [];

    public function __construct()
    {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        parent::setAttribute(PDO::ATTR_STATEMENT_CLASS, [NativeQueryProbeStatement::class, [$this]]);
    }
}
