%%% Canonical wire + JSON conventions learned landing the CoW and
%%% python-actor worktrees (2026-11-03).

kb_topic(canonical_wire, "StarIntel 0.10.1 canonical document rules in quasar").
kb_topic(jsown_wire, "jsown encode/decode boolean and keyword conventions").
kb_topic(pathname_merge, "Common Lisp merge-pathnames directory trap").

%%% starintel.canonical:validate-document (vendor/star-cl v0101) is strict:
%%% schemaVersion must equal the locked release ("0.10.1"), camelCase keys,
%%% closed field sets (undeclared fields reject with document.invalid).
%%% Legacy v0.9 producer output (_id, schema_version, data.* wrapper) is
%%% NOT accepted by the canonical validator; the python fleet emits legacy
%%% until each producer migrates (see starintel-pro-actors
%%% starintel_release.py). quasar paths that ingest external documents must
%%% require canonical input (melissa entity.lisp precedent) -- never relabel.

canonical_test_fixture(make_doc_helper, "control-plane/tests: make-doc builds a valid canonical person (id/dtype/dataset/schemaVersion 0.10.1). Reuse it instead of hand-building documents.").
canonical_test_fixture(base_fields, "Base document declares notes, sources, createdAt, updatedAt, tags...; person declares fullName/fname/lname but NOT name; observation declares observationType/observerId/observedProperty/value (value is any).").
canonical_test_fixture(target_fields, "Target declares actor+target required; options is a MAP (object), not an array of {key,value} pairs.").

%%% jsown: to-json maps :true/:false keywords to JSON true/false literals,
%%% but jsown:parse maps JSON true/false to Lisp T/NIL. quasar.protocol:decode
%%% yields :true keywords. Tests that parse wire strings with jsown:parse must
%%% assert booleans by truthiness, not (eq :true ...).

jsown_wire_rule(encode, "(:obj (\"flag\" . :true)) encodes as {\"flag\": true}.").
jsown_wire_rule(decode, "jsown:parse of true yields T; (eq :true (jsown:val o \"flag\")) is always NIL over the wire.").
jsown_wire_rule(array_tag, "quasar.protocol:json-array tags (:array ...); jsown:to-json alone serializes it as [\"ARRAY\",...] -- always encode through quasar.protocol:encode, which strips the tag.").
jsown_wire_rule(missing_key, "quasar.protocol:json-value swallows jsown:val errors and returns the default (NIL) -- a NIL boolean check may mean the key was absent, not false.").

%%% (merge-pathnames "sub/" (parse-namestring "/a/b")) keeps the defaults'
%%% NAME ("b"), producing /a/b/sub/b. Environment-provided paths need
%%% uiop:pathname-directory-pathname normalization (python-actors-checkout
%%% bug: the default ~/starintel/starintel-pro-actors checkout never resolved).

pathname_merge_rule(trailing_slash, "parse-namestring without a trailing slash yields a FILE pathname; merge-pathnames then appends the old name to the result.").
pathname_merge_rule(fix_pattern, "Normalize with (uiop:pathname-directory-pathname path) before merging relative subpaths onto env-derived paths.").

%%% scripts/test-lisp honors QUASAR_TEST_EVAL to replace (asdf:test-system
%%% :quasar-tests) with an arbitrary form -- use it for targeted probes with
%%% the full system already loaded. The test source registry excludes
%%% ~/quicklisp/local-projects and includes vendor/star-cl; ASDF asserts the
%%% checkout identity of every quasar system.

tooling(test_lisp_eval_hook, "QUASAR_TEST_EVAL='<form>' nix develop --command npm run test:lisp runs a single probe with systems loaded.").
