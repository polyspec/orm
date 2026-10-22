<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;

/** The flowmark server the test started, and its corpus. */
final class Served
{
    public string $bin = '';
    public ?Db $db = null;
    /** @var resource|null flowmark serve process */
    public $process = null;
    public string $root = '';
    public string $dir = '';
    public string $corpus = 'conformance';
    public string $port = '';
    public string $token = '';
    public string $stderr = '';

    public function dsn(string $corpus, string $token): string
    {
        return "markdown://127.0.0.1:{$this->port}/$corpus?token=$token";
    }
}
