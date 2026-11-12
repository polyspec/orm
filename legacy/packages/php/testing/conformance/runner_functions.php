<?php

// The functions of the PHP conformance runner (runner.php), which requires this file.
declare(strict_types=1);

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

/** Renders a bound value the way every runner does. */
function norm(mixed $v): mixed
{
    global $maskSeqs;
    if (is_int($v)) {
        return isset($maskSeqs[$v]) ? '$SEQ' : $v;
    }
    if (is_string($v)) {
        if (str_starts_with($v, "ORM-AES2\0")) {
            if (strlen($v) < 9 + 12 + 16) {
                throw new RuntimeException('invalid AES ciphertext bind');
            }
            return '$AES';
        }
        if (str_starts_with($v, 'ORM-AES2')) {
            throw new RuntimeException('invalid AES ciphertext bind');
        }
        if (str_starts_with(strtolower($v), '4f524d2d41455332')) {
            $decoded = hex2bin($v);
            if ($decoded === false || !str_starts_with($decoded, "ORM-AES2\0") || strlen($decoded) < 9 + 12 + 16) {
                throw new RuntimeException('invalid hex AES ciphertext bind');
            }
            return '$AES';
        }
    }
    return $v;
}

/** Masks the keys of rows a vector created, including statements logged earlier. */
function mask(array $seqs): void
{
    global $log, $maskSeqs;
    foreach ($seqs as $s) {
        $maskSeqs[$s] = true;
    }
    foreach ($log as &$st) {
        $st['binds'] = array_map('norm', $st['binds']);
    }
}

function code(?Throwable $e): mixed
{
    if ($e === null) {
        return null;
    }
    return $e instanceof OrmException ? $e->code_ : $e->getMessage();
}

function caught(callable $fn): mixed
{
    try {
        $fn();
    } catch (Throwable $e) {
        return code($e);
    }
    return null;
}

function pick(?Model $m, string ...$names): ?array
{
    if ($m === null) {
        return null;
    }
    $all = $m->toArray();
    $out = [];
    foreach ($names as $n) {
        if (!array_key_exists($n, $all)) {
            throw new RuntimeException("missing selected field: $n");
        }
        $out[$n] = $all[$n];
    }
    return $out;
}

function picks(Collection $c, string ...$names): array
{
    return array_map(static fn(Model $m): ?array => pick($m, ...$names), $c->all());
}

/** Declares a vector. The selected vectors run in declaration order after all declarations are done. */
function vector(string $name, callable $fn): void
{
    global $vectors;
    if (isset($vectors[$name])) {
        throw new RuntimeException("duplicate vector $name");
    }
    $vectors[$name] = $fn;
}

function run(string $name, callable $fn): void
{
    global $activeVector, $out, $log, $transactions, $maskSeqs, $db, $writeVectors;
    $activeVector = $name;
    $log = [];
    $transactions = [];
    $maskSeqs = [];
    $res = executeVector(
        $name,
        $fn,
        isset($writeVectors[$name]) ? static fn(callable $task): mixed => $db->transaction($task, retry: 0) : null
    );
    $out[$name] = ['statements' => $log, 'result' => $res];
}
