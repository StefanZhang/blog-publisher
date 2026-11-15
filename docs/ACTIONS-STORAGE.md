# Release candidates and Actions storage

Ordinary source pushes and pull requests run the existing builds and checks without uploading a complete site. A source candidate is either a manual main-branch build or a content-only PR merge whose authenticated merge chain belongs to StefanZhang (user ID 10293941). The latter preserves the existing automatic paired content-publication flow; the publisher still verifies the maintained code-tree baseline and all merge evidence before deployment.

The two source workflows keep their identities and target separation:

- `.github/workflows/deploy.yml`: `.cn` candidate.
- `.github/workflows/build-production.yml`: `.com` candidate.

`latest` selects a successful current-main run with a successful archive job. A successful test-only run is not a candidate. Explicit run IDs and subsequent private-archive download retain all existing identity, tag, digest, seal, control-file and approval checks. Source maintenance requires reviewing both workflow hashes and refreshing the content baseline through a dedicated publisher PR.

Complete candidates are still archived in the private source repository's Releases before publisher use. Actions ZIPs are temporary transport, retained for three days; normal passing reading checks retain only `results.json`, with PNG diagnostics retained on failure. No full site is uploaded to this public controller. Diagnostic attachment uploads are best-effort and isolated build failures retain a bounded log excerpt in the job log, so quota refresh delays cannot hide the underlying test failure. The formal sealed upload and private archive remain mandatory.

Before removing temporary Actions ZIPs, verify the exact private archive and source run/attempt/commit, download and hash-check it, and exclude any pending consumer relying on an Actions download. Preserve private Releases and deployment receipts. Existing `.com` platform rollback and `.cn` node rollback remain the recovery mechanisms; an old Actions ZIP is not permission to promote a stale source commit.

Storage already accrued in the billing cycle is not refunded by deleting artifacts. Cleanup stops future storage accrual for the deleted temporary copies.
