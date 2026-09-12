.PHONY: check ts-check schema-check docs-dev docs-build docs-check docs-static-check docs-verify-idempotent docs-rules-check

check: docs-rules-check ts-check schema-check
	go test ./...

ts-check:
	npm run typescript:check

schema-check:
	npm run schema:check

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
