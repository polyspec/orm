<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CodecYamlProbe
{
    /**
     * Runs the probe in a PHP child. A native child of an extension run inherits the PHP_INI_SCAN_DIR through which
     * run-tests of kit loads the extension (kit K900), so the command names no extension, which would load it twice;
     * the child reports whether Codec is the internal class of the extension.
     *
     * @return array<string, mixed>
     */
    public static function run(string $operation, string $failure, bool $native = false): array
    {
        $mode = $native ? 'native' : 'library';
        $command = [PHP_BINARY, __DIR__ . '/codec-yaml-probe.php', $operation, $failure, $mode];
        $pipes = [];
        $process = proc_open(
            $command,
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            dirname(__DIR__, 3),
            null,
            ['bypass_shell' => true]
        );
        if (!is_resource($process)) {
            throw new \RuntimeException('the isolated YAML probe failed to start');
        }
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $status = proc_close($process);
        if ($status !== 0) {
            throw new \RuntimeException("the isolated YAML probe failed ($status):\n$stderr\n$stdout");
        }
        return json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
    }
}
