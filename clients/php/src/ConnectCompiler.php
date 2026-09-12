<?php
declare(strict_types=1);

namespace Orm;

use Orm\Compiler\V1\CompileRequest;
use Orm\Compiler\V1\CompileResponse;
use Orm\Compiler\V1\GetMetadataRequest;
use Orm\Compiler\V1\GetMetadataResponse;

final class ConnectCompiler implements CompilerTransport
{
    private const SERVICE = '/orm.compiler.v1.CompilerService/';

    public function __construct(
        private readonly string $endpoint,
        private readonly float $timeoutSeconds = 5.0,
    ) {
        if (!preg_match('#^https?://#', $endpoint)) {
            throw new OrmException(Code::CONFIG, 'compiler endpoint must use http:// or https://');
        }
        if ($timeoutSeconds <= 0) {
            throw new OrmException(Code::CONFIG, 'compiler timeout must be positive');
        }
    }

    public function compile(CompileRequest $request): \Orm\Compiler\V1\Plan
    {
        $response = new CompileResponse();
        $response->mergeFromString($this->call('Compile', $request->serializeToString()));
        if ($response->getResult() === 'error') {
            $error = $response->getError();
            throw new OrmException($error->getCode(), $error->getMessage());
        }
        if ($response->getResult() !== 'plan') {
            throw new OrmException(Code::INTERNAL, 'compiler returned no plan or error');
        }
        return $response->getPlan();
    }

    public function metadata(): GetMetadataResponse
    {
        $request = new GetMetadataRequest();
        $response = new GetMetadataResponse();
        $response->mergeFromString($this->call('GetMetadata', $request->serializeToString()));
        return $response;
    }

    private function call(string $method, string $payload): string
    {
        $headers = [
            'Content-Type: application/proto',
            'Accept: application/proto',
            'Connect-Protocol-Version: 1',
            'Content-Length: ' . strlen($payload),
        ];
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $payload,
            'timeout' => $this->timeoutSeconds,
            'ignore_errors' => true,
        ]]);
        $url = rtrim($this->endpoint, '/') . self::SERVICE . $method;
        $body = @file_get_contents($url, false, $context);
        $responseHeaders = $http_response_header ?? [];
        $status = self::status($responseHeaders);
        if ($body === false || $status < 200 || $status >= 300) {
            $detail = $body === false ? 'request failed' : trim($body);
            throw new OrmException(Code::CONFIG, "compiler RPC {$method} failed: HTTP {$status}: {$detail}");
        }
        return $body;
    }

    /** @param list<string> $headers */
    private static function status(array $headers): int
    {
        if ($headers !== [] && preg_match('/^HTTP\/\S+\s+(\d{3})/', $headers[0], $match)) {
            return (int) $match[1];
        }
        return 0;
    }
}
