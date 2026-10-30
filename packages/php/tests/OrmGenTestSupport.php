<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** Shared filesystem and command support for the PHP orm-gen tests. */
final class OrmGenTestSupport
{
    /** @param list<string> $imports */
    public static function phpSource(array $imports, string $body, ?string $namespace = null): string
    {
        $source = "<?php\n";
        if ($namespace !== null) {
            $source .= "namespace $namespace;\n\n";
        }
        if ($imports !== []) {
            $source .= 'use ' . implode(";\nuse ", $imports) . ";\n\n";
        }
        return $source . $body;
    }

    /** @param list<string> $imports */
    public static function phpModelSource(
        string $model,
        string $variable,
        array $imports,
        string $body,
        ?string $namespace = null
    ): string {
        return self::phpSource($imports, "\$$variable = new $model();\n$body", $namespace);
    }

    public static function phpRelationCall(
        string $receiver,
        string $method,
        string $related,
        string $chain,
        ?string $terminal
    ): string {
        return "$receiver->$method((new $related())->$chain)" . ($terminal === null ? '' : "->$terminal()") . ';';
    }

    public static function phpTryCatch(string $tryBody, string $catchBody): string
    {
        return "    try {\n        $tryBody\n    } catch (\\Exception \$e) {\n        $catchBody\n    }\n";
    }

    /** @param \PHPUnit\Framework\TestCase $test */
    public static function assertGeneratedTypedGetter(
        \PHPUnit\Framework\TestCase $test,
        object $model,
        string $getter,
        string $setter,
        string $expectedCode
    ): void {
        try {
            $model->$getter();
            $test::fail('An unselected generated column must fail.');
        } catch (\Polyspec\Orm\OrmException $error) {
            $test::assertSame($expectedCode, $error->code_);
        }
        $test::assertSame($model, $model->$setter(17));
        $test::assertSame(17, $model->$getter());
        set_error_handler(static fn(int $severity, string $message): never => throw new \ErrorException($message));
        try {
            try {
                $model->values;
                $test::fail('Generated consumers must not access private model storage.');
            } catch (\ErrorException $error) {
                $test::assertStringContainsString('undefined property', strtolower($error->getMessage()));
            }
        } finally {
            restore_error_handler();
        }
    }

    /** Builds the identical literal PHP scan fixture, with either a use import or a fully qualified model name. */
    public static function phpScanFixture(string $model, string $calls, ?string $import = null): string
    {
        return self::phpSource($import === null ? [] : [$import], "\$db = null;\n\$m = new $model();\n$calls");
    }

    /** @return list<string> */
    public static function phpMethodNames(string $path): array
    {
        preg_match_all('/^ \* @method \\S+ (\\w+)\\(/m', (string) file_get_contents($path), $matches);
        return $matches[1];
    }

    /** @return array<string, array{array<string, mixed>}> the cases of tests/generator/php-scan-vectors.json by id */
    public static function phpScanVectorCases(): array
    {
        return self::scanVectorCases(false);
    }

    /** @return array<string, array{array<string, mixed>}> the scan vector cases that the node scan shares */
    public static function phpScanParityVectorCases(): array
    {
        return self::scanVectorCases(true);
    }

    /**
     * The cases of tests/generator/php-scan-vectors.json as PHPUnit data sets keyed by case id; with
     * `$parityOnly`, only the cases that the node scan shares (parity is not false). A data provider takes no
     * argument, hence the two entries above.
     *
     * @return array<string, array{array<string, mixed>}>
     */
    private static function scanVectorCases(bool $parityOnly): array
    {
        $file = dirname(__DIR__, 3) . '/tests/generator/php-scan-vectors.json';
        $cases = [];
        foreach (json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR)['cases'] as $case) {
            if (!$parityOnly || ($case['parity'] ?? true) === true) {
                $cases[$case['id']] = [$case];
            }
        }
        return $cases;
    }

    public static function createWorkDirectory(string $prefix): string
    {
        $path = sys_get_temp_dir() . '/' . $prefix . getmypid();
        is_dir($path) || mkdir($path, 0o700, true);
        return $path;
    }

    public static function removeWorkDirectory(string $path): void
    {
        exec('rm -rf ' . escapeshellarg($path));
    }

    /** @param list<string> $documents @param list<string>|null $external */
    public static function setFile(string $dir, array $documents, ?array $external = []): string
    {
        is_dir($dir) || mkdir($dir, 0o700, true);
        $definition = ['schema' => 1, 'documents' => $documents];
        if ($external !== null) {
            $definition['external'] = $external;
        }
        $path = "$dir/dbspec-set.json";
        file_put_contents($path, json_encode($definition, JSON_UNESCAPED_SLASHES));
        return $path;
    }

    /** The typed.dbs document whose item columns cover each PHP field type of a generated model. */
    public const FIELD_TYPES_DOCUMENT = "dbspec 1 typed\n\ntable item {\n  seq i64 identity\n  ratio f64\n"
        . "  enabled bool\n  body text\n  payload bytes null\n  moment datetime(3) null\n  json_value text null\n"
        . "  primary key (seq)\n  settings {\n    codec json_value ordered_json\n  }\n}\n";

    /**
     * Generates the PHP model of the document $document, saved as typed.dbs of a set in $dir, into $dir/model under
     * $namespace and loads its class Item, whose name it returns; a failed generation throws with its output.
     */
    public static function generateItemModel(string $dir, string $namespace, string $document): string
    {
        $set = self::setFile($dir, ['typed.dbs']);
        file_put_contents("$dir/typed.dbs", $document);
        [$code, $output, $message] = self::run(
            ['gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace]
        );
        if ($code !== 0) {
            throw new \RuntimeException("orm-gen exited with $code: $output $message");
        }
        require_once "$dir/model/Item.php";
        return "$namespace\\Item";
    }

    /** The getters and setters of the Item model of FIELD_TYPES_DOCUMENT declare the PHP type of each column. */
    public static function assertGeneratedFieldTypes(\PHPUnit\Framework\TestCase $test, string $class): void
    {
        $getters = [
            'getRatio' => 'float',
            'getEnabled' => 'bool',
            'getBody' => 'string',
            'getPayload' => '?string',
            'getMoment' => '?DateTimeImmutable',
            'getJsonValue' => 'Polyspec\\Orm\\StyledValue',
        ];
        foreach ($getters as $method => $expected) {
            $type = (string) (new \ReflectionMethod($class, $method))->getReturnType();
            $test::assertSame($expected, $type, "$class::$method");
        }
        $setters = [
            'setRatio' => 'float',
            'setEnabled' => 'bool',
            'setBody' => 'string',
            'setPayload' => '?string',
            'setMoment' => '?string',
            'setJsonValue' => 'Polyspec\\Orm\\StyledValue',
        ];
        foreach ($setters as $method => $expected) {
            $type = (string) (new \ReflectionMethod($class, $method))->getParameters()[0]->getType();
            $test::assertSame($expected, $type, "$class::$method");
        }
    }

    /** @param list<string> $command @return array{int, string, string}|null */
    public static function runProcess(array $command, ?string $cwd = null): ?array
    {
        $command = self::nativePhpCommand($command);
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd);
        if (!is_resource($process)) {
            return null;
        }
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $out, $err];
    }

    /**
     * A PHP child of an extension run inherits the PHP_INI_SCAN_DIR through which run-tests of kit loads the
     * extension (kit K900), so the command names no extension; it passes on only the auto_prepend_file of this
     * process.
     *
     * @param list<string> $command @return list<string>
     */
    private static function nativePhpCommand(array $command): array
    {
        if (
            getenv('ORM_PHP_MODE') !== 'extension'
            || ($command[0] ?? null) !== PHP_BINARY
        ) {
            return $command;
        }

        $prefix = [];
        $prepend = ini_get('auto_prepend_file');
        if (is_string($prepend) && $prepend !== '') {
            array_push($prefix, '-d', "auto_prepend_file=$prepend");
        }
        return [$command[0], ...$prefix, ...array_slice($command, 1)];
    }

    /** @param list<string> $args @return array{int, string, string} */
    public static function run(array $args): array
    {
        $root = dirname(__DIR__, 3);
        $result = self::runProcess([PHP_BINARY, "$root/vendor-php/bin/orm-gen", ...$args]);
        if ($result === null) {
            throw new \RuntimeException('cannot start orm-gen');
        }
        return $result;
    }
}
