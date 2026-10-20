# The bootstrap of kit in a repository: `include scripts/kit/kit-bootstrap.mk` in its Makefile. This file is a copy that
# `make kit-sync` writes from the installed package @polyspec/kit; it includes the kit.mk of KIT, which runs the built tools of
# its dist. The package is installed in two steps, both online: `make install-tools TOOLS=npm` installs the npm of
# packageManager into var/tools with the copied installer of scripts/kit/bootstrap, then `make install-packages` installs
# package-lock.json with it, @polyspec/kit included. Until then only those two steps run.
#
# KIT is the kit of the repository (K348-1). In a development checkout beside the kit checkout ../kit it is the dist of that
# checkout from the first make on, the provider that the link installs (P30), so a fresh worktree reads kit.mk before npm ci and
# installs with the tools of the kit it develops against; a kit checkout that is not built fails. Without it, as in CI, KIT is the
# installed package.
ifneq ($(wildcard ../kit/.git),)
ifeq ($(wildcard ../kit/dist/kit.mk),)
$(error ../kit/dist/kit.mk is missing: the kit checkout beside the repository is not built; run make build in ../kit)
endif
KIT := ../kit/dist
else
KIT := node_modules/@polyspec/kit/dist
endif
KIT_EXT := mjs
ONLINE ?=

ifneq ($(wildcard $(KIT)/kit.mk),)
include $(KIT)/kit.mk
else
# The tools of the two steps, as kit.mk names them: the node of the machine starts the bootstrap, and the npm that it installs
# runs npm ci, by its absolute path (K171). The bootstrap also installs the node of the checkout, which a recipe of the
# repository that install-packages needs starts as $(NODE), as under kit.mk (K185); the other tools come with install-tools.
BOOTSTRAP_NODE := node
NODE := $(CURDIR)/var/tools/bin/node
NPM := $(CURDIR)/var/tools/bin/npm
ifneq ($(filter-out install install-kit install-tools install-packages install-link,$(or $(MAKECMDGOALS),the default goal)),)
$(error $(KIT)/kit.mk is missing; run make install, which runs install-tools TOOLS=npm, install-packages, install-tools and install-link)
endif

.PHONY: install-tools
install-tools: ## Install the npm of packageManager into var/tools, before the package is installed; only TOOLS=npm; ONLINE
ifeq ($(TOOLS),npm)
	$(ONLINE) $(BOOTSTRAP_NODE) scripts/kit/bootstrap/bootstrap.mts
else
	@echo "install-tools: only TOOLS=npm runs before the package is installed; run make install, which runs install-tools TOOLS=npm, install-packages, install-tools and install-link" >&2; exit 2
endif
endif

.PHONY: install-packages
# The package-lock pins @polyspec/kit by the URL of its release asset. npm 12 refuses a dependency of a URL unless the project
# opts in; allow-remote=root allows only the URLs that package.json itself names. npm reads it from npm_config_allow_remote, the
# one source for every npm that installs or changes the lock: npm ci of install-packages, and npm install, npm audit fix and npm
# dedupe of dependency-review UPDATE=1 (K189).
install-packages dependency-review: export npm_config_allow_remote := root
install-packages: ## Install the packages of package-lock.json, @polyspec/kit included, with the npm of var/tools; only installs, never links or builds; ONLINE
	$(ONLINE) $(NPM) ci

# The link of install-link (K360, K360-1, K360-2): it needs the Go of var/tools, which the full install-tools installs, and the
# environments that the steps of the repository install, so make install runs it after all of them. KIT is the kit checkout beside
# the repository when there is one (K348-1), so the link is that of the kit the repository develops against.
.PHONY: install-link
install-link: ## Link the packages to the polyspec checkouts beside the repository, with the node of var/tools, after every install of make install
	$(NODE) $(KIT)/link.$(KIT_EXT) link --siblings

.PHONY: install install-kit
# install runs the bootstrap of kit as its first prerequisite; a repository adds its install steps as later prerequisites
# that depend on install-kit, such as install: <repo>-install and <repo>-install: install-kit (K246-2).
install: install-kit ## Install the tools and packages in the bootstrap order: the npm of packageManager, package-lock.json, then the tools, then the steps of the repository, then the links (K360-2); ONLINE
	$(MAKE) --no-print-directory install-link
install-kit: ## Install the npm of packageManager, the packages of package-lock.json and the tools, in that order; ONLINE
	$(MAKE) --no-print-directory install-tools TOOLS=npm
	$(MAKE) --no-print-directory install-packages
	$(MAKE) --no-print-directory install-tools
