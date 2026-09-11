<?php
declare(strict_types=1);

namespace Orm;

/**
 * Persistent unix-socket connection to ormd (length-prefixed JSON frames) and
 * the plan cache: APCu across workers, plus a per-request array.
 */
final class Transport
{
    /** @var resource|null */
    private $fp = null;
    /** @var array<string, array> */
    private array $local = [];

    public function __construct(private readonly Config $config) {}

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
            throw new OrmException('ORMD_UNREACHABLE', "{$this->config->socket}: $errstr");
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
                throw new OrmException('ORMD_UNREACHABLE', 'write failed');
            }
        }
        $hdr = stream_get_contents($fp, 4);
        if ($hdr === false || strlen($hdr) !== 4) {
            $this->fp = null;
            throw new OrmException('ORMD_UNREACHABLE', 'short header');
        }
        $len = unpack('N', $hdr)[1];
        $body = '';
        while (strlen($body) < $len) {
            $chunk = fread($fp, $len - strlen($body));
            if ($chunk === false || $chunk === '') {
                $this->fp = null;
                throw new OrmException('ORMD_UNREACHABLE', 'short body');
            }
            $body .= $chunk;
        }
        return $body;
    }

    /**
     * Compile an IR (value-free) into a plan, cached by the IR's own bytes.
     * @param array $ir  the request without params
     */
    public function plan(array $ir): array
    {
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $key = 'orm:' . $this->config->schemaHash() . ':' . hash('xxh3', $shape);
        if (isset($this->local[$key])) {
            return $this->local[$key];
        }
        if (function_exists('apcu_fetch')) {
            $hit = apcu_fetch($key, $ok);
            if ($ok && is_array($hit)) {
                return $this->local[$key] = $hit;
            }
        }
        $resp = json_decode($this->call('{"op":"compile","ir":' . $shape . '}'), true);
        if (!is_array($resp)) {
            throw new OrmException('ORMD_PROTOCOL', 'bad response');
        }
        if (isset($resp['error'])) {
            throw new OrmException($resp['error']['code'], $resp['error']['msg']);
        }
        $plan = $resp['plan'];
        // Precompute name→index maps for every assemble node once, so rows never need array_combine.
        Assemble::index($plan);
        if (function_exists('apcu_store')) {
            apcu_store($key, $plan);
        }
        return $this->local[$key] = $plan;
    }
}

final class Assemble
{
    /** Adds 'idx' => [name => position] to every assemble node in place. */
    public static function index(array &$plan): void
    {
        foreach ($plan['steps'] as &$step) {
            if (isset($step['assemble'])) {
                self::indexNode($step['assemble']);
            }
        }
    }

    private static function indexNode(array &$a): void
    {
        $idx = [];
        foreach ($a['columns'] as $c) {
            $idx[$c['name']] = $c['index'];
        }
        $a['idx'] = $idx;
        if (isset($a['children'])) {
            foreach ($a['children'] as &$ch) {
                self::indexNode($ch['assemble']);
            }
        }
    }
}
