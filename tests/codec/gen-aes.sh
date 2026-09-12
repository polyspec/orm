#!/bin/sh
# AES v2 uses a random nonce. Cross-language tests use the fixed vector in
# tests/codec/aes-vectors.json and do not query database-specific AES functions.
set -eu
echo 'The checked-in AES v2 vector is tests/codec/aes-vectors.json.'
