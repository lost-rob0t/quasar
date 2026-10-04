# Canonical Common Lisp consumer

The standalone canonical validation subset is vendored from local star-cl commit
`b70b9f7ea3d6e464855f17f881422f18c29845e0`, stacked on public PR #17.
This local migration commit is not yet published; publication remains gated.
The source includes persistent-only inventory, operation semantics, and the
injective typed-map rule, all checked against locked authority fixtures.

Generated release authority is local star-lang commit
`d6ca8780845c4296f64ac8e65aaa9db143842460`, stacked on public PR #197.
Run `python3 bin/sync-starintel-schema.py --source /path/to/star-lang` here to
verify exact upstream commit bytes. Without --source the commit must first be
published. Never hand-edit generated contracts or claim remote availability
from this local draft. Historical v090 mechanics are explicit compatibility;
new Quasar writes require canonical generated validation.
