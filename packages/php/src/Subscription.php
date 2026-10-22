<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * A LISTEN subscription (docs/spec/dialects.md DIA-194 and DIA-195) on a PDO connection of its own. PHP has no cancellation
 * primitive, so receive takes a deadline: a deadline that expires fails the receive with CANCELED and closes the subscription.
 */
final class Subscription
{
    private ?\PDO $pdo;

    public function __construct(\PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    /** Checks a channel of 1 to 63 bytes without U+0000 (DIA-192). */
    public static function checkChannel(string $channel): void
    {
        if (strlen($channel) < 1 || strlen($channel) > 63 || str_contains($channel, "\0")) {
            throw new OrmException(Code::CONFIG, 'a channel is 1 to 63 bytes without U+0000');
        }
    }

    /** A quoted PostgreSQL identifier of the channel. */
    public static function quoteIdent(string $channel): string
    {
        return '"' . str_replace('"', '""', $channel) . '"';
    }

    /** Waits up to $timeoutSeconds for the next notification. */
    public function receive(float $timeoutSeconds): Notification
    {
        $pdo = $this->open();
        try {
            $row = $pdo->getNotify(\PDO::FETCH_ASSOC, (int) round($timeoutSeconds * 1000));
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONNECTION_LOST, $e->getMessage(), $e);
        }
        if ($row === false) {
            $this->close();
            throw new OrmException(Code::CANCELED, 'the receive of the LISTEN subscription expired');
        }
        return new Notification((string) $row['message'], (string) ($row['payload'] ?? ''), (int) $row['pid']);
    }

    /** Stops delivery of the channel on the subscription (DIA-195). */
    public function unlisten(string $channel): void
    {
        self::checkChannel($channel);
        $this->open()->exec('UNLISTEN ' . self::quoteIdent($channel));
    }

    /** Runs UNLISTEN for every channel and ends the connection. Closing a closed subscription does nothing. */
    public function close(): void
    {
        if ($this->pdo === null) {
            return;
        }
        $pdo = $this->pdo;
        $this->pdo = null;
        $pdo->exec('UNLISTEN *');
    }

    private function open(): \PDO
    {
        if ($this->pdo === null) {
            throw new OrmException(Code::CONFIG, 'the LISTEN subscription is closed');
        }
        return $this->pdo;
    }
}
