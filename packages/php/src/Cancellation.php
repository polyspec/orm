<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** A cancellation signal shared by the Db handles attached to it. */
final class Cancellation
{
    /** @var array<int, (\Closure(): void)|null> Offset to cancellation operation. */
    private array $cancelQueries = [];
    /** @var array<int, int> Logical connection identity to its active byte offset. */
    private array $connectionSlots = [];
    /** @var resource|null */
    private $state = null;
    private string $statePath = '';
    private int $ownerPid;
    private int $streamPid;

    public function __construct()
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-cancel-');
        if ($path === false || !chmod($path, 0600)) {
            if (is_string($path)) {
                unlink($path);
            }
            throw new OrmException(Code::CONFIG, 'cannot create a private cancellation state file');
        }
        $stream = fopen($path, 'c+b');
        if ($stream === false || fwrite($stream, "\0") !== 1 || !fflush($stream)) {
            if (is_resource($stream)) {
                fclose($stream);
            }
            unlink($path);
            throw new OrmException(Code::CONFIG, 'cannot initialize the cancellation state file');
        }
        $this->state = $stream;
        $this->statePath = $path;
        $this->ownerPid = getmypid();
        $this->streamPid = $this->ownerPid;
    }

    public function __destruct()
    {
        if (is_resource($this->state)) {
            fclose($this->state);
        }
        if (isset($this->statePath) && ($this->ownerPid ?? -1) === getmypid() && is_file($this->statePath)) {
            unlink($this->statePath);
        }
    }

    /** Cancels every active statement attached to this signal and every later statement on its handles. */
    public function cancel(): void
    {
        $this->withStateLock(LOCK_EX, function ($stream): void {
            $current = $this->readStateUnlocked($stream);
            if (($current & 2) !== 0) {
                return;
            }
            $active = ($current & 1) !== 0;
            $this->writeByteUnlocked($stream, 0, ($active ? 1 : 0) | 2);
            if ($active) {
                foreach ($this->cancelQueries as $slot => $cancel) {
                    if ($cancel !== null && $this->readByteUnlocked($stream, $slot) === 1) {
                        $cancel();
                    }
                }
            }
        });
    }

    /** @internal Registers a connection slot and its optional server-side cancellation operation. */
    public function registerCancelQuery(int $connectionId, ?\Closure $cancelQuery): int
    {
        return $this->withStateLock(LOCK_EX, function ($stream) use ($connectionId, $cancelQuery): int {
            $slot = $this->connectionSlots[$connectionId] ?? null;
            if ($slot === null) {
                $stat = fstat($stream);
                if ($stat === false || !ftruncate($stream, $stat['size'] + 1)) {
                    throw new OrmException(Code::CONFIG, 'cannot allocate a private cancellation state slot');
                }
                $slot = $stat['size'];
                $this->writeByteUnlocked($stream, $slot, 0);
                $this->connectionSlots[$connectionId] = $slot;
            }
            if ($cancelQuery !== null || !array_key_exists($slot, $this->cancelQueries)) {
                $this->cancelQueries[$slot] = $cancelQuery;
            }
            return $slot;
        });
    }

    /** @internal Begins a statement in one connection slot. */
    public function begin(int $slot = 0): void
    {
        $this->withStateLock(LOCK_EX, function ($stream) use ($slot): void {
            if (($this->readStateUnlocked($stream) & 2) !== 0) {
                throw new OrmException(Code::CANCELED, 'statement was cancelled');
            }
            if ($slot > 0) {
                $this->writeByteUnlocked($stream, $slot, 1);
            }
            $active = $slot === 0 || $this->hasActiveSlotsUnlocked($stream);
            $this->writeByteUnlocked($stream, 0, $active ? 1 : 0);
        });
    }

    /** @internal Ends one connection slot while keeping the cancellation state persistent. */
    public function end(int $slot = 0): void
    {
        $this->withStateLock(LOCK_EX, function ($stream) use ($slot): void {
            $cancelled = ($this->readStateUnlocked($stream) & 2) !== 0;
            if ($slot > 0) {
                $this->writeByteUnlocked($stream, $slot, 0);
            }
            $this->writeByteUnlocked(
                $stream,
                0,
                ($this->hasActiveSlotsUnlocked($stream) ? 1 : 0) | ($cancelled ? 2 : 0)
            );
        });
    }

    /** @internal Whether the caller cancelled this handle. */
    public function isCancelled(): bool
    {
        return ($this->withStateLock(LOCK_SH, fn($stream): int => $this->readStateUnlocked($stream)) & 2) !== 0;
    }

    /** @internal The private byte read by the SQLite progress extension. */
    public function statePath(): string
    {
        return $this->statePath;
    }

    /** @param resource $stream */
    private function readStateUnlocked($stream): int
    {
        return $this->readByteUnlocked($stream, 0);
    }

    /** @param resource $stream */
    private function readByteUnlocked($stream, int $offset): int
    {
        if (fseek($stream, $offset) !== 0) {
            throw new OrmException(Code::CONFIG, 'cannot read the private cancellation state file');
        }
        $value = fread($stream, 1);
        if (!is_string($value) || strlen($value) !== 1) {
            throw new OrmException(Code::CONFIG, 'cannot read the private cancellation state file');
        }
        return ord($value);
    }

    /** @param resource $stream */
    private function writeByteUnlocked($stream, int $offset, int $state): void
    {
        if (fseek($stream, $offset) !== 0 || fwrite($stream, chr($state)) !== 1 || !fflush($stream)) {
            throw new OrmException(Code::CONFIG, 'cannot update the private cancellation state file');
        }
    }

    /** @param resource $stream */
    private function hasActiveSlotsUnlocked($stream): bool
    {
        $stat = fstat($stream);
        if ($stat === false) {
            throw new OrmException(Code::CONFIG, 'cannot inspect the private cancellation state file');
        }
        for ($offset = 1; $offset < $stat['size']; $offset++) {
            if ($this->readByteUnlocked($stream, $offset) !== 0) {
                return true;
            }
        }
        return false;
    }

    private function withStateLock(int $operation, \Closure $read): mixed
    {
        $stream = $this->stateStream();
        if (!flock($stream, $operation)) {
            throw new OrmException(Code::CONFIG, 'cannot lock the private cancellation state file');
        }
        try {
            return $read($stream);
        } finally {
            if (!flock($stream, LOCK_UN)) {
                throw new OrmException(Code::CONFIG, 'cannot unlock the private cancellation state file');
            }
        }
    }

    /** @return resource */
    private function stateStream()
    {
        $pid = getmypid();
        if ($pid === $this->streamPid && is_resource($this->state)) {
            return $this->state;
        }
        if (is_resource($this->state)) {
            fclose($this->state);
        }
        $stream = fopen($this->statePath, 'r+b');
        if ($stream === false) {
            throw new OrmException(Code::CONFIG, 'cannot open the private cancellation state file');
        }
        $this->state = $stream;
        $this->streamPid = $pid;
        return $stream;
    }
}
