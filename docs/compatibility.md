# 兼容契约与迁移范围

迁移参照：`D:\ESP\tcp2com`，检查时提交 `dcb6407713afec63bc6378502b645160d579f326`，工作树无修改。新项目不在构建或运行时读取该路径。

冻结的是检查时已存在的前端 `dist`，不假定它一定由该提交构建。`tests/compatibility/legacy-manifest.json` 记录每个原始文件的 SHA-256，测试校验其未被修改；测试用新后端与该构建连接。冻结资源仅用于测试，不装入 VSIX。

## HTTP

- `POST /api/connect`：`invite / name / join_id` 自动授权连接。
- `POST /api/pair/request`、`/api/pair/status`、`/api/pair/cancel`：保留旧申请流程，允许／拒绝只通过本机管理入口。
- `POST /api/call`：Bearer token，`method / args / revision`，返回 `ok / data / error / revision`。
- 原有方法全部保留：`initial ports poll update_settings bridge usb network_log remember_draft read_device preview_save save_device import_config backup_config clear_logs export_logs reset_click peers revoke`。
- 未认证 401、未授权来源 403、未知路由 404、无效请求／版本冲突 400；业务方法错误保留 `ok:false` 响应。
- 来源白名单、同源访问、本地网络预检、请求体上限、静态目录边界、无缓存的入口页和 API。
- 分享保留 `#service=…&invite=…`，本地入口保留 `window.__WIFI_BRIDGE__` 注入。

## 业务

TCP 客户端／服务端和固定对端 UDP；双向串口；TCP 重连；额外客户端拒绝；连接代次、有限缓存和背压；发送超时退出，未确认数据不自动跨会话重放。

USB 单一读取者，支持 `C5CFG` / `BRIDGECFG` v2、S3 hello 探测、请求 ID、boot/session/generation 和型号校验。协议帧不进入普通日志。HTTP 配置绑定当前 session 和 revision，无 POST 重试。保存结果未知后必须重新读取。

设备字段、IPv4 子网、频段、信道、GPIO 冲突、缓存预算、旧 C5 接口草稿和密码修改规则单独校验。备份／草稿／持久状态剔除密码和会话。

VS Code 与网页共享一个 LANAdapter；插件客户端也受 revision、每终端读取凭据和复位点击归属约束。各终端草稿保持在前端，不互相覆盖。邀请刷新保留已登记 token；服务重启使旧 token 失效。

## 生命周期

0.2.0 新增侧栏快速控制：首页不自动启动网页或串口，修改参数受同一 revision 冲突保护；开启桥接／USB 时按需开启网页服务。`bridge("stop")` 只停止业务桥接，USB 保持连接；“停止后端”依次关闭桥接、USB 和网页服务。网页接口名称及参数格式不变。

网卡扫描使用独立只读 PowerShell 脚本与 UTF-16LE 编码调用，失败时保留 Node 系统地址作为备用列表。完整清单与分享资格分开处理，不再按监听地址或访问规则删掉记录。选择分享地址不修改监听绑定；配置变更在停止并重新开启后端时应用。Windows 首选网卡仍按稳定标识恢复。

按当前用户存储路径派生唯一的本机命名管道；各窗口用本机管理秘密连接同一个后端。竞争失败的窗口不覆盖当前状态。所属扩展宿主退出后后端关闭，其他窗口可在后续请求重新建立服务并重新同步；硬件操作不自动恢复。管理秘密不经过网页 API、不写日志，不放入 VSIX。

新增网络日志契约：`network_log(true/false)` 使用本机设置 `net_log_host/net_log_port`，不打开 COM；`poll.net_log` 独立返回连接、重试、stats 更新时间与接收丢弃。日志来源新增 `net`，原有 `host/usb` 不变。停止业务或 USB 保留网络日志，停止后端及退出宿主关闭它，恢复状态不自动连接。新版 C5 配置可选字段 `log_enabled/log_port` 只在设备报告支持时保存；旧备份缺失字段沿用当前设备基线，不替换端口。

旧 Tkinter／pywebview 壳与 CLI 启动脚本不随插件迁移，操作能力通过插件和网页提供。退出所有 VS Code 实例后的常驻服务不属于本版本。
