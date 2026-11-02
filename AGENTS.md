# Publisher maintenance

This is a trusted deployment controller, not the blog source repository. Daily content agents have no Contents write permission here and never receive Cloudflare credentials. Bootstrap owner identity is only for this user-authorized setup.

Do not add private blog content, pictures, ZIPs, receipts containing site content, or secret files. Do not run scripts supplied by an artifact. Upload only `site/` after trusted seal and control-file checks. Keep all Actions and Wrangler versions pinned. Keep preview human approval and protected main enforced; .com production/DNS and independent services are out of scope. The owner-authorized .cn static delivery is handed off only after the existing preview approval and verification.

Changes to policy or workflows require a dedicated reviewed PR. Run npm test, Python ZIP tests and actionlint. Never update control hashes automatically from an unreviewed release. A successful build is not a successful deployment; verify the published bytes and all historical paths.

CN handoff uses only fixed-schema public metadata in a cn-pilot Deployment. Keep preview receipt schema 2 compatible. Never copy private content/ZIPs to this repository or run artifact scripts. A Deployment success is readiness only: the VPS consumer must require the entire controller run completed/success and match attempt/commit/main/workflow before installation. No new secrets, SSH credentials, workflow Environment or contents:write permission for this handoff.

## User-authorized automatic content exception (2026-11-02)

Follow docs/CONTENT-PUBLICATION.md. The explicit user decision authorizes a separate content-auto environment and automatic paired publication only after Stefan personally merges a pure-content PR. Preserve manual preview/production reviewer rules for maintenance. Do not simulate human approval/merge using the daily agent. The publisher may deploy pinned likes code with new known-ids only, preserving all other service state. Upgrade the HK receiver only through the GitHub-verified upgrade entry, never hotpatch the node. Keep formal DNS cutover separate. enabled=false means staged, not live.
