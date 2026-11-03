# authenticated_encryption coverage: the AES envelope decryption, the encryption round trip, the refusal of a tampered
# envelope and of another key, and the blind index of contracts/fixtures/authenticated_encryption.json through the
# client's codec functions, as the authenticated_encryption coverage of Go, PHP, TypeScript and Rust does.
import json

from polyspec.orm.codec import CodecError, blind_index, host_decode, host_encode
from polyspec.orm.errors import OrmError
from .coverage_case import REPOSITORY_ROOT, expect_equal, CoverageCase, coverage_main

FIXTURE = json.loads(
    (
        REPOSITORY_ROOT / "contracts" / "fixtures" / "authenticated_encryption.json"
    ).read_text(encoding="utf-8")
)


def fixture_case(case_id: str, operation: str) -> dict:
    """The fixture case of an ID with its operation."""
    found = [c for c in FIXTURE["cases"] if c["id"] == case_id]
    expect_equal(
        len(found), 1, f"authenticated_encryption.json holds case {case_id} once"
    )
    expect_equal(found[0]["operation"], operation, f"operation of case {case_id}")
    return found[0]


def decrypt(given: dict):
    return host_decode(bytes.fromhex(given["envelope_hex"]), ["aes"], given["key"])


def rejected(case_id: str) -> None:
    c = fixture_case(case_id, "aes_decrypt")
    try:
        decrypt(c["input"])
    except (OrmError, CodecError) as error:
        expect_equal(error.code, c["expected"]["error"], f"the code of {case_id}")
        return
    raise AssertionError(f"{case_id} decrypted")


def aes_envelope_decrypt():
    c = fixture_case("aes_envelope_decrypt", "aes_decrypt")
    expect_equal(decrypt(c["input"]), c["expected"]["plain"], "decrypted plaintext")


def aes_round_trip():
    c = fixture_case("aes_round_trip", "aes_encrypt_decrypt")
    envelope = host_encode(c["input"]["plain"], ["aes"], c["input"]["key"])
    expect_equal(type(envelope), bytes, "the envelope type")
    prefix = bytes.fromhex(c["expected"]["prefix_hex"])
    expect_equal(
        envelope[: len(prefix)].hex().upper(),
        c["expected"]["prefix_hex"],
        "envelope prefix",
    )
    expect_equal(len(envelope), c["expected"]["envelope_bytes"], "envelope length")
    expect_equal(
        host_decode(envelope, ["aes"], c["input"]["key"]),
        c["expected"]["plain"],
        "round trip plaintext",
    )


def blind_index_vector():
    c = fixture_case("blind_index_vector", "blind_index")
    expect_equal(
        blind_index(c["input"]["plain"], c["input"]["key"]),
        c["expected"]["index"],
        "blind index",
    )


class CoverageTest(CoverageCase):
    def test_aes_envelope_decrypt(self):
        self.each_item("aes_envelope_decrypt", aes_envelope_decrypt)

    def test_aes_round_trip(self):
        self.each_item("aes_round_trip", aes_round_trip)

    def test_aes_tamper_rejected(self):
        self.each_item("aes_tamper_rejected", lambda: rejected("aes_tamper_rejected"))

    def test_aes_wrong_key_rejected(self):
        self.each_item(
            "aes_wrong_key_rejected", lambda: rejected("aes_wrong_key_rejected")
        )

    def test_blind_index_vector(self):
        self.each_item("blind_index_vector", blind_index_vector)


if __name__ == "__main__":
    coverage_main(CoverageTest)
