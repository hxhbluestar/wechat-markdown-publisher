# Third-party components

The preserved browser bundles contain third-party code. Their original notices
remain in the distributed files where present. This repository does not claim
authorship of those dependencies or relicense them as project-owned code.

- `markdown-it-py` and `mdurl`: package metadata and license texts are retained
  inside `app/web/vendor/wheels/*.whl`.
- Highlight.js: the existing BSD-3-Clause notice remains in
  `app/web/highlight.min.js`; the upstream license is in `licenses/highlightjs.txt`.
  The local PowerShell, Dockerfile, CMake and LLVM grammar modules are from
  Highlight.js 11.11.1 and retain the same license. The first-party AI/GPU
  extensions build on its Python/C++ grammar objects without replacing them.
- Mermaid and KaTeX: upstream license texts are in `licenses/mermaid.txt` and
  `licenses/katex.txt`.
- MathJax 3.2.2: Apache-2.0. Its pinned `tex-svg.js` component is copied by the
  readable build into `app/web/vendor/mathjax-3.2.2/`; the upstream license text
  is retained beside it as `LICENSE`. Math rendering uses local files.
- Markdown theme styles reference the Doocs Markdown editor ecosystem; its
  upstream license is included in `licenses/doocs-md.txt` for attribution.

The readable application build and test dependencies are explicitly pinned in
`package.json` and `package-lock.json`: esbuild 0.28.2 (MIT), Acorn 8.19.0 (MIT),
eslint-scope 9.1.2 (BSD-2-Clause), LinkeDOM 0.18.12 (ISC), and Prettier 3.9.10
(MIT). Their installed npm packages retain their own notices; the lockfile also
records transitive dependencies. Python HTML/image processing uses Beautiful
Soup and Pillow; their installed distribution metadata retains their notices.

`frontend/vendor/editor-engine-20261018.js` is a pinned renderer/editor runtime
extracted from the previously shipped application, with provenance recorded in
`frontend/vendor/NOTICE.md`. The application entry and new behavior are built
from readable source. This does not reconstruct the complete upstream source
or dependency manifest of that preserved runtime and its diagram chunks.

This list records identified components; it is not a complete SBOM or an audit
of all code inside the preserved bundles. CI's npm audit report covers registry
dependencies identified by the current lockfile and is advisory. Project-owned
code has no blanket license declaration at present.
