<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CodecYamlProbe
{
    /** @return array<string, mixed> */
    public static function run(string $operation, string $failure, ?string $extension = null): array
    {
        $command = [PHP_BINARY];
        if ($extension !== null) {
            array_push($command, '-d', "extension=$extension");
        }
        array_push(
            $command,
            __DIR__ . '/codec-yaml-probe.php',
            $operation,
            $failure,
            $extension === null ? 'library' : 'native'
        );
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
