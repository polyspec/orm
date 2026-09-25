<?php
declare(strict_types=1);

namespace Orm;

/**
 * The orm-gen commands: model generation and the schema tools.
 *
 *   orm-gen gen      --schema schema.json --out <dir> --namespace <Php\Namespace> [--check]
 *   orm-gen build    <files.mmd...> --out schema.json [--check]
 *   orm-gen ddl      --schema <source> --dialect mysql|postgres|sqlite --out <file.sql>
 *   orm-gen diff     --from <source> --to <source> --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]
 *   orm-gen validate --dsn <dsn> --schema <source>
 *   orm-gen migrate  --dsn <dsn> --schema <source> [--migration-id id] [--name text] [--log-dir dir] [--dry-run]
 *   orm-gen import   --dsn <dsn> --out schema/app.mmd [--tables a,b]
 *
 * A source is a .mmd, schema.json, or generated .sql file, or db:<dsn>. A DSN
 * is a mysql://, postgres://, or sqlite:// URI.
 */
final class SchemaTool
{
    private const USAGE = [
        'gen' => 'orm-gen gen --schema schema.json --out <dir> --namespace <Php\\Namespace> [--check]',
        'build' => 'orm-gen build <files.mmd...> --out schema/schema.json [--check]',
        'ddl' => 'orm-gen ddl --schema <source> --dialect mysql|postgres|sqlite --out <file.sql>',
        'diff' => 'orm-gen diff --from <source> --to <source> --dialect mysql|postgres|sqlite --out <file.sql> [--allow-destructive]',
        'validate' => 'orm-gen validate --dsn <dsn> --schema <source>',
        'migrate' => 'orm-gen migrate --dsn <dsn> --schema <source> [--migration-id id] [--name text] [--log-dir dir] [--dry-run]',
        'import' => 'orm-gen import --dsn <dsn> --out schema/app.mmd [--tables a,b]',
    ];

    /** @var resource */
    private static $stderr;

    /** @param list<string> $args the arguments after the program name */
    public static function main(array $args): int
    {
        return self::run($args, STDERR);
    }

    /**
     * Runs one command and returns its exit status; messages go to $stderr.
     * @param list<string> $args
     * @param resource $stderr
     */
    public static function run(array $args, $stderr): int
    {
        self::$stderr = $stderr;
        $command = $args[0] ?? '';
        if (!isset(self::USAGE[$command])) {
            return self::usage();
        }
        $rest = array_slice($args, 1);
        try {
            return match ($command) {
                'gen' => self::gen($rest),
                'build' => self::build($rest),
                'ddl' => self::ddl($rest),
                'diff' => self::diff($rest),
                'validate' => self::validate($rest),
                'migrate' => self::migrate($rest),
                'import' => self::import($rest),
            };
        } catch (UsageError $e) {
            if ($e->getMessage() !== '') {
                fwrite(self::$stderr, $e->getMessage() . "\n");
            }
            fwrite(self::$stderr, 'usage: ' . self::USAGE[$command] . "\n");
            return 2;
        } catch (\RuntimeException|\InvalidArgumentException|OrmException|\PDOException $e) {
            fwrite(self::$stderr, 'orm-gen: ' . $e->getMessage() . "\n");
            return 1;
        }
    }

    private static function usage(): int
    {
        foreach (array_values(self::USAGE) as $i => $line) {
            fwrite(self::$stderr, ($i === 0 ? 'usage: ' : '       ') . $line . "\n");
        }
        fwrite(self::$stderr, "       source: schema.mmd | schema.json | ormgen.sql | db:<dsn>\n");
        return 2;
    }

    /**
     * Parses `-name value`, `--name value`, `--name=value`, and boolean
     * `--name` flags; with $anywhere, other arguments may appear between flags.
     * @param array<string, string|bool> $spec flag name → default (bool for switches)
     * @return array{array<string, string|bool>, list<string>}
     */
    private static function flags(array $args, array $spec, bool $anywhere = false): array
    {
        $values = $spec;
        $positional = [];
        for ($i = 0; $i < count($args); $i++) {
            $a = $args[$i];
            if ($a === '--') {
                array_push($positional, ...array_slice($args, $i + 1));
                break;
            }
            if ($a === '' || $a[0] !== '-' || $a === '-') {
                if (!$anywhere) {
                    array_push($positional, ...array_slice($args, $i));
                    break;
                }
                $positional[] = $a;
                continue;
            }
            $name = ltrim($a, '-');
            $value = null;
            if (str_contains($name, '=')) {
                [$name, $value] = explode('=', $name, 2);
            }
            if (!array_key_exists($name, $spec)) {
                throw new UsageError("flag provided but not defined: -$name");
            }
            if (is_bool($spec[$name])) {
                $values[$name] = $value === null ? true : in_array(strtolower($value), ['1', 't', 'true'], true);
                continue;
            }
            if ($value === null) {
                if ($i + 1 >= count($args)) {
                    throw new UsageError("flag needs an argument: -$name");
                }
                $value = $args[++$i];
            }
            $values[$name] = $value;
        }
        return [$values, $positional];
    }

    /** Resolves a schema source without changing it; a db: source must use the dialect. */
    public static function source(string $source, string $dialect): array
    {
        if (str_starts_with($source, 'db:')) {
            $dsn = substr($source, 3);
            if ($dsn === '') {
                throw new \RuntimeException('MIGRATION_SOURCE: db: requires a DSN');
            }
            $actual = SchemaImport::dialect($dsn);
            if ($actual !== $dialect) {
                throw new \RuntimeException('MIGRATION_CONFIG: db source ' . SchemaImport::redact($dsn) . " is $actual, not $dialect");
            }
            [, $db] = SchemaImport::connect($dsn);
            try {
                return SchemaImport::liveManifest($db, $actual);
            } catch (\Throwable $e) {
                throw new \RuntimeException("MIGRATION_INTROSPECT: driver=$actual dsn=" . SchemaImport::redact($dsn) . ': ' . $e->getMessage());
            }
        }
        $b = @file_get_contents($source);
        if ($b === false) {
            throw new \RuntimeException("read $source: " . self::lastError());
        }
        $kind = match (strtolower(pathinfo($source, PATHINFO_EXTENSION))) {
            'mmd', 'mermaid' => 'mmd',
            'json' => 'json',
            'sql' => 'sql',
            default => match (true) {
                str_starts_with(SchemaParser::trim($b), 'erDiagram') => 'mmd',
                str_starts_with(SchemaParser::trim($b), '{') => 'json',
                str_contains($b, SchemaDdl::METADATA_PREFIX) => 'sql',
                default => throw new \RuntimeException("MIGRATION_SOURCE: $source: cannot detect mmd, json, or ormgen sql"),
            },
        };
        switch ($kind) {
            case 'mmd':
                try {
                    return SchemaBuilder::build([SchemaParser::parse($b)]);
                } catch (SchemaError $e) {
                    throw new \RuntimeException("$source: " . $e->getMessage());
                }
            case 'json':
                return SchemaBuilder::load($b);
            default:
                return SchemaDdl::embedded($b, $source)
                    ?? throw new \RuntimeException("MIGRATION_SOURCE_LOSS: $source has no orm-schema-v1 metadata; SQL cannot represent codec styles or relation options");
        }
    }

    private static function lastError(): string
    {
        return preg_replace('/^[a-z_]+\(.*?\): /', '', error_get_last()['message'] ?? 'failed') ?? 'failed';
    }

    private static function write(string $path, string $text): void
    {
        if (@file_put_contents($path, $text) === false) {
            throw new \RuntimeException("write $path: " . self::lastError());
        }
    }

    private static function gen(array $args): int
    {
        [$o] = self::flags($args, ['schema' => '', 'out' => '', 'namespace' => '', 'check' => false]);
        if ($o['schema'] === '' || $o['out'] === '' || preg_match('/^[A-Za-z_][A-Za-z0-9_]*(\\\\[A-Za-z_][A-Za-z0-9_]*)*$/', $o['namespace']) !== 1) {
            throw new UsageError('');
        }
        $manifest = Manifest::file($o['schema']);
        if ($o['check']) {
            return self::report(Generator::check($manifest, $o['out'], $o['namespace']));
        }
        Generator::generate($manifest, $o['out'], $o['namespace']);
        printf("orm-gen: %d entities → %s\n", count($manifest->order), $o['out']);
        return 0;
    }

    private static function build(array $args): int
    {
        [$o, $patterns] = self::flags($args, ['out' => '', 'check' => false], true);
        if ($o['out'] === '' || $patterns === []) {
            throw new UsageError('');
        }
        $files = [];
        foreach ($patterns as $pattern) {
            $matches = glob($pattern) ?: [];
            if ($matches === []) {
                throw new \RuntimeException("no such file: $pattern");
            }
            array_push($files, ...$matches);
        }
        sort($files, SORT_STRING);
        $diagrams = [];
        foreach ($files as $file) {
            $src = @file_get_contents($file);
            if ($src === false) {
                throw new \RuntimeException(self::lastError());
            }
            try {
                $diagrams[] = SchemaParser::parse($src);
            } catch (SchemaError $e) {
                fwrite(self::$stderr, "$file:" . $e->getMessage() . "\n");
                return 1;
            }
        }
        try {
            $m = SchemaBuilder::build($diagrams);
        } catch (SchemaError $e) {
            throw new \RuntimeException($e->getMessage());
        }
        foreach (SchemaBuilder::warnings($m) as $warning) {
            fwrite(self::$stderr, "warning: $warning\n");
        }
        $json = SchemaBuilder::json($m);
        if ($o['check']) {
            $current = is_file($o['out']) ? @file_get_contents($o['out']) : null;
            if ($current === false) {
                throw new \RuntimeException("read {$o['out']}: " . self::lastError());
            }
            return self::report(match ($current) {
                null => ["missing: {$o['out']}"],
                $json => [],
                default => ["differs: {$o['out']}"],
            });
        }
        self::write($o['out'], $json);
        printf("orm-gen: %d entities → %s (schema_hash %s)\n", count($m['order']), $o['out'], $m['schema_hash']);
        return 0;
    }

    /**
     * Prints the lines of a check and returns exit status 1 when there is a line.
     * @param list<string> $lines
     */
    private static function report(array $lines): int
    {
        foreach ($lines as $line) {
            echo "$line\n";
        }
        return $lines === [] ? 0 : 1;
    }

    private static function ddl(array $args): int
    {
        [$o] = self::flags($args, ['schema' => '', 'dialect' => 'mysql', 'out' => '']);
        if ($o['schema'] === '' || $o['out'] === '') {
            throw new UsageError('');
        }
        $m = self::source($o['schema'], $o['dialect']);
        self::write($o['out'], SchemaDdl::render($m, $o['dialect']));
        fwrite(self::$stderr, sprintf("orm-gen: %d tables (%s) → %s\n", count($m['order']), $o['dialect'], $o['out']));
        return 0;
    }

    private static function diff(array $args): int
    {
        [$o] = self::flags($args, ['from' => '', 'to' => '', 'dialect' => 'mysql', 'out' => '', 'allow-destructive' => false]);
        if ($o['from'] === '' || $o['to'] === '' || $o['out'] === '') {
            throw new UsageError('');
        }
        $from = self::source($o['from'], $o['dialect']);
        $to = self::source($o['to'], $o['dialect']);
        SchemaChecks::alignSources($o['from'], $o['to'], $from, $to);
        self::write($o['out'], SchemaDiff::render($from, $to, $o['dialect'], $o['allow-destructive']));
        return 0;
    }

    private static function validate(array $args): int
    {
        [$o] = self::flags($args, ['dsn' => '', 'schema' => '']);
        if ($o['dsn'] === '' || $o['schema'] === '') {
            throw new UsageError('');
        }
        [$driver, $db] = SchemaImport::connect($o['dsn']);
        $m = self::source($o['schema'], $driver);
        $live = SchemaImport::managed(SchemaImport::readTables($db, $driver));
        try {
            $diagram = SchemaParser::parse(SchemaImport::renderMermaid($live, null));
        } catch (SchemaError $e) {
            throw new \RuntimeException('live schema does not parse: ' . $e->getMessage());
        }
        try {
            $lm = SchemaBuilder::build([$diagram]);
        } catch (SchemaError $e) {
            throw new \RuntimeException('live schema does not build: ' . $e->getMessage());
        }
        $diffs = SchemaImport::differences($m, $lm, $driver);
        foreach ($diffs as $d) {
            echo $d, "\n";
        }
        if ($diffs !== []) {
            fwrite(self::$stderr, sprintf("orm-gen: %d differences between %s and the live database\n", count($diffs), $o['schema']));
            return 1;
        }
        fwrite(self::$stderr, sprintf("orm-gen: %s matches the live database (%d entities)\n", $o['schema'], count($m['order'])));
        return 0;
    }

    private static function migrate(array $args): int
    {
        [$o] = self::flags($args, ['dsn' => '', 'schema' => '', 'migration-id' => 'initial', 'name' => 'schema sync', 'log-dir' => 'migrations/logs', 'dry-run' => false]);
        if ($o['dsn'] === '' || $o['schema'] === '') {
            throw new \RuntimeException('MIGRATION_CONFIG: --dsn and --schema are required');
        }
        [$driver, $db] = SchemaImport::connect($o['dsn']);
        try {
            $want = self::source($o['schema'], $driver);
        } catch (\RuntimeException|\InvalidArgumentException $e) {
            throw new \RuntimeException('MIGRATION_SOURCE: ' . $e->getMessage());
        }
        echo SchemaMigrate::run($db, $driver, $want, [
            'migration_id' => $o['migration-id'], 'name' => $o['name'], 'log_dir' => $o['log-dir'], 'dry_run' => $o['dry-run'],
        ]);
        return 0;
    }

    private static function import(array $args): int
    {
        [$o] = self::flags($args, ['dsn' => '', 'out' => '', 'tables' => '']);
        if ($o['dsn'] === '' || $o['out'] === '') {
            throw new UsageError('');
        }
        [$driver, $db] = SchemaImport::connect($o['dsn']);
        $only = null;
        if ($o['tables'] !== '') {
            $only = [];
            foreach (explode(',', $o['tables']) as $t) {
                $only[SchemaParser::trim($t)] = true;
            }
        }
        $tables = SchemaImport::readTables($db, $driver, $only);
        $prev = null;
        if (is_file($o['out'])) {
            try {
                $prev = SchemaParser::parse((string) file_get_contents($o['out']));
            } catch (SchemaError $e) {
                throw new \RuntimeException("{$o['out']}: " . $e->getMessage() . ' (fix or remove it before importing over it)');
            }
        }
        $text = SchemaImport::withTriggerDirectives($db, $driver, $tables, SchemaImport::renderMermaid($tables, $prev));
        self::write($o['out'], $text);
        try {
            SchemaParser::parse($text);
        } catch (SchemaError $e) {
            throw new \RuntimeException('imported diagram does not parse: ' . $e->getMessage());
        }
        fwrite(self::$stderr, sprintf("orm-gen: %d tables → %s\n", count($tables), $o['out']));
        return 0;
    }
}
