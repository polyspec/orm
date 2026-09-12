<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\KeysetCursor;
use Orm\OrmException;

$order = [['column' => 'name', 'desc' => true], ['column' => 'seq']];
$cursor = KeysetCursor::encode($order, ['n', 42]);
$decoded = KeysetCursor::decode($cursor);
if ($decoded['order'] !== $order || $decoded['values'] !== ['n', 42]) {
    throw new RuntimeException('PHP keyset cursor round trip changed order or values');
}

try {
    KeysetCursor::decode(substr($cursor, 0, -1));
    throw new RuntimeException('tampered PHP keyset cursor was accepted');
} catch (OrmException $error) {
    if ($error->code_ !== Code::CURSOR_INVALID) {
        throw new RuntimeException('tampered PHP keyset cursor returned the wrong error');
    }
}

echo "php keyset: typed cursor round trip and tamper rejection passed\n";
