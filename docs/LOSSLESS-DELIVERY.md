# 无损图片的发布适配（2026-11-02）

用户要求全站内容图片统一无损WebP并更新COM/CN。源码维护分支实测：338源图、999无损变体136,002,212字节，另保留1224个旧图片URL；站点ZIP324,543,051字节，超过此前250MiB上限。配套把archive download、restore、likes staging共用的有限ZIP上限设为400MiB；解包450MiB、单站点资源25MiB、路径/重复/symlink/SHA/来源与人工审批要求不变，不给日常agent新增权限。

首次真实内容自动发布是schedule run `41570766257`，source `2ba81cd`。Pages及香港安装身份已通过；独立run `41572072504` 的COM全量3319文件/1117旧地址通过。CN整轮子进程在COM完成后600秒返回通用错误；代码复用了Worker等命令的600000ms上限，日志把该超时原因吞掉，也没保存当次CN元数据，不能据此宣布CN完整验收通过。

第一轮修复仅把独立CN全量命令预算改为25分钟（workflow仍40分钟），单个资源20秒、历史请求15秒及所有完整性检查不变。记录target开始/耗时/预算，非零退出也尝试保留固定JSON回执；一般命令错误区分总超时和exit code，仍不输出child stdout/stderr，避免泄露私有正文、bindings或provider响应。

需要在main CI通过后，对同一controller run重跑只读verify-cn，并按具体回执判断是否另有真实网络/资源问题；不重新部署、不改DNS、不把交接成功当作最终验收成功。源码维护包之后仍需reviewed策略、固定main CI包与人工批准的维护发布，不用content-auto绕过代码维护审批。

## 第二次只读验收的实际发现

run `41574413082` 已完整保留失败回执：COM的3319文件/1117旧地址再次通过；CN实际执行了同样完整覆盖和服务检查，但20个大文件在单请求20秒处超时，没有404或字节不符。CN整轮耗时1,365,857ms。故上一轮只增加子进程预算不足以解决问题，不能称首次双站全量验收已通过。

本地直连CN某1,297,394B PNG，20秒仅收540,654B；12秒并行对比验证器、undici与浏览器UA，均HTTP200但未下完，速率约17–28KB/s。此实验不能证明服务器限速或大陆真实用户速度；也不支持伪装UA求绿。香港本机回环读取同文件约0.049秒，文件存在与本机磁盘读取正常。节点限速配置仍需只读SSH核对；本轮不改节点。

可信发布器的逐文件GET采用有限预算：`min(180秒,20秒+ceil(封存字节/16384)秒)`，1,297,394B对应100秒。继续限制实际接收字节并核对完整SHA、MIME、CSP、缓存与状态码；不重试掩盖故障、不跳过大文件。历史地址由串行改为最多6路并行，逐条保留同源、无循环、最终地址、fragment和query重定向检查，文件/历史两个阶段不重叠。单历史请求仍15秒，CN整轮25分钟和workflow40分钟保持有限。回执增加两阶段耗时和5条最慢资源的字节/TTFB/总时长，供下一次同包实验判断效果；若仍超时，继续查真实传输瓶颈，不宣称绿色验收。

无损源码维护 PR #13 已合并为 `9257041761e8b5f6b2a16672e40000f64c2eff9b`。其树与已审阅head逐项匹配，非内容树摘要 `53b330ae87db0e4b8499ac17643c0511ea7cf41bf26b6d645aa20c33211e96c5`；四个控制文件保持。两目标策略补齐并固定prepare/package/优化器/像素检查/兼容文件检查的实际SHA，内容自动入口的维护基线同步到该commit。

此策略同步不会自动发布维护基线，也不使用content-auto代替维护审批。需两个main构建及私有归档（CN `41576579771`、COM `41576579763`）完整成功，再按原protected preview/production维护流程发布两目标，同源码的ZIP分别匹配各自publicationOrigin。第一轮历史版本的最终验收单独留证，不能混用新旧版本数据。

两个main构建和归档均已完整成功。COM包 `3e413ecfab2fd86368554c2bbc6b0a287a855ff78272c0cc98ec640f4f28507c`，ZIP 325,089,206B；CN包 `73a7c82afdfb1a6e1c814c54dcba48183e5ba508fe69e98e5480db3151b1edc4`，ZIP 325,089,354B。ZIP来自GitHub隔离构建，不能用本地实验包替代。16个CN、18个COM被固定的源文件SHA已对照该commit重新计算，全部匹配。


## 维护发布后的只读验收（2026-11-03）

旧源码 `2ba81cd` 的独立 run [41578061932](https://github.com/StefanZhang/blog-publisher/actions/runs/41578061932) 已通过：COM/CN 各3319文件、1117历史/query地址、0失败，formalCOMVerified=true。CN资源601,405ms、旧地址103,414ms，完整HTTP命令706,524ms；这是修复后真实外部路径的结果，不是本地或大陆测速。

无损维护 run [41579107775](https://github.com/StefanZhang/blog-publisher/actions/runs/41579107775) 的预览两地址各4346文件/728旧地址通过；Stefan本人批准production后，同包已上传Pages main。生产固定URL的4346/728通过，生产项目别名有一个旧附件目标返回502，job保持失败；精确路径随后在项目别名与正式COM均301→200，最终32,898B、SHA `7131da0d17563717a6484c37deae05af78a3978bbc2378a118ac43699b1ee4a9`。不能从一次复查断言502内部来源，也不把失败run改称成功。

`verify-domain`现在先完整核对生产项目别名，再完整核对正式COM及独立服务，保存两份元数据回执；这是既有只读入口，不重新上传包、不使用Cloudflare写凭据。生产项目步骤失败时也保留固定JSON诊断。没有自动重试或忽略502。

此前维护CN发布只自动验证安装身份（manifest、首页、health、www）；full检查仅适用于内容自动链路。现在同一`verify-cn.yml`对已成功的维护handoff下载其精确私有封存包，检查CN全部文件、历史/query及独立服务，scope=`maintenance-cn-online`，只含CN目标，formalCOMVerified=false。自动内容仍要求双包同source/ID集合及两站完整覆盖。CN整轮25分钟、workflow40分钟及有限单请求预算不变；不新增secret、权限、部署写入或节点程序。

任何新无损版本的最终成功仍需上述正式COM和维护CN各自完整通过，不能复用旧版本3319/1117数据，也不能将安装身份当完整验收。


## 正式COM的同包完整复验

发布器 [PR #22](https://github.com/StefanZhang/blog-publisher/pull/22)、main `469f684`、CI `41652088360`（95项Node测试、6项Python ZIP测试及Nginx/工作流检查）通过。原COM包未重建或重新上传；只读 run [41652358043](https://github.com/StefanZhang/blog-publisher/actions/runs/41652358043) 完整成功：

| 目标 | 封存包 | 文件 | 历史/query地址 | 失败 |
|---|---|---:|---:|---:|
| 正式COM | `3e413ecfab2fd86368554c2bbc6b0a287a855ff78272c0cc98ec640f4f28507c` | 4346 | 1117 | 0 |
| Pages生产项目别名 | 同包 | 4346 | 728 | 0 |

独立服务门禁在同一只读job通过。正式浏览器第二章图9实际加载968×578无损WebP，第三章首图1400×1143无损WebP；原始PNG入口1400×1143正常。浏览器图片Accept请求头抽检的两张图表和一张1600px照片均保留manifest的字节/SHA及VP8L无损编码。抽样不能替代构建中全部338原生变体的可见像素校验；该像素检查与远端全文件SHA共同构成保真证据。

源图既有JPEG/WebP损伤不能通过重编码恢复；所有999当前变体共136,002,212B，存在带宽代价。真实iOS/Android、人类阅读任务、真实用户CWV未验证，不据此宣布所有图片主观清晰或性能不受影响。

## CN无损维护交付（完整通过）

[41653115360](https://github.com/StefanZhang/blog-publisher/actions/runs/41653115360) 已由Stefan本人批准且整个controller成功，source `9257041`、CI `41576579771`、封存 `73a7c82afdfb1a6e1c814c54dcba48183e5ba508fe69e98e5480db3151b1edc4`；固定部署 `4eb5081e-5cda-4d3e-a75a-0bc432a86827` 与预览别名各4346文件/728旧地址通过，独立服务门禁通过。独立线上 run [41654210684](https://github.com/StefanZhang/blog-publisher/actions/runs/41654210684) 自然触发并完整通过：安装身份、manifest、首页、health与2条www规则成功；maintenance-cn-online对4346文件、1117历史/query、独立服务验收通过，0失败。香港正常receiver已原子切active到 `cn-73a7c82afdfb…`，Result=success、ExecMainStatus=0；没有手动运行安装或热改代码。CN-only回执的formalCOMVerified=false表示该回执只涵盖CN，COM由上节独立正式域回执证明。

本轮没有改DNS、Worker、D1、Artalk或节点程序；香港接收器继续使用已验收的固定 `05b791e` 版本和原正常定时入口。只读核对9个实际Nginx include配置无rate指令，磁盘空闲12.48GB、receiver/health timer健康。这不证明大陆用户网速；GitHub到香港与本机跨境传输只是Lab Evidence。


## 最终版本、边界与后续发布

两站均为源码 `9257041761e8b5f6b2a16672e40000f64c2eff9b`。COM Pages生产部署 `b453d4f1-0f50-4b65-97ae-bb25f8b9065b`，原发布/审批run `41579107775` 的单次502失败保留；独立完整复验 `41652358043` 成功。CN部署/交接 `41653115360`、完整验收 `41654210684` 成功，接收器固定版本仍为 `05b791edc0d49771084634cc3d4e831e1dfad850`。包与source CI见本文前述固定身份表述；两个publicationOrigin不同，不能混用ZIP或将“同源码”说成“同ZIP”。

CN本次全文件阶段530,564ms、历史地址98,920ms，HTTP子进程631,992ms；这是全站批量验收，不是单页加载时间。不同网络/缓存条件下的数据不能与旧run做性能排名。未为跑绿灯重发包、自动重试或删掉失败路径。

正式CN浏览器第三章图19为1400×1143无损WebP，320×568与390×844灯箱无横向溢出，两个可见操作关闭44×44、原图约88.5×44；无已记录console error。COM/CN的浏览器图片Accept抽样得到相同的完整文件SHA及VP8L位流。此处是Chrome Lab Evidence，不能代替真实移动Safari/Android或人类阅读反馈。

纽约2026-11-03 09:40:48之后读取既有 [UptimeFlare](https://uptimeflare-1yd.pages.dev/)：博客与中国优化静态节点均为绿色circle-check。历史可用率不清零，状态页另外两项离线服务未在本轮诊断范围内，不据此宣称全部服务健康；未发测试告警、未改监控ID/规则。CN健康入口及定时监控保持，资源和历史路径完整性另由上述全量回执证明。

后续新增源图会在隔离构建中按无损规则生成并接受全部位流、尺寸与原生可见像素检查。纯内容仍是LLM提交内容/源图PR→Stefan本人合并→两目标CI/私有归档→自动双站发布/线上检查；代码维护继续由本人批准preview/production。本次源码维护基线已固定为9257041，内容自动入口enabled=true，没有把代码维护冒充纯内容免审批。旧1224图片URL原字节保留，原始JPEG/WebP损伤只能找真实更好源图，不能靠转码、插值或生成式修复充当原图。

完整原始JSON、截图、像素/作者文字证明、首次失败及后续成功报告已保存在维护者私有 `StefanBlog/services/2026-11-02/image-lossless`；公开publisher只留程序与元数据，不留博客HTML、图片、ZIP、SQL或密钥。
