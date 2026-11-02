# .com 同包生产发布（接入中，未切 DNS）

日常纯内容自动双站更新见 [CONTENT-PUBLICATION.md](CONTENT-PUBLICATION.md)；以下为保留的人工维护入口。

生产源构建固定为私库 `build-production.yml`，配置 `release.production.config.json`；现有 `.cn` `deploy.yml` 与 receiver 保留。不能把 `.cn` artifact 改域后上线。

## 一次性配置

受保护 publisher main 必须有可信 check，禁止强推/删除。新 `production` Environment 与 preview 一样：StefanZhang 是唯一 required reviewer，禁止管理员绕过，仅 protected branches。生产环境保存 `CLOUDFLARE_API_TOKEN`（仅本账户 Pages Edit）及 `CLOUDFLARE_ACCOUNT_ID`；不授予 DNS、D1 或 Workers 权限，不在私库保存部署 secret。secret 值不进 Git/日志/聊天。工作流在 inspect 阶段检查两个环境，缺失时不上传。

`policy.production.json` 绑定独立源码 workflow、完整配置、控制文件、构建程序 SHA；`policy.json` 继续绑定 .cn。两个包分别封存；每个目标的预览到生产均不重建。共享 source-stage 保留私库、current-main、归档下载 SHA、控制文件和 CI loopback 的全部门禁。

## 代码/配置维护的 .com 更新入口（人工审批不可代办）

运行 `publish-sealed-production`，mode=stage，build_run_id 填成功的当前 main **production build** run（或 latest），可填写准确 artifact_hash。

1. inspect 复核当前源 main、完整私有归档与 production 策略。
2. 人批准 preview，只上传 release-preview 分支；固定URL及alias逐字节验收与独立服务门禁通过后，保存无内容的 production-preview-proof。
3. 人批准 production。重新下载同一归档，复核来源、run/attempt/controller、24小时预览、全部文件覆盖；重新读取独立服务。预览证据只从当前 workflow run 获取，不能填任意 proof URL。
4. 上传同一目录到 Pages main；分别验收固定URL和项目 production pages.dev。回执明确仅为项目生产字节，不宣称正式域已切换。
5. 首次域名切换由维护者按源库 STATIC-CUTOVER.md 的备份、旧站最终增量、冻结、DNS/规则快照和回退进行，不能由 upload 步骤隐式切域。之后 mode=verify-domain 只读核验正式 .com 全量文件、历史/query、服务与noindex状态，不使用Cloudflare token。

workflow 与 .cn 共用 Pages 并发锁；等待 .com 审批期间 .cn preview 更新会排队。首次版本不增加自动 production 轮询；日常维护者可在 Actions UI 或 `gh workflow run publish-production.yml -R StefanZhang/blog-publisher -f mode=stage -f build_run_id=latest` 触发，然后人批准。内容 Agent 仍不能持有代表审批人的 owner Actions-write 或生产密钥。

## 失败与回退

任意策略、预览、服务、字节验证失败都退出非零，保留回执；不得把失败的 .com 验收改为成功或降低资源时限。source main/控制器更新或预览过期需要重新触发审批。upload 成功但后验失败可能已经改变 Pages main；保留 deployment ID，使用预先记录的成功 Pages 版本恢复；首次切域失败恢复精确旧 DNS/规则快照及WordPress原站。失败不自动删除旧包、评论或媒体。

历史 WordPress 和原始备份至少保留30天，退役另行授权。`.cn` 无本次交接元数据，不会因 .com stage 自动换包。网站新ID仍要先发布独立Worker known-ids。

## 首切前说说图片门禁

2026-11-02 在旧包预览通过后发现：原始说说的 5 张图片未出现在内容/渲染中，11 个链接也丢失了目标，旧资源测试没有覆盖这类缺失。因此取消 run 41504929235 的待审 production，不改变 DNS。source PR 恢复图片并新增源/渲染身份检查；两个 policy 固定新增检查器的源码 SHA，production 同步审阅 prepare 的新检查步骤。该 policy 版本只接受修复后的 CI 包，不能复用旧 hash 或旧预览回执。
