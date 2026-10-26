<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;

/** The existing assertion methods selected by authenticated-encryption fixture IDs. */
trait AuthenticatedEncryptionFixtureCases
{
    /** @return array<string, string> */
    private static function authenticatedEncryptionMethods(): array
    {
        return [
            'aes_envelope_decrypt' => 'testAesEnvelopeDecrypt',
            'aes_round_trip' => 'testAesRoundTrip',
            'aes_tamper_rejected' => 'testAesTamperRejected',
            'aes_wrong_key_rejected' => 'testAesWrongKeyRejected',
            'blind_index_vector' => 'testBlindIndexVector',
        ];
    }

    /** @return array<string, array<string, mixed>> */
    private static function authenticatedEncryptionFixture(): array
    {
        $fixture = coverageJson(coverageRepositoryRoot() . '/contracts/fixtures/authenticated_encryption.json');
        $methods = self::authenticatedEncryptionMethods();
        $ids = array_column($fixture['cases'], 'id');
        if (count($ids) !== count(array_unique($ids)) || array_diff(array_keys($methods), $ids) !== []
            || array_diff($ids, array_keys($methods)) !== []) {
            throw new RuntimeException('authenticated_encryption fixture case IDs do not match the PHP assertions');
        }
        return array_column($fixture['cases'], null, 'id');
    }

    /** @return iterable<string, array{string}> */
    public static function authenticatedEncryptionCases(): iterable
    {
        foreach (self::authenticatedEncryptionFixture() as $id => $_case) {
            yield $id => [$id];
        }
    }

    public function runAuthenticatedEncryptionFixtureCase(string $id): void
    {
        $methods = self::authenticatedEncryptionMethods();
        if (!isset($methods[$id])) {
            throw new RuntimeException("unknown authenticated_encryption case $id");
        }
        $this->{$methods[$id]}();
    }

    #[DataProvider('authenticatedEncryptionCases')]
    public function testVector(string $id): void
    {
        $this->runAuthenticatedEncryptionFixtureCase($id);
    }
}
