<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** A stream whose every read fails, as a driver stream that cannot be decoded. */
final class CatalogUnreadableStream
{
    public const SCHEME = 'catalog-unreadable';
    public const FAILURE = 'the stream cannot be read';

    /** @var resource|null */
    public $context;

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP names the methods of a stream wrapper.
    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        return true;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP names the methods of a stream wrapper.
    public function stream_read(int $count): string
    {
        throw new \RuntimeException(self::FAILURE);
    }

    /** @return array<int|string, int> */
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP names the methods of a stream wrapper.
    public function stream_stat(): array
    {
        return [];
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP names the methods of a stream wrapper.
    public function stream_eof(): bool
    {
        return false;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP names the methods of a stream wrapper.
    public function stream_close(): void
    {
    }
}
