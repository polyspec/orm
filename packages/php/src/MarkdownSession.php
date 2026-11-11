<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal One connection to the flowmark server, that is, one server session (docs/spec/protocol.md PRT-63 to
 * PRT-72). The PHP client has no pool, so one markdown Db uses one session: the statements of the SQLite dialect run in
 * it, its transaction among them (Internal\MarkdownPdoAdapter).
 */
final class MarkdownSession
{
    /** @var resource|null */
    private $conn;

    /** @param resource $conn */
    private function __construct($conn)
    {
        $this->conn = $conn;
    }

    /** Connects to the server and sends the corpus and token in the first connect message. */
    public static function dial(string $address, string $corpus, string $token): self
    {
        // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a refused connect returns false with errno and errstr, reported as DRIVER below
        $conn = @stream_socket_client("tcp://$address", $errno, $errstr);
        if ($conn === false) {
            throw new OrmException(
                Code::DRIVER,
                "connecting to the flowmark server $address: $errstr; start flowmark serve for the corpus"
            );
        }
        // No limit is put on the time to read an answer: the answer to a statement waiting for a lock is ended
        // by the server's lock wait.
        stream_set_timeout($conn, -1);
        $session = new self($conn);
        try {
            $session->call(['op' => 'connect', 'corpus' => $corpus, 'token' => $token]);
        } catch (OrmException $e) {
            $session->close();
            throw $e;
        }
        return $session;
    }

    /** Whether the session can no longer be used: it was closed, a read or write failed, or the server ended it. */
    public function broken(): bool
    {
        return $this->conn === null;
    }

    public function close(): void
    {
        if ($this->conn !== null) {
            fclose($this->conn);
            $this->conn = null;
        }
    }

    /**
     * Shuts the connection down without closing it, so a call that waits for its answer ends now; the server rolls back
     * the transaction of a closed connection (PRT-71). A cancellation runs it.
     */
    public function shutdown(): void
    {
        if ($this->conn !== null) {
            stream_socket_shutdown($this->conn, STREAM_SHUT_RDWR);
        }
    }

    /**
     * Sends one message as one line and reads one line of answer. If the answer is
     * {"error": {code, message, result_code?}}, that is the error with that code and message (PRT-71), and
     * $resultCode is the SQLite result code it states, or null. If the connection drops, it is CONNECTION_LOST and the
     * session ends.
     *
     * @param array<string, mixed> $message
     * @return array<string, mixed>
     */
    public function call(array $message, ?int &$resultCode = null): array
    {
        $resultCode = null;
        if ($this->conn === null) {
            throw new OrmException(Code::CONNECTION_LOST, 'the flowmark session has ended');
        }
        try {
            $line = json_encode($message, Model::JSON_FLAGS) . "\n";
        } catch (\JsonException $e) {
            throw new OrmException(Code::INTERNAL, 'writing the message: ' . $e->getMessage(), $e);
        }
        for ($written = 0; $written < strlen($line); $written += $n) {
            // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a closed connection returns false or 0, reported as CONNECTION_LOST below
            $n = @fwrite($this->conn, substr($line, $written));
            if ($n === false || $n === 0) {
                $this->close();
                throw new OrmException(
                    Code::CONNECTION_LOST,
                    'the flowmark server connection broke while the message was written'
                );
            }
        }
        $answer = fgets($this->conn);
        if ($answer === false) {
            $this->close();
            throw new OrmException(
                Code::CONNECTION_LOST,
                'the flowmark server connection broke: the server closed the connection'
            );
        }
        $answer = rtrim($answer, "\n");
        $decoded = str_starts_with($answer, '{') ? json_decode($answer, true, 512, JSON_BIGINT_AS_STRING) : null;
        if (!is_array($decoded)) {
            $this->close();
            throw new OrmException(
                Code::INTERNAL,
                'the flowmark server answered ' . Message::quote($answer) . ', not a JSON object'
            );
        }
        if (array_key_exists('error', $decoded)) {
            $error = $decoded['error'];
            $code = is_array($error) ? ($error['code'] ?? '') : '';
            if (!is_string($code) || $code === '') {
                $this->close();
                throw new OrmException(
                    Code::INTERNAL,
                    'the flowmark server answered the error ' . json_encode($error) . ' without a code'
                );
            }
            // The server closes the connection after writing CONNECTION_LOST (idle transaction).
            if ($code === Code::CONNECTION_LOST) {
                $this->close();
            }
            $result = $error['result_code'] ?? null;
            $resultCode = is_int($result) ? $result : null;
            throw new OrmException($code, (string) ($error['message'] ?? ''));
        }
        return $decoded;
    }

    /**
     * Runs one statement (PRT-65): its text and its parameters in their wire form (PRT-67). The answer holds the first
     * batch of its rows; `more` says that fetch answers the rows that go on (PRT-66).
     *
     * @param list<mixed> $params
     * @return array{columns: list<array{name: string, type: string}>, rows: list<list<mixed>>, affected: int,
     *     last_insert_id: int, more: bool}
     */
    public function statement(string $sql, array $params, ?int &$resultCode = null): array
    {
        $answer = $this->call(['op' => 'statement', 'sql' => $sql, 'params' => $params], $resultCode);
        return self::answer('statement', $answer);
    }

    /**
     * The next batch of the rows of the last statement (PRT-66).
     *
     * @return array{columns: list<array{name: string, type: string}>, rows: list<list<mixed>>, affected: int,
     *     last_insert_id: int, more: bool}
     */
    public function fetch(?int &$resultCode = null): array
    {
        return self::answer('fetch', $this->call(['op' => 'fetch'], $resultCode));
    }

    /** Ends the rows of the last statement that have not been fetched (PRT-66). */
    public function closeRows(?int &$resultCode = null): void
    {
        $this->call(['op' => 'close'], $resultCode);
    }

    /**
     * Reads a statement or fetch answer. A member of another form is INTERNAL.
     *
     * @param array<string, mixed> $a
     * @return array{columns: list<array{name: string, type: string}>, rows: list<list<mixed>>, affected: int,
     *     last_insert_id: int, more: bool}
     */
    private static function answer(string $what, array $a): array
    {
        $invalid = static fn(): OrmException => new OrmException(
            Code::INTERNAL,
            "the answer of a $what: " . json_encode($a, Model::JSON_FLAGS)
        );
        $columns = [];
        foreach ($a['columns'] ?? [] as $c) {
            $type = is_array($c) ? ($c['type'] ?? null) : null;
            if (!is_array($c) || !is_string($c['name'] ?? null) || ($type !== null && !is_string($type))) {
                throw $invalid();
            }
            $columns[] = ['name' => $c['name'], 'type' => (string) $type];
        }
        $rows = $a['rows'] ?? [];
        $affected = $a['affected'] ?? 0;
        $last = $a['last_insert_id'] ?? 0;
        $more = $a['more'] ?? false;
        if (!is_array($rows) || !array_is_list($rows) || !is_int($affected) || !is_int($last) || !is_bool($more)) {
            throw $invalid();
        }
        foreach ($rows as $row) {
            if (!is_array($row) || !array_is_list($row)) {
                throw $invalid();
            }
        }
        return ['columns' => $columns, 'rows' => $rows, 'affected' => $affected, 'last_insert_id' => $last,
            'more' => $more];
    }
}
