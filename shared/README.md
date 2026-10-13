# Shared protocol

Shared ESM schemas and signing primitives in `index.js`; no Node-specific imports.

- `WorkRequest`: intent, base commit, workspace, optional ID/revision and target branch.
- `CheckpointInput`: one exact file snapshot, create/modify/delete operation, base/result SHA-256, intent revision, workspace and base commit. The server verifies content hashes.
- `RespondInput`: ack, overlap, decision proposal/acceptance and checkpoint handoff offer/acceptance.
- `GitUpload`: exact commit and file manifest; hashes cover blob bytes and modes. Renames are delete/create pairs.
- `CheckPolicy`: administrator-only pinned Docker image, argv, limits and approval policy. Manual approval is the default.
- `CheckResult`: exact target/candidate/policy/image tuple and passed/failed/timeout/error outcome. Approval responses identify this exact tuple.
- `CommitUploadEnvelope`: signed upload manifest plus detached canonical-base64 bundle (4 MiB decoded maximum). The signed `bundle_hash` binds these bytes; strip the attachment before signature verification.
- `signEnvelope` / `verifyEnvelope`: Ed25519 over canonical `{event_id, run_id, payload}`. Keys are JWKs (or WebCrypto `CryptoKey`s); signatures are base64.
- `generateKeyPair`: returns `{publicKey, privateKey}` JWKs. Keep private keys local.
- `hashBytes`: SHA-256 for exact binary blobs/bundles; `hashContent` uses UTF-8 text.
- `parseInput`: validation errors use `ProtocolError` with stable `code`, `status` and optional details.

Summary-only sharing rejects raw prompts/context. Intent files are concrete repository-relative paths; wildcards, traversal and `.git` are rejected. Server policy separately protects secrets, databases and privileged files. Administrator run scopes retain permission globs.
