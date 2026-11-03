# 无损图片的发布适配（2026-11-02）

用户要求全站内容图片统一无损WebP并更新COM/CN。源码维护分支实测：338源图、999无损变体136,002,212字节，另保留1224个旧图片URL；站点ZIP324,543,051字节，超过此前250MiB上限。配套把archive download、restore、likes staging共用的有限ZIP上限设为400MiB；解包450MiB、单站点资源25MiB、路径/重复/symlink/SHA/来源与人工审批要求不变，不给日常agent新增权限。

首次真实内容自动发布是schedule run `41570766257`，source `2ba81cd`。Pages及香港安装身份已通过；独立run `41572072504` 的COM全量3319文件/1117旧地址通过。CN整轮子进程在COM完成后600秒返回通用错误；代码复用了Worker等命令的600000ms上限，日志把该超时原因吞掉，也没保存当次CN元数据，不能据此宣布CN完整验收通过。

仅独立CN全量命令预算改为25分钟（workflow仍40分钟），单个资源20秒、历史请求15秒及所有完整性检查不变。记录target开始/耗时/预算，非零退出也尝试保留固定JSON回执；一般命令错误区分总超时和exit code，仍不输出child stdout/stderr，避免泄露私有正文、bindings或provider响应。

需要在main CI通过后，对同一controller run重跑只读verify-cn，并按具体回执判断是否另有真实网络/资源问题；不重新部署、不改DNS、不把交接成功当作最终验收成功。源码维护包之后仍需reviewed策略、固定main CI包与人工批准的维护发布，不用content-auto绕过代码维护审批。
