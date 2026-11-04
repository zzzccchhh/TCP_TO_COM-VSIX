# TCP2COM VS Code 插件

完整的 TypeScript / Node.js 后端与 React 工作台，面向 Windows x64。安装后不需要 Python、原 tcp2com 项目或单独启动脚本。支持 ESP-01S / ESP32-C5 / ESP32-S3 的适用功能。

## 安装和使用

从 [最新版发布页](https://github.com/zzzccchhh/TCP_TO_COM-VSIX/releases/latest) 下载 Windows x64 安装包及 SHA-256 校验文件，也可查看 [全部版本与更新说明](https://github.com/zzzccchhh/TCP_TO_COM-VSIX/releases)。

在 VS Code 的扩展菜单中选择“从 VSIX 安装”，选择下载的 `tcp2com-0.4.2-win32-x64.vsix`，完成后重新加载窗口。

1. 点击左侧 TCP2COM 图标，首页提供后端、桥接、USB、网卡与分享的直接操作按钮。打开首页不会启动网页服务或硬件连接。
2. 在首页选择设备、业务 COM、波特率、网络角色和地址，再点击“开启桥接”；必要时自动先启动后端。USB 日志／配置单独连接，停止桥接保留 USB。
3. “业务桥接”下方依次为“USB 日志与配置”和“设备配置”：选择 USB 或 HTTP，读取当前设备后，在接口与网络、AP 热点、电脑 STA、共享 STA 四组中修改，预览并确认保存重启。诊断及更多操作可进入“打开完整工作台”。
4. 在首页选择手机可达的分享网卡，二维码直接显示在“网卡与分享”栏目中，无需点击；也可复制在线工作台链接。分享下拉框只显示可选地址；独立的“全部网卡与地址”诊断清单保留虚拟、断开、无地址和 IPv6 记录及不可用原因。本机专用地址不显示手机二维码。
5. 手机和电脑处于可互通的局域网时，现有在线前端、本地浏览器和插件工作台可以共同控制后端。
6. 关闭工作台页面不会停止服务。使用 `TCP2COM: 停止后端服务` 释放网页监听、桥接和 USB；退出承载后端的 VS Code 实例也会停止服务。

默认网页端口为 8765，业务端口通常为 8080。可通过首页“更改监听设置”修改 `tcp2com.listen`、`tcp2com.port` 和 `tcp2com.origins`，然后**停止并重新开启后端**应用。选择分享网卡只改变链接，不会改变监听范围；与监听范围不符的网卡仍展示并标明原因。端口冲突会提示，不会连接未知旧服务。

插件在本机运行，打开 SSH / WSL 项目时仍访问本机 COM。当前安装包仅针对 Windows x64；不提供 vscode.dev 中直接访问本机串口的能力。

## 设备配置和迁移

使用当前设备型号和 USB 或 HTTP 连接读取配置后再保存。C5 长按 GPIO24，S3 长按 GPIO4 至少 3 秒进入配网。保存与复位不会自动重试，结果未知时先重新读取核对。

C5 的 `link_mode=4` 在各界面统一显示为“SPI传输”，内部标识仍为 `SPI_SIMPLE_TX`。该模式使用 SCK/MOSI/MISO/CS 四线，仅将 MCU 数据发送到网络；TCP 支持连续批量写入，UDP 每包最多 512 字节。S3 的 SPI WBR/1 模式保持原定义。

侧栏提供撤销修改、恢复本页草稿及 JSON 备份导入／导出；切换分组保留编辑。密码留空保留原值，STA 密码可明确清空；密码不进入备份或持久草稿。每个页面单独记录读取凭据，另一工作台的读取结果不能用来授权本页保存。型号、连接、USB 会话或其他终端重新读取后，需在本页重新读取。ESP-01S 显示不支持说明。“保存本机参数”仅保存电脑端连接设置；“保存到设备并重启”经过修改预览及确认后才写入 ESP。

运行 `TCP2COM: 导入旧版设置`，选择旧 `tcp2com_last_state.json`；需先停止桥接和 USB。导入只恢复设置和无密码草稿，不自动连接设备。用户状态存储在 VS Code 的插件全局存储目录，插件安装目录保持只读。网卡偏好保存在该用户目录内。

## 独立构建

开发机安装 Node.js 22 或更新版本及 MinGW-w64 `g++`（加入 PATH，或通过 `CXX` 指定路径）。原生模块首次构建会下载对应 Node 头文件；安装后的插件不需要编译器或 Python：

```powershell
npm ci
npm --prefix frontend ci
npm run build
npm test
npm run test:home
npm --prefix frontend test
npm run test:extension
npm run package
npm run test:package
```

按 F5 可启动插件开发窗口。构建及运行不访问旧项目目录。开发依赖、兼容基线、浏览器测试工具和运行日志不放进 VSIX。

现有 Python 项目是迁移参照，不随插件分发。冻结的原前端及校验信息位于 `tests/compatibility`。协议和验证边界见 `docs/compatibility.md` 与 `docs/validation.md`。

## 验证边界

自动化覆盖网络／串口模拟、配置与复位协议、多端认证和同步、原前端兼容、实际 VS Code 页面通信及安装包自包含。Windows 原生补充模块支持独立设置 Keepalive 空闲时间、探测间隔及次数，旧系统不支持次数设置时使用系统策略。真实 ESP、USB 控制线电平、5 Mbps 长时间吞吐、手机浏览器权限和 DHCP 变化仍需实机验证，详见验证记录。
