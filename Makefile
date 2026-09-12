.PHONY: check ts-check schema-check proto-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check
.NOTPARALLEL: check docs-check docs-verify-idempotent

check: docs-rules-check docs-check docs-verify-idempotent ts-check schema-check proto-check
	go test ./...

ts-check:
	npm run typescript:check

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
