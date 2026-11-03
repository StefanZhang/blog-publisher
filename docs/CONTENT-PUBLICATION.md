# 一次合并，自动发布两站

这是 2026-11-02 用户明确批准的新日常流程；旧文档中“每次 preview/production 人工审批”仍适用于**代码/配置/服务维护**，不适用于启用后的纯内容入口。

## 日常维护者和 LLM

1. LLM 在私库 `StefanZhang/stefans_blog` 创建分支、修改正文 HTML 和新增本地源图片、提交 PR；不直接推 main，不改发布器，不持有部署、SSH、DNS、D1 或 owner 凭据。
2. 两份 PR CI 都通过后，**Stefan 本人确认内容并 squash merge 或 merge commit**。不使用 rebase merge。GitHub 证据能确认账号身份，不能确认操作账号的是人还是 agent；因此不能把 Stefan 的 owner token 交给日常 LLM。
3. main CI 从同一个源码 commit 分别构建 `.com` 和 `.cn` 封存包。两包目标域不同，不是一个 ZIP 改域；两份完整检查和私有 Release 归档都成功才有资格发布。
4. `publish-content-dual` 每15分钟检查一次；GitHub schedule 可能延迟。无变化退出，不要求每天点审批。受保护的固定发布器检查人类合并证据、整棵非内容源码树的固定摘要、私有包 SHA、工具链、控制文件、两包 commit 和文章 ID 集合。
5. 如有新文章 ID，先以固定已审阅 Worker 代码更新 known-ids（不改 SALT、数据库、schema、路由、定时清理）；ID 不变则不上传 Worker。之后分别做两包固定预览和 alias 的完整资源/历史路径验收、noindex 和互动服务检查。
6. 上传原 `.com` 封存包到 Pages main，逐文件检查；通过后把 `.cn` 固定预览、manifest、来源和 hash 交给香港接收器。接收器等待整个发布 run 成功，匿名取回并验证文件，原子切换站点目录。无 SSH 发布密钥。
7. 独立的 `CN installation identity` 工作流等待香港安装身份，再逐文件检查两站、历史/query URL 和互动服务；查看 `dual-online-<run>` 回执 `passed=true` 才表示本次两目标验收成功。

自动流程不会向 GitHub “代点批准”。它使用单独的 `content-auto` Environment：仅受保护 main，禁止管理员 bypass，无 required reviewer。原 `preview` / `production` 人工审批环境保持原样。合并 PR 是日常的人类发布决定。

## 当前接入状态与边界

`content-policy.json.enabled` 是唯一启用开关；为 false 时不发布。首次启用前须完成下述接入验收。`.com` 正式 DNS 尚未切换时，`comVerificationBase` 必须是 `https://stefanzhang-com.pages.dev`，回执 `formalCOMVerified=false`；不能称正式 `.com` 已更新。正式切域需独立备份/回退/验收，随后经 PR 把该字段改为正式域。`.cn` 使用现有香港入口，不改 DNS。

纯内容允许修改 `src/content/posts/<数字ID>.md`、`src/content/notes/note-<数字>.md`，新增 `assets/uploads/` 内光栅图片。禁止删除/改名历史文章、覆盖已有源图、SVG、可执行内容文件、symlink。换图使用新文件名。新增分类/标签、组件、脚本、锁文件、样式、配置等都走维护 PR。图片和 HTML 仍必须通过现有解码、净化、迁移/资源/语义检查；文件路径白名单不是恶意 agent 沙箱。

从最近一次固定维护基线到待发布源码的每个 first-parent 变化，都必须有指定账号合并的纯内容 PR；直接 main 推送、机器人合并或混入代码均拒绝。最多连续50次内容合并后需要维护者审阅新基线。维护 PR 合并后，自动流程阻断，维护者在 publisher PR 更新 `baselineCommit`、非内容树摘要和有关源码/控制 hash，不能自动信任新 main。

## 一次性接入（只能由维护者）

1. 源库 CI 合并凭证脚本经 PR/main CI 通过；publisher 固定该源码版本的工作流/程序 SHA 和完整非内容树身份。源码 CI 使用临时 `pull-requests:read` 收集证据，无部署 secret；发布器现有私库 token 仍只有 Contents/Actions read。
2. 建立 `content-auto` main-only 环境，不改旧审批环境；把该环境 API 返回的**公钥**固定在 `content-secret-recipient.json`，不提交任何秘密。
3. 合并 publisher PR，通过精确 main CI。运行 `bootstrap-content-secrets.yml`，由人批准现有 preview 环境。GitHub 内部使用 libsodium sealed box 把三项现有 CF 配置加密到固定的 content-auto GitHub 公钥，只导出密文（保留1天）。维护者核对精确 run/commit/attempt、公钥未变，用 GitHub owner CLI 提交 `encrypted_value` 和 `key_id` 到对应环境的三个 secret。不得解密、打印明文或把 owner 凭据交给 CI。
4. 从 GitHub 下载已通过精确 main push CI 的 `deploy/hk` 源码，运行 `upgrade.py --package <目录> --previous <当前安装40位SHA> --commit <新40位SHA> --ci-run <成功run>` 做只读验证，再加 `--apply`。入口复核 Git blob、main 祖先和 CI，持同一站点锁、备份/CAS替换固定 systemd service 路径；保留网站指针、Nginx、监控、证书、timer 启用状态和旧程序目录。失败恢复旧 unit；版本目录已存在或 receiver 忙时拒绝，不用手工覆盖绕过。
5. 验证节点新 service 路径、timer、站点/监控未变，环境只含约定 secret 名称；经 publisher PR 设置 enabled=true，CI 通过后合并。首次真实纯内容 PR 由 Stefan 在网页合并，验证全链路线上回执。没有真实发布样本前，仅能声称代码/接入检查完成。
6. 一次性 secret bootstrap 完成后禁用该 workflow；密钥轮换时由维护者按同样审批流程临时启用。密文 artifact 不含博客内容，只有 GitHub 持有解密私钥。

## 失败、部分完成与回退

两目标不是跨云原子事务。Pages 更新成功而香港安装失败时，Pages 可能已新、香港仍旧；最终线上验收必须红灯，不能宣称“一次更新两站成功”。不自动回退用户内容、删除旧包或覆盖历史评论。Worker ID 已更新而预览失败时，保留新增白名单不影响旧文章。

`dual-request` Deployment 是防重复尝试账本；queued/in_progress 不代表线上完成，最终以独立线上工作流及回执为准。失败后不每15分钟重试写入；维护者检查失败阶段、两站实际来源及回执后，可执行：

```sh
gh workflow run publish-content.yml -R StefanZhang/blog-publisher --ref main -f retry=true
```

只重试当前 main，重新下载原封存包并重新验收，不重建。新 main 到来时拒绝旧提升；多个内容合并可合并为最新 commit 一次发布。发布期间维护者不要同时合并代码基线/发布器升级，否则精确版本检查会停止。代码维护继续使用原人工审批 `publish-production.yml` / `publish-preview.yml` / `deploy-likes.yml`。

关闭自动化：通过 reviewed PR 把 enabled 设为 false（紧急停止可由维护者先禁用 workflow，随后记录）；不会改已上线站点。恢复节点旧 unit 使用升级备份和精确 CAS，经维护授权执行，不改网站内容指针。回退网站版本仍使用既有已封存、已验证版本的维护流程。

## 接入证据与只读连通验收

- 源库 PR #11 已合并为 `ce9ea98d19b699f9e95519eae8faedefdb741ee8`；publisher PR #13 合并为 `05b791edc0d49771084634cc3d4e831e1dfad850`，精确 main CI `41531876155` 成功。
- 香港节点已通过固定升级入口安装 `05b791e`；备份 `/var/backups/stefanzhang-cn/upgrade-05b791edc0d4-20261102T215404059797Z`。站点 active 指针、Nginx/health/timer 摘要与升级前一致，发布与监控 timer 均 active。
- 人工批准的凭据迁移 run `41532234250` 成功；三个环境 secret 名称已核对，一次性 bootstrap workflow 已禁用。密钥明文没有离开 GitHub runner。
- 启用前在精确 main CI 成功后运行以下只读集成检查；它使用真实 environment credentials，但只有 GET 和私有归档下载，不调用部署接口。成功不能冒充真实内容发布验收。

```sh
gh workflow run publish-content.yml -R StefanZhang/blog-publisher --ref main -f readiness_only=true
```

### GitHub 定时触发的边界

定时任务可能延迟；[GitHub 官方规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)还规定，公开仓库60天没有活动时会停用 scheduled workflows。不能把私库文章更新视为公开 publisher 的可靠保活证据，也不能承诺定时器永久运行。维护者需关注 GitHub 的停用通知；若被停用，检查原因后 `gh workflow enable publish-content.yml -R StefanZhang/blog-publisher`，再手动触发同一受门禁保护的入口。此版本不为保活额外授予源码 CI 跨库写权限、不制造空提交；若后续要求消除这个运营依赖，应单独审阅事件驱动触发权限与凭据，而非暗中扩大文章 agent 权限。


## 启用验收（2026-11-02）

- 源 main `ce9ea98` 的 CN CI/私有归档 `41531650556`、COM CI/私有归档 `41531650316` 均成功。
- 只读集成 run [41534117764](https://github.com/StefanZhang/blog-publisher/actions/runs/41534117764) 成功：两个真实归档及合并凭证、固定源码策略、Pages 项目/主分支、Worker 版本和124个现有 ID 健康全部通过；部署/DNS写入为0。
- 在上述证据完成后通过独立 PR 将 enabled 设为 true；源 baseline 本身不是新的内容 PR，启用不会凭空重发维护版本。以后本人合并纯内容 PR 后，等待两目标 CI/归档与定时发现，不再点 preview/production。
- 正式 `.com` DNS 已切到 Pages，`comVerificationBase` 已经 reviewed PR 改为正式域；`.cn` 同一维护源码已安装。切换、失败项与回退记录见 [COM-2026-11-02](cutovers/COM-2026-11-02.md)。第一条真实内容 PR #12 已由 Stefan 本人合并为 `2ba81cd`；自然 schedule run `41570766257` 完成双站自动发布，独立 run `41578061932` 各验3319文件/1117历史query、0失败且formalCOMVerified=true。此前超时失败与后续修复保留在 LOSSLESS-DELIVERY.md；日常链路已获该版本的完整实证，后续版本仍须重新验收。
