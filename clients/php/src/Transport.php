<?php
declare(strict_types=1);

namespace Orm;

/**
 * Persistent unix-socket connection to ormd (length-prefixed JSON frames) and
 * the plan cache: APCu across workers, plus a per-request array keyed by the
 * builder's shape signature (no IR encoding on a local hit).
 */
final class Transport
{
    /** @var resource|null */
    private $fp = null;
    /** @var array<string, array> plans by Req signature (this request only) */
    private array $local = [];
    /** @var list<string> */
    private array $localOrder = [];
    private ?CompilerTransport $compiler;

    public function __construct(private readonly Config $config)
    {
        $this->compiler = $config->endpoint === null ? null : new ConnectCompiler($config->endpoint, $config->timeoutSeconds);
    }

    /** @return resource */
    private function conn()
    {
        if ($this->fp !== null) {
            return $this->fp;
        }
        $fp = @stream_socket_client(
            'unix://' . $this->config->socket, $errno, $errstr, 1.0,
            STREAM_CLIENT_CONNECT | STREAM_CLIENT_PERSISTENT
        );
        if (!$fp) {
            throw new OrmException(Code::CONFIG, "ormd unreachable at {$this->config->socket}: $errstr");
        }
        stream_set_blocking($fp, true);
        $this->fp = $fp;
        return $fp;
    }

    private function call(string $frame): string
    {
        $fp = $this->conn();
        $out = pack('N', strlen($frame)) . $frame;
        $n = @fwrite($fp, $out);
        if ($n !== strlen($out)) {
            // The persistent stream can be stale (ormd restarted). Reconnect once; a second failure is an error.
            $this->fp = null;
            $fp = $this->conn();
            if (@fwrite($fp, $out) !== strlen($out)) {
                throw new OrmException(Code::CONFIG, "ormd at {$this->config->socket}: write failed");
            }
        }
        $hdr = stream_get_contents($fp, 4);
        if ($hdr === false || strlen($hdr) !== 4) {
            $this->fp = null;
            throw new OrmException(Code::CONFIG, "ormd at {$this->config->socket}: short header");
        }
        $len = unpack('N', $hdr)[1];
        $body = '';
        while (strlen($body) < $len) {
            $chunk = fread($fp, $len - strlen($body));
            if ($chunk === false || $chunk === '') {
                $this->fp = null;
                throw new OrmException(Code::CONFIG, "ormd at {$this->config->socket}: short body");
            }
            $body .= $chunk;
        }
        return $body;
    }

    private function decode(string $body): array
    {
        $resp = json_decode($body, true);
        if (!is_array($resp)) {
            throw new OrmException(Code::INTERNAL, 'ormd: bad response');
        }
        if (isset($resp['error'])) {
            throw new OrmException($resp['error']['code'], $resp['error']['msg']);
        }
        return $resp;
    }

    /** The schema hash of the manifest ormd loaded ({"op":"hash"}). */
    public function hash(): string
    {
        return $this->info()['schema_hash'];
    }

    /**
     * What ormd was started with: the schema hash of its manifest and the dialect it compiles for
     * (`-dialect`), both checked once by Orm::init. An ormd without a dialect in its answer predates S6.
     * @return array{schema_hash: string, dialect: string}
     */
    public function info(): array
    {
        if ($this->compiler !== null) {
            $metadata = $this->compiler->metadata();
            return ['schema_hash' => $metadata->getSchemaHash(), 'dialect' => $metadata->getDialect(), 'ir_version' => $metadata->getIrVersion()];
        }
        $r = $this->decode($this->call('{"op":"hash"}'));
        if (!isset($r['schema_hash'])) {
            throw new OrmException(Code::INTERNAL, 'ormd: no schema_hash');
        }
        if (!isset($r['dialect'])) {
            throw new OrmException(Code::CONFIG, "ormd at {$this->config->socket} does not report its dialect: rebuild it from cmd/ormd");
        }
        return ['schema_hash' => (string) $r['schema_hash'], 'dialect' => (string) $r['dialect']];
    }

    /**
     * The plan of a request. The per-request cache is keyed by the builder's signature
     * (kind + the tokens every builder call appended + param count), so a repeated shape
     * costs one array lookup; only a miss encodes the IR for the APCu / ormd key.
     */
    public function planFor(Req $req, string $kind): array
    {
        if ($req->error !== null) { throw $req->error; }
        $key = $kind . "\x1f" . $req->sig . "\x1f" . count($req->params);
        if (isset($this->local[$key])) return $this->local[$key];
        $plan = $this->plan($req->shape($kind));
        $this->local[$key] = $plan;
        $this->localOrder[] = $key;
        while (count($this->localOrder) > Orm::config()->planCacheSize) {
            $oldest = array_shift($this->localOrder);
            if ($oldest !== null) unset($this->local[$oldest]);
        }
        return $plan;
    }

    /**
     * Validates and registers a plan emitted by `ormgen precompile`. The request
     * binds the bundle to one exact shape, so later planFor() calls use the
     * registered plan without contacting the compiler.
     *
     * @param array|string $bundle decoded bundle or its JSON representation
     */
    public function loadPlanBundle(array|string $bundle, Req $req, string $kind): void
    {
        if ($req->error !== null) throw $req->error;
        if (is_string($bundle)) {
            $bundle = json_decode($bundle, true);
            if (!is_array($bundle)) throw new OrmException(Code::CONFIG, 'precompiled plan is invalid JSON');
        }
        if (($bundle['version'] ?? null) !== 1) {
            throw new OrmException(Code::VERSION_MISMATCH, 'precompiled plan version is not supported');
        }
        $schema = (string) ($bundle['schema_hash'] ?? '');
        if ($schema !== Orm::config()->schemaHash()) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "precompiled plan schema $schema but client schema is " . Orm::config()->schemaHash());
        }
        if (($req->ir['schema_hash'] ?? null) !== $schema) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "request schema " . (string) ($req->ir['schema_hash'] ?? '') . " but client schema is $schema");
        }
        $dialect = (string) ($bundle['dialect'] ?? '');
        if ($dialect !== Orm::config()->driver) {
            throw new OrmException(Code::CONFIG, "precompiled plan dialect $dialect but database driver is " . Orm::config()->driver);
        }
        if (!is_string($bundle['request_sha256'] ?? null) || $bundle['request_sha256'] === '' || !is_array($bundle['plan'] ?? null)) {
            throw new OrmException(Code::CONFIG, 'precompiled plan requires request_sha256 and plan');
        }
        $ir = $req->shape($kind);
        $canonical = json_encode(self::canonicalJson($ir), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $requestHash = hash('sha256', $canonical);
        if ($requestHash !== $bundle['request_sha256']) {
            throw new OrmException(Code::CONFIG, "precompiled plan request hash {$bundle['request_sha256']} does not match request shape $requestHash");
        }
        $plan = $bundle['plan'];
        if (($plan['schema_hash'] ?? null) !== $schema || ($plan['kind'] ?? null) !== $kind || count($plan['steps'] ?? []) < 1) {
            throw new OrmException(Code::CONFIG, 'precompiled plan body does not match its envelope or request');
        }
        Wire::check('Plan', $plan);
        $key = $kind . "\x1f" . $req->sig . "\x1f" . count($req->params);
        $this->local[$key] = $plan;
        $this->localOrder[] = $key;
        while (count($this->localOrder) > Orm::config()->planCacheSize) {
            $oldest = array_shift($this->localOrder);
            if ($oldest !== null) unset($this->local[$oldest]);
        }
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $cacheKey = 'orm:' . Orm::config()->driver . ':' . Orm::config()->schemaHash() . ':' . hash('xxh3', $shape);
        Assemble::index($plan, hash('xxh3', $shape));
        if (function_exists('apcu_store')) apcu_store($cacheKey, $plan);
    }

    private static function canonicalJson(mixed $value): mixed
    {
        if (!is_array($value)) return $value;
        if (array_is_list($value)) return array_map(self::canonicalJson(...), $value);
        $keys = array_keys($value);
        sort($keys, SORT_STRING);
        $out = [];
        foreach ($keys as $key) $out[$key] = self::canonicalJson($value[$key]);
        return $out;
    }

    /**
     * Compile an IR (value-free) into a plan, cached by the IR's own bytes.
     * @param array $ir  the request without params
     */
    public function plan(array $ir): array
    {
        Wire::check('IRRequest', $ir);
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $id = hash('xxh3', $shape);
        $key = 'orm:' . $this->config->driver . ':' . $this->config->schemaHash() . ':' . $id; // plans are dialect text
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($key, $ok);
            if ($ok && is_array($hit)) {
                return $hit;
            }
        }
        $plan = $this->compiler === null
            ? $this->decode($this->call('{"op":"compile","ir":' . $shape . '}'))['plan']
            : CompilerBridge::plan($this->compiler->compile(CompilerBridge::request($ir)));
        Wire::check('Plan', $plan);
        // Precompute per-step data once (name→index maps, styled flag, plan id), so rows never need array_combine.
        Assemble::index($plan, $id);
        if (function_exists('apcu_store')) {
            apcu_store($key, $plan);
        }
        return $plan;
    }
}

final class Assemble
{
    /**
     * Stamps every step with 'plan_id' (the cache key suffix, for the on_query hook), 'styled'
     * (whether any selected column needs the codec) and adds 'idx' => [name => position] to
     * every assemble node in place. A styled column's styles are split once into 'host' (aes/hex/ip,
     * the stages the dialect left to the executor) and 'codec' (docs/codec.md), in write order.
     */
    public static function index(array &$plan, string $id): void
    {
        foreach ($plan['steps'] as &$step) {
            $step['plan_id'] = $id;
            $step['styled'] = false;
            if (isset($step['assemble'])) {
                self::indexNode($step['assemble']);
                $step['styled'] = Codec::hasStyled($step['assemble']);
            }
        }
    }

    private static function indexNode(array &$a): void
    {
        $idx = [];
        $hidden = [];
        foreach ($a['columns'] as $i => $c) {
            $idx[$c['name']] = $c['index'];
            if (!empty($c['hidden'])) {
                $hidden[$c['name']] = true;
            }
            if (!empty($c['styles'])) {
                $host = [];
                $codec = [];
                foreach ($c['styles'] as $st) {
                    if (Codec::isHostStyle($st)) {
                        $host[] = $st;
                    } else {
                        $codec[] = $st;
                    }
                }
                $a['columns'][$i]['host'] = $host;
                $a['columns'][$i]['codec'] = $codec;
            }
        }
        $a['idx'] = $idx;
        $a['hidden'] = $hidden;
        if (isset($a['children'])) {
            foreach ($a['children'] as &$ch) {
                if (isset($ch['assemble'])) {
                    self::indexNode($ch['assemble']);
                }
            }
        }
    }
}
