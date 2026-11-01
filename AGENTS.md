# Publisher maintenance

This is a trusted deployment controller, not the blog source repository. Daily content agents have no Contents write permission here and never receive Cloudflare credentials. Bootstrap owner identity is only for this user-authorized setup.

Do not add private blog content, pictures, ZIPs, receipts containing site content, or secret files. Do not run scripts supplied by an artifact. Upload only `site/` after trusted seal and control-file checks. Keep all Actions and Wrangler versions pinned. Keep preview human approval and protected main enforced; production/DNS are out of scope.

Changes to policy or workflows require a dedicated reviewed PR. Run npm test, Python ZIP tests and actionlint. Never update control hashes automatically from an unreviewed release. A successful build is not a successful deployment; verify the published bytes and all historical paths.
