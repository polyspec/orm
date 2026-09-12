# Documentation build and deployment

The online documentation is at [polyspec.github.io/orm](https://polyspec.github.io/orm/). VitePress reads `docs/*.md` and nested Markdown files directly. No copied documentation tree is used. The component diagram is generated from `contracts/interfaces.json`.

## Local execution

Use Node.js 22.12 or newer and npm. `package-lock.json` fixes tool versions.

```sh
npm ci
npx playwright install chromium
make docs-dev
```

Open `/orm/` on the development server. Restart the server after changing a Mermaid block to regenerate SVG files.

## Static build and checks

```sh
make docs-check
VITEPRESS_BASE=/orm/ make docs-static-check
make docs-verify-idempotent
```

`docs-check` renders Mermaid as SVG, builds the site, and runs the static checks. `docs-static-check` checks the existing `docs/.vitepress/dist`. `docs-verify-idempotent` builds twice from the same inputs and compares every output byte.

The static check opens each HTML file through a plain file server. It checks internal links, anchors, image and script paths, no-JavaScript content and diagrams, search, and the mobile menu. It does not use an application fallback for missing paths. Repository source and error catalog links point to actual GitHub files.

The output is `docs/.vitepress/dist`. The deployment contains HTML, CSS, JavaScript, the search index, and SVG files. It does not require a server application or a runtime Mermaid service. The body and diagrams are readable without JavaScript; search, theme, and mobile menu use JavaScript.

The default base is `/orm/`. When hosting at a domain root, run the build and checks with the same base.

```sh
VITEPRESS_BASE=/ make docs-check
```

## GitHub Pages

The [documentation deployment workflow](../.github/workflows/docs-pages.yml) deploys the checked static output to Pages after pushes to `main` and manual runs. Pull requests run the same build and checks. Pages uses **GitHub Actions** as its build method.

The `build` job uploads `docs/.vitepress/dist` as the Pages artifact, and the `deploy` job publishes it to the `github-pages` environment. The deployment URL and run results are available in [Actions](https://github.com/polyspec/orm/actions/workflows/docs-pages.yml).

## Synchronization after specification changes

When the specification changes, update native code, symbols, and generated diagrams according to the [automated check guide](../tests/interfaces/README.md). Update the guide, implementation matrix, and checklist, then run `make docs-check` to check links and static output. Commit Markdown, configuration, and checkers. Do not commit `dist`, intermediate SVG files, or caches.
