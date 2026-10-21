# Third-party notices

The staged Desktop plugin embeds the prebuilt browser viewer distributed by
`molstar@5.13.1`. Mol* is licensed under the MIT License; the full upstream
license is included as `third_party/molstar-LICENSE.txt` in the staged package.

The upstream `molstar.js` distribution retains its own bundled license comments,
including notices for React, Immutable.js, and embedded numerical/rendering
components. Those comments are preserved verbatim by this build (esbuild is
configured with `legalComments: inline`). No Mol* source-map or CDN asset is
required at runtime.

Package metadata and exact dependency resolution are recorded in
`package-lock.json`. The upstream prebuilt `molstar.js` and `molstar.css` plus
the repository's small frame bridge are compressed into the self-contained
viewer document; build tooling and the Node dependency tree are not shipped as
executable plugin files.
