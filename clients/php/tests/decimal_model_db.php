<?php
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use Orm\Code;
use Orm\Config;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;

if ($argc !== 3 || $argv[1] !== '--dialect' || !in_array($argv[2], ['mysql', 'postgres', 'sqlite'], true)) {
    throw new RuntimeException('usage: decimal_model_db.php --dialect mysql|postgres|sqlite');
}
$dialect = $argv[2];
$env = 'DECIMAL_' . strtoupper($dialect) . '_DSN';
$dsn = getenv($env);
if (!is_string($dsn) || $dsn === '') {
    throw new RuntimeException("$env is required");
}
$model = RuntimeModel::build(RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/decimal_schema.dbs']));
$generated = sys_get_temp_dir() . '/orm-decimal-php-' . bin2hex(random_bytes(8));
Generator::generate($model, $generated, 'DecimalFixture');
spl_autoload_register(static function (string $class) use ($generated): void {
    if (str_starts_with($class, 'DecimalFixture\\')) {
        require $generated . '/' . substr($class, strlen('DecimalFixture\\')) . '.php';
    }
});
require $generated . '/bootstrap.php';

try {
    $class = DecimalFixture\DecimalCase::class;
    $getAmount = (new ReflectionMethod($class, 'getAmount'))->getReturnType();
    $setAmount = (new ReflectionMethod($class, 'setAmount'))->getParameters()[0]->getType();
    if (!$getAmount instanceof ReflectionNamedType || !$setAmount instanceof ReflectionNamedType || $getAmount->getName() !== 'string' || $setAmount->getName() !== 'string') {
        throw new RuntimeException('generated decimal getter and setter must use exact string values');
    }
    foreach (['1.00001', '1000000000.0000', 'NaN'] as $invalid) {
        try {
            (new $class)->setAmount($invalid);
            throw new RuntimeException("invalid decimal $invalid was accepted");
        } catch (OrmException $error) {
            if ($error->code_ !== Code::CODEC_ENCODE) {
                throw new RuntimeException("invalid decimal $invalid returned {$error->code_}", 0, $error);
            }
        }
    }
    try {
        (new $class)->setAmount(48.045);
        throw new RuntimeException('binary64 decimal input was accepted');
    } catch (TypeError $error) {
        // The generated setter accepts an exact string.
    }
    try {
        (new $class)->setLargeValue(9007199254740992);
        throw new RuntimeException('binary64 large decimal input was accepted');
    } catch (TypeError $error) {
        // The generated setter accepts an exact string.
    }

    $db = Orm::connect($dsn, new Config());
    try {
        if ((new $class)->connect($db)->seq(1)->getCount() !== 0) {
            throw new RuntimeException('decimal fixture row 1 exists before the test');
        }
        $rollback = new RuntimeException('decimal fixture rollback');
        try {
            $db->transaction(static function () use ($class, $db, $dialect, $rollback): void {
                (new $class)->setSeq(1)->setAmount('48.0450')->setLargeValue('9007199254740993')->create();
                $loaded = (new $class)->seq(1)->get();
                if ($loaded->getAmount() !== '48.0450' || $loaded->getLargeValue() !== '9007199254740993') {
                    throw new RuntimeException('generated decimal fields lost exact values');
                }
                $array = $loaded->toArray();
                if ($array['amount'] !== '48.0450' || $array['large_value'] !== '9007199254740993') {
                    throw new RuntimeException('decimal row output lost exact values');
                }
                $query = $db->pdo()->prepare('SELECT amount, large_value FROM decimal_case WHERE seq = ?');
                $query->execute([1]);
                $stored = $query->fetch(PDO::FETCH_NUM);
                if ($stored === false || (string) $stored[0] !== ($dialect === 'sqlite' ? '480450' : '48.0450') || (string) $stored[1] !== '9007199254740993') {
                    throw new RuntimeException('database decimal storage lost exact values');
                }
                throw $rollback;
            }, retry: 0);
            throw new RuntimeException('decimal transaction unexpectedly committed');
        } catch (RuntimeException $error) {
            if ($error !== $rollback) {
                throw $error;
            }
        }
        if ((new $class)->connect($db)->seq(1)->getCount() !== 0) {
            throw new RuntimeException('decimal fixture row remains after rollback');
        }
    } finally {
        $db->close();
    }
    echo "CASE decimal_$dialect PASS\n";
} finally {
    $files = glob($generated . '/*.php');
    if ($files === false) {
        throw new RuntimeException("cannot list generated model directory $generated");
    }
    foreach ($files as $file) {
        if (!unlink($file)) {
            throw new RuntimeException("cannot remove generated model $file");
        }
    }
    if (!rmdir($generated)) {
        throw new RuntimeException("cannot remove generated model directory $generated");
    }
}
