# Blog publisher

This public repository contains only trusted publishing code. Blog content, images and sealed artifacts remain in the private `StefanZhang/stefans_blog` repository. Never attach the private release ZIP to an issue or artifact here.

## 人与 LLM 的日常流程

1. LLM 在私有博客仓库创建内容 PR；源码 CI 检查后，由维护者合并。
2. 成功 main CI 上传 `sealed-<run-id>`（保留3天）。本控制仓库每15分钟检查一次最新 main 构建；GitHub schedule 可能延迟，不承诺实时。
3. inspect 下载并校验 GitHub artifact ZIP 摘要、源码 commit、封存 SHA、无迁移缺口和固定目标。它不执行包内脚本，不构建文章或图片。
4. 在 Actions run 的 Summary 中核对 run、commit、hash 与目标，由 Stefan 在 **Review deployments → preview** 人工批准。
5. publish 重新下载同一包、再次检查 main 未变，然后只上传 `release-preview`，逐文件和历史 URL 验收。成功记录为 GitHub Deployment；失败保持红色，不称为上线成功。

手工立即触发（人和获授权的专用 Agent 都可用）：

```sh
gh workflow run publish-preview.yml --repo StefanZhang/blog-publisher --ref main -f build_run_id=latest
# 指定确切成功 main run/hash：
gh workflow run publish-preview.yml --repo StefanZhang/blog-publisher --ref main -f build_run_id=BUILD_RUN_ID -f artifact_hash=ARTIFACT_HASH
```

替换大写占位符再执行。同一 run 不重复发布；确认先前失败原因后使用 `-f retry=true`。构建过期或 main 前进时停止，重建/重新审批。等待人批准期间，后续定时运行受全局 concurrency 限制，不能绕过审批。失败包不会自动回滚；核对上一次成功的预览部署，在维护者授权下回退并重新验收。

## 权限与一次性设置

- main 受保护：PR、成功的 `check`，禁止强推/删除并包含管理员。仅维护者可写本控制仓库；单人维护不要求作者给自己的 PR 做不可能的自我批准，CODEOWNERS仅为审阅路由。
- `preview` Environment：仅 protected branches，StefanZhang 为 required reviewer，禁止管理员 bypass。允许 Stefan 批准自己手动发起的 run；日常 Agent 使用独立身份，不能是 Stefan 的 owner 会话。
- repository secret `SOURCE_READ_TOKEN`：仅私有博客仓库，Actions **Read-only** 和 Contents **Read-only** 的 fine-grained PAT，不含写入、管理或其他仓库。设置到这里，不能设到博客仓库。
- `preview` Environment secrets：`CLOUDFLARE_ACCOUNT_ID`、仅目标账户 **Cloudflare Pages Edit** 的 `CLOUDFLARE_API_TOKEN`。不要使用 Global API Key、GitHub owner OAuth 或临时 Wrangler OAuth 充当长期 CI secret。Pages 权限是账户级，`--branch`不是 IAM 隔离，所以预览也必须人批准。
- 代码维护与日常 LLM 分离：日常 LLM 对本仓库最多只有 Actions read/write，不给 Contents write、Administration、Environment 审批。Actions write 本身不会使非 reviewer 成为审批人。
- 所有 secrets 通过 GitHub 设置界面/受控 CLI 写入，不贴在聊天、issue或日志里。记录 token 到期日，在到期前由维护者轮换并重跑预览。

## 固定策略与升级

`policy.json` 固定来源仓库/工作流、目标、配置及四个控制文件的 SHA。普通文章新增和图片更新自动沿用；若模板/规则/边缘处理导致 `_worker.js`、`_routes.json`、`_redirects` 或 `_headers` 改变，发布会失败，维护者须单独审阅并更新策略。不能从待发布包自动学习新 hash。

Node 固定 `.nvmrc`；Actions固定commit SHA；Wrangler固定4.45.0。更新通过本控制仓库PR及其测试进行。可信 verifier 来自博客已审阅提交34adb9d；在这里独立维护，不从待发布包加载代码。

本入口只做演示站静态验收。点赞/阅读量、D1、Artalk、生产审批和DNS切换不在本轮自动化中。正式发布将来必须以同一包的完整服务验收和独立人工批准为前提，不能把本入口的 static receipt 当作 full receipt。
