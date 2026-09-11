.PHONY: docs-dev docs-build docs-check docs-static-check docs-verify-idempotent

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
