# TCP2COM VS Code 插件

完整的 TypeScript / Node.js 后端与 React 工作台，面向 Windows x64。安装后不需要 Python、原 tcp2com 项目或单独启动脚本。支持 ESP-01S / ESP32-C5 / ESP32-S3 的适用功能。

## 安装和使用

在 VS Code 的扩展菜单中选择“从 VSIX 安装”，选择 `artifacts/tcp2com-0.1.0-win32-x64.vsix`。

1. 点击左侧 TCP2COM 图标或运行 `TCP2COM: 打开工作台`。
2. 选择设备、业务 COM、网络角色和参数，再手动启动桥接；USB 日志／配置单独连接。
3. 运行 `TCP2COM: 服务、网卡与终端管理` 选择手机可达的网卡，显示二维码或复制在线工作台链接。
4. 手机和电脑处于可互通的局域网时，现有在线前端、本地浏览器和插件工作台可以共同控制后端。
5. 关闭工作台页面不会停止服务。使用 `TCP2COM: 停止后端服务` 释放网页监听、桥接和 USB；退出承载后端的 VS Code 实例也会停止服务。

默认网页端口为 8765，业务端口通常为 8080。可在 VS Code 设置中修改 `tcp2com.listen`、`tcp2com.port` 和 `tcp2com.origins`，然后**重载 VS Code 窗口**应用。端口冲突会提示，不会连接未知旧服务。

插件在本机运行，打开 SSH / WSL 项目时仍访问本机 COM。当前安装包仅针对 Windows x64；不提供 vscode.dev 中直接访问本机串口的能力。

## 设备配置和迁移

使用当前设备型号和 USB 或 HTTP 连接读取配置后再保存。C5 长按 GPIO24，S3 长按 GPIO4 至少 3 秒进入配网。保存与复位不会自动重试，结果未知时先重新读取核对。

运行 `TCP2COM: 导入旧版设置`，选择旧 `tcp2com_last_state.json`；需先停止桥接和 USB。导入只恢复设置和无密码草稿，不自动连接设备。用户状态存储在 VS Code 的插件全局存储目录，插件安装目录保持只读。网卡偏好保存在该用户目录内。

## 独立构建

开发机安装 Node.js 22 或更新版本及 MinGW-w64 `g++`（加入 PATH，或通过 `CXX` 指定路径）。原生模块首次构建会下载对应 Node 头文件；安装后的插件不需要编译器或 Python：

```powershell
npm ci
npm --prefix frontend ci
npm run build
npm test
npm --prefix frontend test
npm run test:extension
npm run package
npm run test:package
```

按 F5 可启动插件开发窗口。构建及运行不访问旧项目目录。开发依赖、兼容基线、浏览器测试工具和运行日志不放进 VSIX。

现有 Python 项目是迁移参照，不随插件分发。冻结的原前端及校验信息位于 `tests/compatibility`。协议和验证边界见 `docs/compatibility.md` 与 `docs/validation.md`。

## 验证边界

自动化覆盖网络／串口模拟、配置与复位协议、多端认证和同步、原前端兼容、实际 VS Code 页面通信及安装包自包含。Windows 原生补充模块支持独立设置 Keepalive 空闲时间、探测间隔及次数，旧系统不支持次数设置时使用系统策略。真实 ESP、USB 控制线电平、5 Mbps 长时间吞吐、手机浏览器权限和 DHCP 变化仍需实机验证，详见验证记录。
