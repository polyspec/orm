<?php

declare(strict_types=1);

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\IntrospectResult;
use Polyspec\Orm\Orm;

function dbspec_introspect_runner_output(IntrospectResult $result): string
{
    $out = Dbspec::emit($result->document);
    foreach ($result->unsupported as $unsupported) {
        $out .= "! {$unsupported->kind}\t{$unsupported->table}\t{$unsupported->name}\n";
    }
    return $out;
}

function dbspec_introspect_runner_run(string $dialect, string $uri): void
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($uri);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $start = hrtime(true);
    $result = Dbspec::introspect($pdo, $dialect, 'introspected');
    $elapsed = (hrtime(true) - $start) / 1e6;
    fwrite(STDOUT, dbspec_introspect_runner_output($result));
    fwrite(STDERR, sprintf("elapsed %.1f\n", $elapsed));
}
