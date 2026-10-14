<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The orm-gen command line: model generation from a dbspec document set.
 *
 *   orm-gen gen --set <dbspec-set.json> --out <dir> --namespace <Php\Namespace> [--scan <file or directory>]... [--check]
 *
 * `--scan` names a PHP file or directory, and may repeat: the chain methods it calls on the models are declared as @method
 * tags (docs/dsl.md). `--set` names the set file (docs/dbspec.md "Document sets"): its `documents` get models, and its
 * `external` documents are parsed with the set and get none.
 */
final class OrmGen
{
    private const USAGE = [
        'gen' => 'orm-gen gen --set <dbspec-set.json> --out <dir> --namespace <Php\\Namespace> [--scan <file or directory>]... [--check]',
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
            };
        } catch (UsageError $e) {
            if ($e->getMessage() !== '') {
                fwrite(self::$stderr, $e->getMessage() . "\n");
            }
            fwrite(self::$stderr, 'usage: ' . self::USAGE[$command] . "\n");
            return 2;
        } catch (\RuntimeException|\InvalidArgumentException|OrmException $e) {
            fwrite(self::$stderr, 'orm-gen: ' . $e->getMessage() . "\n");
            return 1;
        }
    }

    private static function usage(): int
    {
        foreach (array_values(self::USAGE) as $i => $line) {
            fwrite(self::$stderr, ($i === 0 ? 'usage: ' : '       ') . $line . "\n");
        }
        return 2;
    }

    /**
     * Parses `-name value`, `--name value`, `--name=value`, and boolean
     * `--name` flags up to the first other argument, which starts the positional arguments.
     * @param array<string, string|bool|list<string>> $spec flag name → default (bool for switches, an array for a flag that repeats)
     * @return array{array<string, string|bool|list<string>>, list<string>}
     */
    private static function flags(array $args, array $spec): array
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
                array_push($positional, ...array_slice($args, $i));
                break;
            }
            $name = ltrim($a, '-');
            $value = null;
            if (str_contains($name, '=')) {
                [$name, $value] = explode('=', $name, 2);
            }
            if (!array_key_exists($name, $spec)) {
                throw new UsageError("flag provided but not defined: -$name");
            }
            if (is_array($spec[$name])) {
                if ($value === null) {
                    if ($i + 1 >= count($args)) {
                        throw new UsageError("flag needs an argument: -$name");
                    }
                    $value = $args[++$i];
                }
                $values[$name][] = $value;
                continue;
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

    private static function gen(array $args): int
    {
        [$o, $rest] = self::flags($args, ['set' => '', 'out' => '', 'namespace' => '', 'scan' => [], 'check' => false]);
        if ($rest !== [] || $o['set'] === '' || $o['out'] === '' || preg_match('/^[A-Za-z_][A-Za-z0-9_]*(\\\\[A-Za-z_][A-Za-z0-9_]*)*$/', $o['namespace']) !== 1) {
            throw new UsageError($rest === [] ? '' : 'unexpected argument: ' . $rest[0]);
        }
        $model = RuntimeModel::build(RuntimeModel::set($o['set']));
        if ($o['check']) {
            return self::report(Generator::check($model, $o['out'], $o['namespace'], $o['scan']));
        }
        Generator::generate($model, $o['out'], $o['namespace'], $o['scan']);
        printf("orm-gen: %d entities → %s (%s)\n", count($model->entities), $o['out'], $model->manifestHash);
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
}
