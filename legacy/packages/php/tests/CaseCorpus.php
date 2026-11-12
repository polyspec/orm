<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;

/** A new corpus of a dbspec set for one recipe case, served by the flowmark of FLOWMARK (docs/spec/feature-coverage.md FCV-3). */
final class CaseCorpus
{
    public const NAME = 'recipe';

    private const LISTENING = '/^\[serve\] listening on 127\.0\.0\.1:([0-9]+) for the corpus (.+)$/';

    /**
     * Runs body with the markdown DSN of a new corpus of the dbspec set at $setPath, or of a corpus of no table when
     * $setPath is null (a recipe of no fixture, or a case whose steps install it), and with the directory of the
     * corpus; the server stops and the corpus is removed when body ends.
     *
     * @param \Closure(string, string): void $body
     */
    public static function with(?string $setPath, \Closure $body): void
    {
        $binary = (string) getenv('FLOWMARK');
        if ($binary === '') {
            Assert::fail(
                'FLOWMARK is required; make orm-install-flowmark builds the version that '
                . 'tests/markdown/flowmark.version pins',
            );
        }
        $parent = sys_get_temp_dir() . '/orm-corpus-' . bin2hex(random_bytes(8));
        $directory = $parent . '/' . self::NAME;
        $server = null;
        try {
            mkdir($directory . '/dbspec', 0o755, true);
            if ($setPath !== null) {
                self::copySet($setPath, $directory . '/dbspec');
            }
            self::install($binary, $directory);
            // A corpus of a test is disposable, as a test database server is: a commit does not wait for the disk.
            $server = proc_open(
                [$binary, 'serve', $directory, '--port', '0', '--synchronous', 'off', '--tx-idle-ms', '600000'],
                [1 => ['pipe', 'w']],
                $pipes
            );
            if (!is_resource($server)) {
                Assert::fail('flowmark serve did not start');
            }
            $line = rtrim((string) fgets($pipes[1]), "\n");
            if (preg_match(self::LISTENING, $line, $match) !== 1 || $match[2] !== self::NAME) {
                Assert::fail("flowmark serve printed \"$line\", not its listening line");
            }
            $text = (string) file_get_contents($directory . '/.flowmark/server.json');
            $file = json_decode($text, true, 8, JSON_THROW_ON_ERROR);
            $body('markdown://127.0.0.1:' . $match[1] . '/' . self::NAME . '?token=' . $file['token'], $directory);
        } finally {
            if (is_resource($server)) {
                proc_terminate($server, 2);
                proc_close($server);
            }
            // A case may have made the corpus one that the process may only read (database.read_only).
            if (is_dir($directory)) {
                self::chmodTree($directory, false);
            }
            self::remove($parent);
        }
    }

    /** Makes the directories of the corpus at $root ones the process may only read, or writable again. */
    public static function chmodTree(string $root, bool $readOnly): void
    {
        Assert::assertTrue(chmod($root, $readOnly ? 0o555 : 0o755), "chmod $root");
        foreach ((array) scandir($root) as $entry) {
            if ($entry !== '.' && $entry !== '..' && is_dir("$root/$entry") && !is_link("$root/$entry")) {
                self::chmodTree("$root/$entry", $readOnly);
            }
        }
    }

    /** Copies the set file at $setPath and its owned and external documents into $into. */
    private static function copySet(string $setPath, string $into): void
    {
        $text = (string) file_get_contents($setPath);
        file_put_contents($into . '/' . basename($setPath), $text);
        $set = json_decode($text, true, 8, JSON_THROW_ON_ERROR);
        foreach ([...$set['documents'], ...($set['external'] ?? [])] as $document) {
            copy(dirname($setPath) . '/' . $document, $into . '/' . $document);
        }
    }

    private static function install(string $binary, string $directory): void
    {
        $process = proc_open([$binary, 'install', $directory], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            Assert::fail('flowmark install did not start');
        }
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        if (proc_close($process) !== 0) {
            Assert::fail("flowmark install: $output");
        }
    }

    private static function remove(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        foreach ((array) scandir($path) as $entry) {
            if ($entry !== '.' && $entry !== '..') {
                self::remove($path . '/' . $entry);
            }
        }
        rmdir($path);
    }
}
