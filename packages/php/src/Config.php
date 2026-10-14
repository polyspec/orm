<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** Connection options. */
final class Config
{
    /** key of aesVersion for aes writes; empty takes aesKeys[aesVersion] */
    public readonly string $aesKey;

    public function __construct(
        string $aesKey = '',
        public readonly string $blindIndexKey = '',
        public readonly int $aesVersion = 1,
        /** @var array<int, string> every declared AES key version */
        public readonly array $aesKeys = [],
        /** maximum connections of a pool; the PHP client opens one connection per Db, has no pool and accepts only zero */
        public readonly int $poolSize = 0,
        /** bound of every statement of the connection in milliseconds; zero keeps the server default */
        public readonly int $statementTimeoutMs = 0,
        /** maximum idle connections of a pool; the PHP client has no pool and accepts only zero */
        public readonly int $poolIdleSize = 0,
        /** lifetime of a pool connection in milliseconds; the PHP client has no pool and accepts only zero */
        public readonly int $poolLifetimeMs = 0,
        public readonly int $planCacheSize = 256,
        public readonly int $statementCacheSize = 256,
        /**
         * fn(): array<string, mixed> giving the audit record values of a transaction with audit
         * values, such as the account and the request; the transaction calls it once before it
         * begins, and its values of the same column lose to the values of the transaction
         */
        public readonly ?\Closure $auditSource = null,
    ) {
        if ($aesVersion < 1 || $planCacheSize < 1 || $statementCacheSize < 1) {
            throw new OrmException(Code::CONFIG, 'AES version and cache sizes must be positive');
        }
        if ($aesKey !== '' && $aesKeys !== [] && ($aesKeys[$aesVersion] ?? '') !== $aesKey) {
            throw new OrmException(Code::CONFIG, "aesKey differs from aesKeys[$aesVersion]");
        }
        $this->aesKey = $aesKey !== '' ? $aesKey : ($aesKeys[$aesVersion] ?? '');
    }

    public function keyring(): AesKeyring
    {
        if ($this->aesKeys !== []) {
            return new AesKeyring($this->aesKeys, $this->aesVersion);
        }
        if ($this->aesKey === '') {
            throw new OrmException(Code::CONFIG, 'secret aes is not configured');
        }
        return new AesKeyring([$this->aesVersion => $this->aesKey], $this->aesVersion);
    }
}
