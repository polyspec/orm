<!-- doc-id: docs-development -->
# Documentation build and deployment

The online documentation is at [polyspec.github.io/orm](https://polyspec.github.io/orm/). VitePress reads `docs/*.md` and nested Markdown files directly. No copied documentation tree is used. The component diagram is generated from `contracts/interfaces.json`.

## Local execution

Use the Node.js release of `.node-version` (26.8.1) and npm. The local checks and every GitHub Actions workflow run that one release, and `make repo-check` fails on another. `package-lock.json` fixes tool versions. The TypeScript client supports the lowest release of `engines.node` in `package.json` (22.16.0), on which `make ts-min-check` runs its tests.

```sh
make install
make docs-dev
```

Open `/orm/` on the development server. The page shows a changed Mermaid block when it reloads.

## Static build and checks

```sh
make docs-check
make docs-verify-idempotent
```

`docs-check` builds the site and checks the output. `docs-verify-idempotent` builds twice from the same inputs and compares every output byte. The build and the checks run on Node.js alone and need no browser.

The check reads each HTML file of the output. Every Markdown page has its HTML page, every internal link, stylesheet, image and script path names a file of the output, every anchor names an id of its page, and the Mermaid blocks are in the pages as their sources. A missing path or anchor is an error. Repository source and error catalog links point to actual GitHub files.

The output is `docs/.vitepress/dist`. The deployment contains HTML, CSS, JavaScript, and the search index. It needs no server program. Each Mermaid block is published as its source, and the theme draws it as an SVG with `mermaid` in the browser of the reader. The body and the Mermaid sources are readable without JavaScript; diagrams, search, theme, and mobile menu use JavaScript.

The default base is `/orm/`. When hosting at a domain root, run the build and checks with the same base.

```sh
VITEPRESS_BASE=/ make docs-check
```

## GitHub Pages

The [documentation deployment workflow](../.github/workflows/docs-pages.yml) builds the static output and deploys it to Pages after pushes to `main` and manual runs. The documentation checks (`make docs-ci`: the idempotence check and `docs-check`) run in the `docs` job of the [CI workflow](../.github/workflows/ci.yml) on every pull request and merge group, which `main` requires. Pages uses **GitHub Actions** as its build method.

The `build` job uploads `docs/.vitepress/dist` as the Pages artifact, and the `deploy` job publishes it to the `github-pages` environment. The deployment URL and run results are available in [Actions](https://github.com/polyspec/orm/actions/workflows/docs-pages.yml).

## Synchronization after specification changes

When the specification changes, update native code, symbols, and generated diagrams according to the [automated check guide](../tests/interfaces/README.md). Update the guide, implementation matrix, and checklist, then run `make docs-check` to check links and static output. Commit Markdown, configuration, and checkers. Do not commit `dist` or caches.
