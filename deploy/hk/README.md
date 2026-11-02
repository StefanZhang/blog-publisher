# 香港 .cn 静态发布接收器（待真实服务器验收）

本程序只读公开 GitHub 发布回执和固定格式的 Pages 部署域，不持有 GitHub、Cloudflare、SSH 凭据。安装和首次切换由维护者完成，日常内容 Agent 无权修改本程序、Nginx、systemd 或审批发布。

## 信任链

- 只接受 `StefanZhang/blog-publisher` 的最新 `cn-pilot` deployment，作者必须 `github-actions[bot]`（固定 ID `41898282`、类型 Bot）；GitHub 实际 API 的 `performed_via_github_app` 可为空，若有值必须为 `github-actions`。
- 成功状态还不够：对应 controller run 必须已经 completed/success，main，workflow `.github/workflows/publish-preview.yml`，SHA、attempt、仓库与回执全部一致。运行尚未结束时下一轮再取。
- 只下载 `https://<8–32个小写hex>.stefanzhang-com.pages.dev/`；回执 URL 使用唯一无尾斜杠 origin；禁止 HTTP、别名域、重定向、外部域和任意 CLI origin 覆盖。
- Manifest SHA/bytes 来自 controller 回执；每个文件逐一核对 bytes/SHA256，不执行下载内容。没有 GitHub 签名公钥体系：受信 GitHub 仓库/审批工作流本身是信任根。
- 固定 header profile SHA 变更会拒绝，需维护者审阅后更新程序。路由只允许结构化 301 数据；当前 receiver 额外拒绝字面 `$`、attachment 保留字符的 percent 编码（当前实际数据均无这些项），不猜测未知语义。

## 首次安装：只使用已合并、CI 成功的固定版本

此目录属于可信 publisher 控制代码；它不是博客发布包，日常内容 Agent 不得持有节点 root/SSH 权限。节点上不接受未提交工作树 SCP 热改。维护者先将专用 PR 合并到受保护 main，确认同 commit 的 `check.yml` **push/main** CI 已成功，然后从该 commit 创建归档（不要求节点安装 Git）：

```sh
git fetch origin main
git archive --format=tar "$PUBLISHER_COMMIT" deploy/hk > publisher-hk.tar
shasum -a 256 publisher-hk.tar
```

`PUBLISHER_COMMIT` 必须是已审阅的 40 位固定 SHA；传输归档后复核上面的 SHA256，在新 root 专用目录解包。使用保留的固定版本归档入口执行：

```sh
/usr/bin/python3 -I /root/publisher-fixed/deploy/hk/bootstrap.py \
  --commit "$PUBLISHER_COMMIT" --ci-run "$PUBLISHER_CI_RUN"
# 上一步只验证；首次正式安装额外传入 --apply。
/usr/bin/python3 -I /root/publisher-fixed/deploy/hk/bootstrap.py \
  --commit "$PUBLISHER_COMMIT" --ci-run "$PUBLISHER_CI_RUN" --apply
```

每次验证使用 4 次匿名 GitHub API：精确 commit、main 祖先关系、指定 CI run、Git tree；逐个核对归档中本目录文件的 Git blob SHA。拒绝 PR CI、失败/未结束运行、其它 workflow、未合并 commit、改过的文件或额外文件。不要运行站点包中的脚本。

该 installer 只支持已审计的本次旧站：固定 `current`、vhost/health 脚本 SHA、旧镜像服务已退役、现有健康 timer active/enabled。任何漂移都拒绝安装，需重新审阅，不能在节点临时改脚本绕过。它备份被改文件，安装 root-owned `/usr/local/lib/stefan-blog-cn/<commit>/`（目录明确 0755），保留旧站 wrapper，接入 Nginx include 与健康探针，验证 **stefan 身份**能读取程序、写发布目录并使用现有 sudo 测试/重载接口。www 重定向至 apex，ACME 和 TLS 保留。

安装后 `stefan-blog-cn-pull.timer` **保持 disabled**，不运行 receiver、不下载站点、不切新包。首次批准 `cn-pilot` 回执且整个 controller run 成功后，由维护者按发布验收流程启用此 timer；正常更新再由接收器拉取同一封存包。不得由日常内容 Agent 启用、审批或修改服务。

异常时 installer 按保存的 CAS 和备份哈希恢复；中断后使用保留归档里的固定入口恢复（无需 GitHub 在线）：

```sh
/usr/bin/python3 -I /root/publisher-fixed/deploy/hk/bootstrap.py \
  --rollback /var/backups/stefanzhang-cn/bootstrap-<固定版本前12位>-<安装时间>
```

只接受 root-owned 安装备份。先停用 timer、等待 service 空闲；若配置或 active 已被维护者改变，CAS 会拒绝覆盖。**此为首次基础设施安装的恢复，不是新站发布后的版本回滚。** 安装成功后保留原归档和 backup，后续控制程序升级需独立审阅的仓库变更，不直接覆盖节点代码。

## 运行接口

systemd 使用 root-owned 固定版本目录，WorkingDirectory=/，清空 PYTHONPATH/PYTHONHOME，禁止用户 site-packages。`ProtectSystem=full`；不启用会阻断现有 sudo 的 `NoNewPrivileges`。程序本身不含部署或 SSH token。

固定站点根 `/var/www/stefanzhang.cn`；需预先存在非符号链接 `releases/`，以及 `active -> releases/<旧站wrapper>`。旧 `current`、旧 WordPress 静态目录、已有备份完全保留。wrapper 内 `nginx/http.conf`、`nginx/server.conf` 应能恢复原站；仅旧站 wrapper 允许 `site -> ../static-20261101T205114Z` 兼容链接，供现有健康探针比较首页字节。新发布目录绝不含此链接，Nginx root 仍使用旧版本真实绝对路径。接收器识别 wrapper/site 为 symlink 时拒绝缓存复用，改为完整下载并逐文件验证。

Nginx 主 `http {}` 作用域包含：

```nginx
include /var/www/stefanzhang.cn/active/nginx/http.conf;
```

现有 .cn HTTPS server 内包含：

```nginx
include /var/www/stefanzhang.cn/active/nginx/server.conf;
```

TLS、80→443、HSTS 及安全入口由既有可信配置负责；不要重复保留旧 `root`、`location /` 或互相覆盖的 `error_page`。生成的 root 是版本目录的绝对路径，旧 worker 在 reload 完成前仍读旧目录。`.cn` 不增加 noindex；页面 canonical 保持 .com。`/healthz` 保持 `/var/lib/static-node-monitor/ok`、`Cache-Control: no-store`、最多 1024 字节且以 `ok ` 开头，不移除 `static-node-health.timer`。

以 `stefan` 执行，只有以下受控提权接口：

```sh
sudo -n /usr/sbin/nginx -t
sudo -n /usr/bin/systemctl reload nginx.service
```

必须先核对真实 sudoers。程序不修改 sudoers。建议 systemd oneshot 每 5 分钟运行一次，随机延迟 ≤30 秒、超时 20 分钟；匿名 GitHub API 一轮 3 次请求，5 分钟周期约 36 请求/小时。API 限流/不可用/控制器未完成时不切站。错误进 journal，成功输出一条 JSON；无变更、锁冲突、等待控制器完成静默。告警沿用现有健康监控，不发送额外测试通知。健康脚本仅额外排除 `stefan-blog-cn-pull.service` 的 failed 状态：发布失败保留非零、journal 与 `.last-failure.json`，但不会把仍正常服务的旧站报成 DOWN；其它 failed units、资源阈值及 nginx 状态检查保留，首页通过实际 HTTPS 200、HTML 与 active 文件 SHA 验证。

## 原子激活与恢复

下载写 `releases/.building-*`；校验全部成功后改名 `releases/cn-<artifactHash>`。旧文件只有重新验 SHA 才复制复用，禁止符号链接复用。已有同版本目录必须全部字节和配置相同，否则拒绝覆盖。

完整 stage 与父目录先 fsync；切换前写 `.activation.json`，进程中断后的下一轮持锁优先恢复先前版本，成功或完成回滚才删除恢复日志。若维护者已把 active 改成第三个版本，停止并要求检查，绝不覆盖。更新 active 的原子 symlink → nginx -t → reload → 本机 HTTPS 读取真实 manifest、首页、RSS、搜索页、一个优化图、healthz。校验失败会把 active 恢复到先前 wrapper/版本并 test/reload。恢复 reload 失败会明确报错，不宣称恢复已经完成。无法获得可靠远端控制台时，应由现有监控检测实际可用性。

下载失败只删除本次 `mkdtemp` 创建、尚未改名的 `.building-*`；不扫描或删除其它 stage、已完成版本、旧 WordPress static-*、current 或 wrapper。磁盘不足拒绝发布。`.last-failure.json` 仅保存 deployment ID、controller run、简短错误和下次重试时间；同 deployment 失败后依次退避 30 分钟、2 小时、6 小时，继续失败保持 6 小时。新 deployment 可立即尝试，成功清除失败状态；退避仍返回非零，避免把未解决的发布失败伪装成健康。

人工回滚必须先停止并禁用接收器 timer，等待其 service 空闲；在同一 `.pull.lock` 下保存当前指针、原子切 active、nginx -t/reload，再做 HTTPS 验收。确认应恢复自动发布前不要重新启用 timer，否则最新已批准的 deployment 会再次上线。无需停止或更改 `static-node-health.timer`。

## 本地与 CI 验证

从 publisher 仓库根目录执行：

```sh
python3 -m unittest discover -s deploy/hk -p 'test_*.py'
python3 deploy/hk/nginx_fixture.py --synthetic \
  --work /tmp/cn-nginx-fixture-unique --nginx /usr/sbin/nginx --port 18743
```

单元测试覆盖身份/源域/编码/配置注入、流长度和 SHA、锁、复用与 symlink 拒绝、激活/中断/回滚、健康响应、失败退避和定向清理。CI 在现有 required `check` job 内执行，Ubuntu 24.04 安装发行版 nginx-core，使用仅含合成路由与 dummy bytes 的公开 fixture；不用站点 manifest、真实历史路径或私有文章。

真实 Nginx 实验只监听 localhost:18743，并仅终止自己的子进程，不操作生产 pid/reload。验证路由顺序、编码、query 首值与优先级、404、MIME、缓存及安全响应头；不证明发布内容 SHA。默认每条案例必须最终 200，单独明确标注 `status:404` 才验收缺页边界。输出 syntax.txt、result.json、process.log 到所指定的新临时目录，均不提交。

维护者可以在仓库外传入 `--manifest <临时文件> --cases <临时文件>` 做真实站点路由验收；不要把实际 manifest、1124 个实际案例或结果日志加入公开仓库。正式上线还必须完成 sealed artifact → controller → Pages → receiver 的完整字节身份验收和真实入口验证。

路由生成依据 Nginx 官方 [map 的首个匹配正则优先级](https://nginx.org/en/docs/http/ngx_http_map_module.html) 保留原顺序；不用无序 exact map 替代有前后关系的 `_redirects`。
