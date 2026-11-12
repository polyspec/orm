<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;

/**
 * The TCP listener of catalog.reconnect {connects} (DIA-211), in a process of its own (connect-relay.php), since
 * the reconnect blocks this one: it relays each connection it accepts to the host and port of the DSN and counts
 * the connections it accepted. A client learns that its connect is refused only from bytes that the server sends
 * through an accepted connection, so when a refused reconnect has returned, every connection that the client
 * opened for it has been counted.
 */
final class ConnectRelay
{
    /** @var resource */
    private $process;
    /** @var array<int, resource> */
    private array $pipes;
    /** @var resource|null the control connection: "count" answers "accepted <n>"; its end ends the process */
    private $control = null;
    public readonly string $dsn;

    public function __construct(string $dsn)
    {
        if (preg_match('~^([a-z]+://[^@/]+@)([^/?]+)(.*)$~', $dsn, $match) !== 1) {
            Assert::fail("catalog.reconnect connects: the DSN names no host and port: $dsn");
        }
        $at = (int) strrpos($match[2], ':');
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/connect-relay.php', substr($match[2], 0, $at), substr($match[2], $at + 1)],
            [1 => ['pipe', 'w']],
            $pipes
        );
        if (!is_resource($process)) {
            Assert::fail('connect-relay.php did not start');
        }
        $this->process = $process;
        $this->pipes = $pipes;
        $line = rtrim((string) fgets($pipes[1]), "\n");
        if (preg_match('/^port (\d+) control (\d+)$/', $line, $port) !== 1) {
            $this->close();
            Assert::fail("connect-relay.php printed \"$line\", not its ports");
        }
        $control = stream_socket_client('tcp://127.0.0.1:' . $port[2], $errno, $error);
        if ($control === false) {
            $this->close();
            Assert::fail("connect-relay.php takes no control connection: $error");
        }
        $this->control = $control;
        $this->dsn = $match[1] . '127.0.0.1:' . $port[1] . $match[3];
    }

    /** The connections that the relay has accepted. */
    public function accepted(): int
    {
        fwrite($this->control, "count\n");
        $line = rtrim((string) fgets($this->control), "\n");
        if (preg_match('/^accepted (\d+)$/', $line, $count) !== 1) {
            Assert::fail("connect-relay.php printed \"$line\", not its count");
        }
        return (int) $count[1];
    }

    /** Ends the relay: the end of its control connection ends its process. */
    public function close(): void
    {
        if ($this->control !== null) {
            fclose($this->control);
        }
        fclose($this->pipes[1]);
        proc_close($this->process);
    }
}
