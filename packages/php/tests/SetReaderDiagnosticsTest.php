<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\SetReader;

#[Small]
final class SetReaderDiagnosticsTest extends TestCase
{
    private const SCHEME = 'setdiag';
    private const SET = 'setdiag://root/dbspec-set.json';
    private bool $registered = false;
    private bool $hadFixture = false;
    private mixed $previousFixture = null;

    protected function setUp(): void
    {
        $this->hadFixture = array_key_exists('setReaderDiagnostics', $GLOBALS);
        $this->previousFixture = $GLOBALS['setReaderDiagnostics'] ?? null;
        $GLOBALS['setReaderDiagnostics'] = [
            'content' => '{"schema":1,"documents":["shop.dbs"]}',
            'entries' => ['.', '..', 'dbspec-set.json', 'shop.dbs'],
            'directories' => [],
            'failStat' => [],
            'failListing' => [],
            'links' => [],
            'listingCalls' => [],
        ];
        $wrapper = new class {
            public mixed $context;
            private string $content = '';
            private int $offset = 0;
            private int $directoryOffset = 0;

            public function url_stat(string $path, int $flags): array|false
            {
                $fixture =& $GLOBALS['setReaderDiagnostics'];
                if (isset($fixture['failStat'][$path]) && (!$fixture['failStat'][$path]['followOnly']
                    || ($flags & STREAM_URL_STAT_LINK) === 0)) {
                    return false;
                }
                $mode = isset($fixture['links'][$path]) && ($flags & STREAM_URL_STAT_LINK) !== 0
                    ? 0120000
                    : (isset($fixture['directories'][$path]) || in_array($path, [
                        'setdiag://root', 'setdiag://root/', 'setdiag://root/sub',
                    ], true) ? 0040000 : 0100000);
                $stat = stat(__FILE__);
                $stat['dev'] = $stat[0] = 1;
                $stat['ino'] = $stat[1] = crc32($path);
                $stat['mode'] = $stat[2] = $mode | 0644;
                return $stat;
            }

            public function dir_opendir(string $path, int $options): bool
            {
                $fixture =& $GLOBALS['setReaderDiagnostics'];
                $fixture['listingCalls'][$path] = ($fixture['listingCalls'][$path] ?? 0) + 1;
                if (isset($fixture['failListing'][$path])) {
                    return false;
                }
                $this->directoryOffset = 0;
                return true;
            }

            public function dir_readdir(): string|false
            {
                $entries = $GLOBALS['setReaderDiagnostics']['entries'];
                return $entries[$this->directoryOffset++] ?? false;
            }

            public function dir_closedir(): bool
            {
                return true;
            }

            public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
            {
                $this->content = $GLOBALS['setReaderDiagnostics']['content'];
                $this->offset = 0;
                return true;
            }

            public function stream_read(int $count): string
            {
                $bytes = substr($this->content, $this->offset, $count);
                $this->offset += strlen($bytes);
                return $bytes;
            }

            public function stream_eof(): bool
            {
                return $this->offset >= strlen($this->content);
            }

            public function stream_stat(): array|false
            {
                return stat(__FILE__);
            }
        };
        $this->registered = stream_wrapper_register(self::SCHEME, get_class($wrapper));
        self::assertTrue($this->registered);
    }

    protected function tearDown(): void
    {
        if ($this->registered && in_array(self::SCHEME, stream_get_wrappers(), true)) {
            stream_wrapper_unregister(self::SCHEME);
        }
        if ($this->hadFixture) {
            $GLOBALS['setReaderDiagnostics'] = $this->previousFixture;
        } else {
            unset($GLOBALS['setReaderDiagnostics']);
        }
    }

    public function testRootStatFailureIncludesItsFreshWarning(): void
    {
        $GLOBALS['setReaderDiagnostics']['failStat']['setdiag://root'] = [
            'followOnly' => false,
        ];
        @trigger_error('stale warning from an earlier operation', E_USER_WARNING);

        $error = SetReader::read(self::SET)->errors[0];

        self::assertSame(self::SET, $error->path);
        self::assertStringContainsString('lstat setdiag://root failed', $error->message);
        self::assertStringContainsString('lstat(): Lstat failed for setdiag://root', $error->message);
        self::assertStringNotContainsString('stale warning', $error->message);
    }

    public function testSetFileStatFailureIncludesItsWarning(): void
    {
        $GLOBALS['setReaderDiagnostics']['failStat'][self::SET] = [
            'followOnly' => false,
        ];

        $error = SetReader::read(self::SET)->errors[0];

        self::assertStringContainsString('lstat ' . self::SET . ' failed', $error->message);
        self::assertStringContainsString('lstat(): Lstat failed for ' . self::SET, $error->message);
    }

    public function testEntryStatFailureIncludesItsWarningAndJoinedPath(): void
    {
        $entry = 'setdiag://root/shop.dbs';
        $GLOBALS['setReaderDiagnostics']['failStat'][$entry] = [
            'followOnly' => false,
        ];

        $error = SetReader::read(self::SET)->errors[0];

        self::assertSame($entry, $error->path);
        self::assertStringContainsString('lstat ' . $entry . ' failed', $error->message);
        self::assertStringContainsString('lstat(): Lstat failed for ' . $entry, $error->message);
    }

    public function testAllowedIntermediateLinkStatFailureIsReported(): void
    {
        $GLOBALS['setReaderDiagnostics']['content'] = '{"schema":1,"documents":["shop.dbs"],"external":["../outside/shop.dbs"]}';
        $link = 'setdiag://root/..';
        $GLOBALS['setReaderDiagnostics']['links'][$link] = true;
        $GLOBALS['setReaderDiagnostics']['failStat'][$link] = [
            'followOnly' => true,
        ];

        $result = SetReader::read(self::SET);
        $error = $result->errors[0];

        self::assertSame('setdiag://root/../outside/shop.dbs', $error->path);
        self::assertStringContainsString('stat ' . $link . ' failed', $error->message);
        self::assertStringContainsString('stat(): stat failed for ' . $link, $error->message);
    }

    public function testRootListingFailureIncludesItsWarning(): void
    {
        $GLOBALS['setReaderDiagnostics']['failListing']['setdiag://root/'] = true;

        $error = SetReader::read(self::SET)->errors[0];

        self::assertStringContainsString('scandir setdiag://root/ failed', $error->message);
        self::assertStringContainsString('scandir():', $error->message);
    }

    public function testFailedEntryListingIsCachedWithItsWarningAndErrorOrder(): void
    {
        $GLOBALS['setReaderDiagnostics']['content'] = '{"schema":1,"documents":["sub/one.dbs","sub/two.dbs"]}';
        $GLOBALS['setReaderDiagnostics']['entries'] = ['.', '..', 'dbspec-set.json', 'sub'];
        $GLOBALS['setReaderDiagnostics']['failListing']['setdiag://root/sub'] = true;

        $errors = SetReader::read(self::SET)->errors;

        self::assertCount(2, $errors);
        self::assertSame('setdiag://root/sub/one.dbs', $errors[0]->path);
        self::assertSame('setdiag://root/sub/two.dbs', $errors[1]->path);
        self::assertStringContainsString('scandir setdiag://root/sub failed', $errors[0]->message);
        self::assertStringContainsString('scandir():', $errors[0]->message);
        self::assertSame(1, $GLOBALS['setReaderDiagnostics']['listingCalls']['setdiag://root/sub']);
        self::assertSame(
            substr($errors[0]->message, strpos($errors[0]->message, ': scandir ')),
            substr($errors[1]->message, strpos($errors[1]->message, ': scandir '))
        );
    }

    public function testSuccessfullyListedMissingNameRemainsDistinct(): void
    {
        $GLOBALS['setReaderDiagnostics']['content'] = '{"schema":1,"documents":["missing.dbs"]}';

        $error = SetReader::read(self::SET)->errors[0];

        self::assertStringContainsString('missing.dbs is not a name that setdiag://root/ lists', $error->message);
        self::assertStringNotContainsString('failed', $error->message);
    }
}
