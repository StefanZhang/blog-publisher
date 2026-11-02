# Blog publisher

This public repository contains only trusted publishing code. Blog content, images and sealed artifacts remain in the private `StefanZhang/stefans_blog` repository. Never attach the private release ZIP to an issue or artifact here.

## 人与 LLM 的日常流程

1. LLM 在私有博客仓库创建内容 PR；源码 CI 检查后，由维护者合并。
2. 成功 main CI 上传临时artifact（3天）并将原ZIP长期保存到私有Release `sealed-<run-id>-<attempt>`；归档job失败则整个run失败。本控制仓库每15分钟检查一次最新 main 构建；GitHub schedule 可能延迟，不承诺实时。
3. inspect 只读私有Release，核对tag/run/attempt/commit并下载校验原ZIP摘要、源码 commit、封存 SHA、无迁移缺口和固定目标。它不执行包内脚本，不构建文章或图片。
4. 在 Actions run 的 Summary 中核对 run、commit、hash 与目标，由 Stefan 在 **Review deployments → preview** 人工批准；这次批准涵盖预览验收成功后对公开 `.cn` 的更新交接。
5. publish 重新下载同一包、再次检查 main 未变，上传 `release-preview`，对固定部署URL和别名分别逐文件、历史URL及noindex验收，并上传兼容 schema 2 的无内容 preview receipt。
6. 可信 `cn-handoff.mjs` 重新校验封存包、两个URL回执和交付manifest，创建 `environment=cn-pilot` 的 GitHub Deployment元数据及success状态。它不向VPS推送，也不携带SSH或新的Secret。
7. 香港端匿名读取该元数据，等整个publisher run **completed/success** 且attempt/commit/main/workflow身份吻合后，下载固定URL上的完整静态文件并独立验收、切换。handoff成功不证明VPS已安装；以VPS安装回执和 `.cn` 实际验收为准。

手工立即触发（维护者使用；日常Agent默认等待轮询，无需本仓库写权限）：

```sh
gh workflow run publish-preview.yml --repo StefanZhang/blog-publisher --ref main -f build_run_id=latest
# 指定确切成功 main run/hash：
gh workflow run publish-preview.yml --repo StefanZhang/blog-publisher --ref main -f build_run_id=BUILD_RUN_ID -f artifact_hash=ARTIFACT_HASH
```

替换大写占位符再执行。同一 run 不重复发布；确认先前失败原因后使用 `-f retry=true`。私有归档缺失或 main 前进时停止；重新检查原因并审批，不为恢复旧版本临时重建。等待人批准期间，后续定时运行受全局 concurrency 限制，不能绕过审批。失败包不会自动回滚；核对上一次成功的预览部署，在维护者授权下回退并重新验收。

## 权限与一次性设置

- main 受保护：PR、成功的 `check`，禁止强推/删除并包含管理员。仅维护者可写本控制仓库；单人维护不要求作者给自己的 PR 做不可能的自我批准，CODEOWNERS仅为审阅路由。
- `preview` Environment：仅 protected branches，StefanZhang 为 required reviewer，禁止管理员 bypass。允许 Stefan 批准自己手动发起的 run；日常 Agent 使用独立身份，不能是 Stefan 的 owner 会话。
- repository secret `SOURCE_READ_TOKEN`：仅私有博客仓库，Actions **Read-only** 和 Contents **Read-only** 的 fine-grained PAT，不含写入、管理或其他仓库。设置到这里，不能设到博客仓库。
- `preview` Environment secrets：`CLOUDFLARE_ACCOUNT_ID`、仅目标账户 **Cloudflare Pages Edit** 的 `CLOUDFLARE_API_TOKEN`。不要使用 Global API Key、GitHub owner OAuth 或临时 Wrangler OAuth 充当长期 CI secret。Pages 权限是账户级，`--branch`不是 IAM 隔离，所以预览也必须人批准。
- 代码维护与日常 LLM 分离：默认日常Agent对本仓库没有Actions/Contents写权限，轮询已能请求preview。若另行授权独立bot触发，必须验证它不是required reviewer；不要把Stefan本人签发的Actions-write PAT交给Agent，它仍代表Stefan，不能靠token名称或窄权限宣称无法审批。推荐独立App/bot只限私有源码库，日常Agent不持有owner会话。
- 所有 secrets 通过 GitHub 设置界面/受控 CLI 写入，不贴在聊天、issue或日志里。记录 token 到期日，在到期前由维护者轮换并重跑预览。

## 固定策略与升级

`policy.json` 固定来源仓库/工作流、目标、配置及四个控制文件的 SHA。普通文章新增和图片更新自动沿用；若模板/规则/边缘处理导致 `_worker.js`、`_routes.json`、`_redirects` 或 `_headers` 改变，发布会失败，维护者须单独审阅并更新策略。不能从待发布包自动学习新 hash。

Node 固定 `.nvmrc`；Actions固定commit SHA；Wrangler固定4.45.0。更新通过本控制仓库PR及其测试进行。可信 verifier 与交付manifest校验器在这里独立维护；不从待发布包加载代码。

本入口做Pages预览静态验收与公开 `.cn` 静态更新交接；`.com`、DNS和独立点赞/阅读量/D1/Artalk服务不由此入口修改。`cn-pilot` 是交接记录，不是新增的workflow Environment审批或Secret容器；仍由已有preview人工审批约束。不能把本入口的static receipt当作full服务验收。

## 发布审计护栏

工作流会拒绝已过期的控制仓库版本和管理员bypass，独立取回源码中的编码脚本、锁文件、Node版本和CI工作流并核对固定SHA。这样，日常内容/图片新增可以继续发布；编码器或构建工具链升级必须先审阅旧immutable资源兼容性，不能静默替换相同URL的字节。

成功发布后仅上传无内容的JSON回执（必须同时具备fixed+alias同包成功证据）（run/commit/hash/deployment URL/文件与旧链接数量），保留90天；不上传私有站点包或源码。这不能替代封存包长期备份。

Pages部署元数据显式使用已批准的博客源码commit与CI run，控制仓库commit另记回执；否则Wrangler会把控制仓库HEAD误显示成站点源码。当前分支修复须在下一次实际preview后核对Cloudflare Source字段。

验收失败会记录期望/实际长度与SHA，不打印网页内容。首次发布若失败，先保留失败日志并对固定部署和别名重新完整验收；确认同一包匹配后可重跑失败job，最终仍须完整验收0失败才生成成功回执。不要从一次已消失的差异直接推断缓存或传播机制。


## 保护查询的真实权限范围

真实PR CI已经验证：自带contents:read token不能查询完整branchProtectionRule/管理专用REST保护接口。现在使用refUpdateRule与branch状态核对可信check(app15368)、对everyone强制、禁强推/删除，环境只允许精确的Stefan User reviewer/protected branches且禁止bypass。发布inspect/stage另用checks:read要求当前controller SHA已有成功可信check，不以“protected=true”冒充这些证据。

管理员专属strict及完整bypass配置仍需维护者审计，不宣称全部保护字段自动覆盖；不为查询新增admin secret。单人仓库required review count仍可为0；日常Agent不持有owner身份。

## 私有归档与恢复

只有私有源码main构建之后的独立archive job有Contents:write / Actions:read，用户已明确批准；public publisher仅使用既有SOURCE_READ_TOKEN读取Release，不新增写入私库或归档凭据。Release先draft，原ZIP与archive.json上传后实际下载比SHA才发布；run_attempt隔离重跑，冲突不覆盖。归档不受Actions三天期限影响，但不是不可删除/异地备份。

人工恢复时，从可信部署回执确认run/attempt/hash，在仓库之外的新下载目录取得两资产：

```sh
gh release download "sealed-${RUN}-${ATTEMPT}" --repo StefanZhang/stefans_blog --pattern "sealed-${RUN}.zip" --pattern archive.json --dir "$DOWNLOAD_DIR"
node scripts/restore.mjs "$DOWNLOAD_DIR" "$RESTORE_DIR" "$ARTIFACT_HASH"
```

所有变量须替换为实际值，目录用绝对路径，RESTORE_DIR不得存在或处于Git工作树。restore核对ZIP SHA、数据型安全解包、site seal、source commit和辅助验收URL；不会执行包内脚本或部署。随后在私有源码checkout用其scripts/release/serve.mjs启动恢复包，另在publisher运行scripts/release/verify.mjs --local验收。公开仓库中不得保存完整ZIP。

正常发布仍只接受current main；此工具不是一键线上回滚。失败上传仍可能已更新别名，须保留失败证据并由维护者按已验证包处理，不能伪造success或绕开current-main。.com production/DNS仍不启用；.cn回退也不能通过放宽这些门禁伪装成日常更新。


## .cn 交接协议与失败边界

`cn-pilot` Deployment payload仅有schema 1的固定字段：artifactHash、sourceCommit/sourceRun、controllerCommit/controllerRun/controllerAttempt、固定deploymentURL、manifest的path/bytes/sha256以及两个origin。它不含正文、图片、完整文件清单、私有ZIP地址或凭据。`/_delivery/manifest.json`自身随sealed site发布，最大8MiB；可信校验器拒绝额外字段、私有/危险路径、未绑定跳转参数，要求manifest文件集合与封存文件集合完全一致（排除四个Pages控制文件和manifest自身），并核对headers SHA。

工作流先完成fixed+alias验收并上传旧schema 2回执，再发交接信号，最后执行finish。即使信号的status已是success，后续finish失败或run被取消时，香港端也必须拒绝。consumer至少同时核验：仓库、main、`.github/workflows/publish-preview.yml`、controllerCommit、run attempt、整个run completed/success、Deployment sha/ref及payload严格schema；不能用一个Deployment success替代这些条件。GitHub API创建的Deployment允许app:null，不通过伪造非空App字段建立信任。

状态使用auto_inactive=false保留上次成功信号；旧信号不是无条件回滚授权。manifest下载必须使用payload中的固定deploymentURL，不跟随可变preview别名；验证hash后逐文件检查，拒绝执行包内程序或把nginx配置当作下载数据直接执行。实际VPS安装失败应保留前一版本并报告安装失败，不改变本交接记录的含义。

此步骤仅复用既有GITHUB_TOKEN的Deployments:write、Contents:read、Checks:read；没有新增Contents:write、SSH、DNS或Cloudflare权限。日常LLM仍只维护私有源码内容，不能批准preview或登录VPS。

### 独立的 .cn 安装身份验收

`CN installation identity` 在 `publish-sealed-preview` 整个 run 成功结束后自动运行，也可手工输入具体 controller run ID 重验。它只读核对 main/workflow/attempt/commit 与对应 `cn-pilot` 交接，等待最多约 15 分钟，要求 `.cn` 的 manifest SHA/大小一致、首页与 manifest 的 SHA/大小一致、`healthz` 正确，以及 www 永久跳转到 apex 并保留路径/query；结束前再次核对 controller attempt。发布 job 被跳过的轮询记为 `not-applicable`，不会冒称已安装。

回执只含版本元数据、计数和失败原因，保留 90 天；scope 固定 `installation-identity`、`filesChecked=1`，不是全文件、历史路由或独立服务验收。旧站即使 `/healthz` 正常，只要新 manifest 未安装就会超时失败。此 workflow 只有 Contents/Actions 只读权限，无部署密钥、不创建 Deployment、不执行接收器回滚；失败应查看 HK 接收器和退避状态。现有健康监控仍只证明站点可用性。

### .cn 交接前的独立服务只读门禁

`verify-services.mjs` 在交接前读取同一封存包的 `contentIds` 及 HTML 中实际 `data-page-key`（保留说说锚点），对 `.com`、`.cn` 和固定 preview alias 三个精确 Origin 检查 Worker `/health`、全部 ID 的 likes/views 计数与 CORS；检查 Artalk 2.10.1 `/api/v2/conf` 和各实际页面的 `/api/v2/comments`、站点身份及 CORS。脚本不执行包内代码、不发送点赞/阅读量/评论写请求，不以 JS 200 冒充评论可用。Artalk 的 GET comments 缺页只构造响应，不保存页面或增加 PV；协议依据固定的 [v2.10.1 comment_list.go](https://github.com/ArtalkJS/Artalk/blob/53d15ee0c3a908b4a58fc43f42c44b5e709279bd/server/handler/comment_list.go) 和 [public conf](https://github.com/ArtalkJS/Artalk/blob/53d15ee0c3a908b4a58fc43f42c44b5e709279bd/server/common/conf.go)。版本升级须重新审阅协议。

`services-receipt.json` 只记录包/源码/控制器 run、attempt、commit、配置及 ID/page-key 集合的 SHA、时间、覆盖计数和固定错误码，不保留评论正文、姓名或邮箱。`cn-handoff.mjs` 必须独立匹配这份回执，要求完整覆盖、零失败且检查开始至交接不超过 15 分钟；缺回执、串包、重跑旧 attempt、服务不可达或缺 ID 均阻断交接。失败回执也保留 90 天；无新增服务凭据。固定部署/alias 已上传而服务门禁失败时，`.cn` 仍维持上一成功交接，不把预览更新当成 `.cn` 成功。

Artalk 的 `limit=1&flat_mode=true` 限制初选评论数；固定版本的 [findFlatLinkedComments](https://github.com/ArtalkJS/Artalk/blob/53d15ee0c3a908b4a58fc43f42c44b5e709279bd/server/handler/comments_get/utils_list.go) 还会补一条 `visible=false` 的直接父评论，所以门禁校验唯一 ID、真实可见性、父子关系及页面/站点身份，不把回复线程误判成分页失效。

这一门禁证明公开读取和浏览器 Origin 配置在验收时可用；不证明评论提交/验证码、点赞写入、历史评论迁移完整或持续可用性。服务首次部署和更新仍须独立审批、隔离写测试与迁移对账。不能靠跳过门禁、伪造回执或给本 workflow 增加服务管理凭据求绿。


### 点赞 Worker 首次初始化与后续更新

首次准备使用 `node scripts/likes-bootstrap-stage.mjs <source-run> <source-commit> <artifact-sha256> <new-absolute-temp-directory>`，仅在清洁、与远端 main 一致且可信检查成功的 publisher checkout 上运行。它通过 `gh` 只读核对真实 CI/私有归档，暂存固定 Worker、封存 ID、SQL 和首次配置；不伪造 Actions 环境、不执行远端写、不生成 SALT。配置关闭 workers.dev/preview URL、无路由、含每小时 cron；重复目标和桌面/同步/Git 路径会被拒绝。后续首次 schema → deploy → stable SALT → metadata → 单独服务域名 → GET 验收的准确步骤、失败边界见 [LIKES-DEPLOY.md](docs/LIKES-DEPLOY.md#maintainer-only-first-bootstrap-staging)。

日常 `deploy-likes.yml` 仅更新已有 Worker。CI 使用只限 **Individual Worker `sfz-likes` 的 Workers Editor**，不授予所有 Worker、D1、DNS/routes 或 Pages 权限；不能把仅用于首次创建的维护者授权留作日常 CI 凭据。该角色仍具备所选 Worker 的配置/secret 管理能力，可信发布程序和人工审批必须保留。
