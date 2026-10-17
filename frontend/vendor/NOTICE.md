# Pinned editor runtime

`editor-engine-20261018.js` preserves the CodeMirror, Markdown, CSS-inlining and
diagram loader runtime from the previously shipped `index-20261017-scroll.js`
at product commit `d7ca3b9`. The application entry, saving, state, asset URL
handling and typography export adapter now live in readable `frontend/` files.
New application behavior must be added there and rebuilt with esbuild, without
patching minified symbols. The original shipped bundle and diagram chunks remain
available for provenance and rollback.

This is a pinned bundled dependency, not reconstructed upstream source. See
`THIRD_PARTY_NOTICES.md` and `licenses/` in the public distribution (maintained
under `publication/` in the private source checkout) for upstream attribution
and licenses. The runtime retains its original third-party license comments.
