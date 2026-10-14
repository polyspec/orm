<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal flowmark server와의 연결 하나, 곧 server session 하나다. PHP client는 pool을 두지
 * 않으므로 markdown Db 하나가 session 하나를 쓰고, transaction은 그 session에서 열린다.
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

    /** server에 연결하고 첫 message connect로 corpus와 token을 보낸다. */
    public static function dial(string $address, string $corpus, string $token): self
    {
        $conn = @stream_socket_client("tcp://$address", $errno, $errstr);
        if ($conn === false) {
            throw new OrmException(Code::DRIVER, "connecting to the flowmark server $address: $errstr; start flowmark serve for the corpus");
        }
        // 답을 읽는 시간에 한도를 두지 않는다: lock을 기다리는 request의 답은 server의 lock 대기가 끝낸다.
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
     * message 하나를 한 줄로 보내고 답 한 줄을 읽는다. 답이 {"error": {code, message}}이면 그 code의
     * 오류다. 연결이 끊기면 CONNECTION_LOST이고 session은 끝난다.
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
                throw new OrmException(Code::CONNECTION_LOST, 'the flowmark server connection broke while the message was written');
            }
        }
        $answer = fgets($this->conn);
        if ($answer === false) {
            $this->close();
            throw new OrmException(Code::CONNECTION_LOST, 'the flowmark server connection broke: the server closed the connection');
        }
        $answer = rtrim($answer, "\n");
        $decoded = str_starts_with($answer, '{') ? json_decode($answer, true, 512, JSON_BIGINT_AS_STRING) : null;
        if (!is_array($decoded)) {
            $this->close();
            throw new OrmException(Code::INTERNAL, 'the flowmark server answered ' . json_encode($answer) . ', not a JSON object');
        }
        if (array_key_exists('error', $decoded)) {
            $error = $decoded['error'];
            $code = is_array($error) ? ($error['code'] ?? '') : '';
            if (!is_string($code) || $code === '') {
                $this->close();
                throw new OrmException(Code::INTERNAL, 'the flowmark server answered the error ' . json_encode($error) . ' without a code');
            }
            // server는 CONNECTION_LOST를 쓴 뒤 연결을 닫는다(idle transaction).
            if ($code === Code::CONNECTION_LOST) {
                $this->close();
            }
            throw new OrmException($code, (string) ($error['message'] ?? ''));
        }
        return $decoded;
    }
}
