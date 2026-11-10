<?php

declare(strict_types=1);

// The process of ConnectRelay (catalog.reconnect {connects}, DIA-211): it listens on 127.0.0.1 twice, prints "port
// <port> control <port>", relays each connection of the first port to <host> <port>, copying the bytes both ways, and
// counts the connections it accepted. The control port takes one connection, on which the line "count" answers
// "accepted <n>"; its end ends the process. The control is a socket, not the standard input, since stream_select
// waits on no pipe on Windows. One stream_select waits on every stream, so a connection is accepted before any byte
// of the server reaches the client through it.
namespace {
    [$host, $port] = [$argv[1] ?? '', $argv[2] ?? ''];
    $listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
    if ($listener === false) {
        fwrite(STDERR, "connect-relay: listen: $error\n");
        exit(1);
    }
    $control = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
    if ($control === false) {
        fwrite(STDERR, "connect-relay: listen: $error\n");
        exit(1);
    }
    $portOf = static function ($server): string {
        $name = (string) stream_socket_get_name($server, false);
        return substr($name, strrpos($name, ':') + 1);
    };
    fwrite(STDOUT, 'port ' . $portOf($listener) . ' control ' . $portOf($control) . "\n");
    $controller = stream_socket_accept($control, -1);
    if ($controller === false) {
        fwrite(STDERR, "connect-relay: no control connection\n");
        exit(1);
    }
    $accepted = 0;
    /** @var array<int, resource> $peers the other end of each relayed stream, by the id of the stream */
    $peers = [];
    /** @var array<int, resource> $streams */
    $streams = [];
    $close = static function ($stream) use (&$peers, &$streams): void {
        $id = (int) $stream;
        $peer = $peers[$id] ?? null;
        unset($peers[$id], $streams[$id]);
        fclose($stream);
        if ($peer !== null) {
            unset($peers[(int) $peer], $streams[(int) $peer]);
            fclose($peer);
        }
    };
    while (true) {
        $read = [$listener, $controller, ...array_values($streams)];
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, null) === false) {
            fwrite(STDERR, "connect-relay: stream_select failed\n");
            exit(1);
        }
        foreach ($read as $stream) {
            if ($stream === $listener) {
                $client = stream_socket_accept($listener);
                if ($client === false) {
                    continue;
                }
                $accepted++;
                $server = stream_socket_client("tcp://$host:$port", $errno, $error);
                if ($server === false) {
                    fclose($client);
                    continue;
                }
                $peers[(int) $client] = $server;
                $peers[(int) $server] = $client;
                $streams[(int) $client] = $client;
                $streams[(int) $server] = $server;
            } elseif ($stream === $controller) {
                $line = fgets($controller);
                if ($line === false) {
                    exit(0);
                }
                if (rtrim($line, "\n") === 'count') {
                    fwrite($controller, "accepted $accepted\n");
                }
            } elseif (isset($streams[(int) $stream])) {
                $data = fread($stream, 65536);
                if ($data === false || $data === '') {
                    $close($stream);
                } else {
                    $peer = $peers[(int) $stream];
                    while ($data !== '') {
                        $written = fwrite($peer, $data);
                        if ($written === false || $written === 0) {
                            $close($stream);
                            break;
                        }
                        $data = substr($data, $written);
                    }
                }
            }
        }
    }
}
