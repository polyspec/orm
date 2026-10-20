<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal One connection to the flowmark server, that is, one server session. The PHP client has no pool,
 * so one markdown Db uses one session, and the transaction is opened on that session.
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
        $conn = @stream_socket_client("tcp://$address", $errno, $errstr);
        if ($conn === false) {
            throw new OrmException(Code::DRIVER,
                "connecting to the flowmark server $address: $errstr; start flowmark serve for the corpus");
        }
        // No limit is put on the time to read an answer: the answer to a request waiting for a lock is ended
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

    public function close(): void
    {
        if ($this->conn !== null) {
            fclose($this->conn);
            $this->conn = null;
        }
    }

    /**
     * Sends one message as one line and reads one line of answer. If the answer is
     * {"error": {code, message}}, that is the error with that code. If the connection drops, it is
     * CONNECTION_LOST and the session ends.
     *
     * @param array<string, mixed> $message
     * @return array<string, mixed>
     */
    public function call(array $message): array
    {
        if ($this->conn === null) {
            throw new OrmException(Code::CONNECTION_LOST, 'the flowmark session has ended');
        }
        try {
            $line = json_encode($message, Model::JSON_FLAGS) . "\n";
        } catch (\JsonException $e) {
            throw new OrmException(Code::INTERNAL, 'writing the message: ' . $e->getMessage(), $e);
        }
        for ($written = 0; $written < strlen($line); $written += $n) {
            $n = @fwrite($this->conn, substr($line, $written));
            if ($n === false || $n === 0) {
                $this->close();
                throw new OrmException(Code::CONNECTION_LOST,
                    'the flowmark server connection broke while the message was written');
            }
        }
        $answer = fgets($this->conn);
        if ($answer === false) {
            $this->close();
            throw new OrmException(Code::CONNECTION_LOST,
                'the flowmark server connection broke: the server closed the connection');
        }
        $answer = rtrim($answer, "\n");
        $decoded = str_starts_with($answer, '{') ? json_decode($answer, true, 512, JSON_BIGINT_AS_STRING) : null;
        if (!is_array($decoded)) {
            $this->close();
            throw new OrmException(Code::INTERNAL,
                'the flowmark server answered ' . json_encode($answer) . ', not a JSON object');
        }
        if (array_key_exists('error', $decoded)) {
            $error = $decoded['error'];
            $code = is_array($error) ? ($error['code'] ?? '') : '';
            if (!is_string($code) || $code === '') {
                $this->close();
                throw new OrmException(Code::INTERNAL,
                    'the flowmark server answered the error ' . json_encode($error) . ' without a code');
            }
            // The server closes the connection after writing CONNECTION_LOST (idle transaction).
            if ($code === Code::CONNECTION_LOST) {
                $this->close();
            }
            throw new OrmException($code, (string) ($error['message'] ?? ''));
        }
        return $decoded;
    }
}
