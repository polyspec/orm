# The bootstrap of kit in a repository: `include scripts/kit/kit-bootstrap.mk` in its Makefile. This file is a copy that
# `make kit-sync` writes from the installed package @polyspec/kit; it includes the kit.mk of that package, which runs the
# built tools of its dist. The package is installed in two steps, both online: `make install-tools TOOLS=npm` installs the
# npm of packageManager into var/tools with the copied installer of scripts/kit/bootstrap, then `make install-packages`
# installs package-lock.json with it, @polyspec/kit included. Until then only those two steps run.
KIT := node_modules/@polyspec/kit/dist
KIT_EXT := mjs
ONLINE ?=

ifneq ($(wildcard $(KIT)/kit.mk),)
include $(KIT)/kit.mk
else
ifneq ($(filter-out install-tools install-packages,$(or $(MAKECMDGOALS),the default goal)),)
$(error $(KIT)/kit.mk is missing; run make install-tools TOOLS=npm, then make install-packages)
endif

.PHONY: install-tools
install-tools: ## Install the npm of packageManager into var/tools, before the package is installed; only TOOLS=npm; ONLINE
ifeq ($(TOOLS),npm)
	$(ONLINE) node scripts/kit/bootstrap/bootstrap.mts
else
	@echo "install-tools: only TOOLS=npm runs before the package is installed; run make install-tools TOOLS=npm, then make install-packages" >&2; exit 2
endif
endif

.PHONY: install-packages
# The package-lock pins @polyspec/kit by the URL of its release asset. npm 12 refuses a dependency of a URL unless the project
# opts in; --allow-remote=root allows only the URLs that package.json itself names.
install-packages: ## Install the packages of package-lock.json, @polyspec/kit included, with the npm of var/tools; ONLINE
	$(ONLINE) var/tools/bin/npm ci --allow-remote=root
