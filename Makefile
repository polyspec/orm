.PHONY: check db-test ts-check schema-check proto-check typescript-build rust-150-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check
.NOTPARALLEL: check docs-check docs-verify-idempotent

check: docs-rules-check docs-check docs-verify-idempotent ts-check schema-check proto-check db-test
	go test ./...

db-test:
	./scripts/db-test.sh

ts-check:
	npm run typescript:check && npm run typescript:build && node tests/typescript/check.mjs && node tests/typescript/common-vector.mjs && node tests/typescript/codec-vector.mjs

schema-check:
	npm run schema:check

proto-check:
	npm run proto:check

docs-dev:
	npm run docs:dev

docs-build:
	npm run docs:build

docs-check:
	npm run docs:check

docs-static-check:
	npm run docs:static-check

docs-verify-idempotent:
	npm run docs:verify-idempotent

docs-rules-check:
	npm run docs:rules-check

rust-150-check:
	./scripts/check-rust-150.sh

typescript-build:
	npm run typescript:build
