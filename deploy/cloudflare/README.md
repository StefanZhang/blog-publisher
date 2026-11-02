# 评论域名的 Rocket Loader 例外

`comments-configuration-rule.json` 是人工应用的配置意图，不是自动调用 Cloudflare API 的程序。仅修改 `comments.stefanzhang.com` 的 Rocket Loader；不改变 apex WordPress、DNS、缓存、WAF、Turnstile 或其他 hostname 的设置，不新增云 API 凭据。

2026-11-02 在未应用规则时，连续三组只读 GET `/api/v2/captcha/`（固定 `Accept: text/html`，分别 Node UA 和 Chrome 131 UA）全部返回 HTTP 200 / `text/html` / 2069 字节，但均包含 `rocket-loader.min.js`、`data-cf-settings` 与 `<随机值>-text/javascript`。响应已有 `Cache-Control: no-cache, no-store, must-revalidate` 和 `CF-Cache-Status: DYNAMIC`，因此 HTTP 200、no-store 和服务 API 成功都没有证明验证码脚本可执行。两个 UA 均受影响，这组结果不能证明 UA 是原因；早先原生 Node 默认 Accept 与浏览器请求不同。

官方支持用 [Configuration Rule 对单独 hostname 关闭 Rocket Loader](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/enable/)，该规则的 [`rocket_loader` 参数是 boolean](https://developers.cloudflare.com/rules/configuration-rules/settings/)。[API 规则动作](https://developers.cloudflare.com/rules/configuration-rules/create-api/)是 `set_config`、阶段为 `http_config_settings`；不要把 zone 全局设置的字符串 `"off"` 写入本规则。`no-transform` 是否能阻止本次 Rocket Loader 改写没有实验证据，因此不以它替代明确例外。也不修改固定 Artalk 镜像来插入 `data-cfasync`，不新增代理。

## 人工应用与回滚

1. 从已经合并、`check-controller` 成功的固定 commit 读取 JSON；记录 commit、规则应用时间和操作者。
2. 在 `stefanzhang.com` → Rules → Configuration Rules 保存应用前的规则列表。2026-11-02 只读检查为 0 条；如果现状不同，先检查匹配范围与优先级，不覆盖整个列表。
3. 新增名称 `Artalk comments: preserve script execution`；表达式必须是 `(http.host eq "comments.stefanzhang.com")`；只配置 Rocket Loader = Off，和 JSON 的 `rocket_loader: false` 对应。保存后记录实际 rule ID 与唯一 action。不要到 Speed 全局开关操作，也不要移除 WAF 或验证码。
4. 使用下述只读门禁，再在真实浏览器人工完成 Turnstile 验证。门禁只确认 HTML 和脚本结构，没有执行脚本，也不能证明用户成功、Siteverify 成功或待审流程成功。人工验收不批准测试评论公开；待审/清理仍按博客 Artalk 运维文档执行。
5. 如果本规则导致已确认退化，只禁用所记录的这个 rule ID，保留规则及应用记录供审阅。检查其他规则未变化；重新跑 HTTP 验收并记录结果。重新出现 Rocket Loader 时发布门禁应失败，不能为了发布跳过它。不要回滚整个 zone，也不要关闭 Turnstile。

## 只读验收

正常 preview 发布会执行 `scripts/verify-services.mjs`，在交接 `.cn` 前要求 `artalkCaptchaHTML: 1`。这个计数仅表示：无重定向的 GET、Chrome UA、`Accept: text/html`、无 Origin/凭据（匹配 iframe 文档导航）、HTTP 200、HTML MIME、最多 64 KiB，且固定 2.10.1 的 Turnstile 外部脚本和相对 `./verify` 回调仍可执行，没有 Rocket Loader 或 Cloudflare HTML challenge 改写。它不请求 Turnstile JS、不发 POST、不创建评论/PV，不输出 HTML、sitekey 或 token。

单独复核当前受审阅函数：

```bash
node --input-type=module <<'JS'
import {verifyArtalkCaptchaHTML,CAPTCHA_BROWSER_UA} from './scripts/services.mjs';
const response=await fetch('https://comments.stefanzhang.com/api/v2/captcha/', {
  method:'GET',redirect:'error',cache:'no-store',credentials:'omit',
  headers:{Accept:'text/html','User-Agent':CAPTCHA_BROWSER_UA},signal:AbortSignal.timeout(10000)
});
try { await verifyArtalkCaptchaHTML(response); console.log('captcha-html: passed (not a completed CAPTCHA)'); }
catch(error) { console.error('captcha-html: '+(error.code||'invalid-response')); process.exitCode=1; }
JS
```

模板依据固定 Artalk [2.10.1 Turnstile HTML](https://github.com/ArtalkJS/Artalk/blob/53d15ee0c3a908b4a58fc43f42c44b5e709279bd/internal/captcha/pages/turnstile.html) 与 [只渲染模板的 GET 实现](https://github.com/ArtalkJS/Artalk/blob/53d15ee0c3a908b4a58fc43f42c44b5e709279bd/internal/captcha/checker_turnstile.go)。固定模板改变时必须重新审阅；不自动接受当前网络响应作为新基准。
