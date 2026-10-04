# 自托管部署指南

[返回 README](../README.md) · **简体中文** · [English](DEPLOY.en.md)

个人自托管的跨设备工作空间。一个账号，多个可命名项目群；各群聊天记录与文件独立。所有业务数据保存在服务电脑，云服务器仅转发流量。

## 在当前 Windows 电脑上运行

需要 Node.js 24 LTS。首次安装：

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

打开 http://127.0.0.1:3000，在服务电脑上设置至少 12 个字符的密码。以后其他设备用同一密码登录。**先完成初始化，再启用公网中转。** 默认仅监听本机，不会自动暴露到公网。无需注册，也没有默认密码。

## 已实现

- 多个项目群，新增、重命名；消息和文件按群保存及查询。
- WebSocket 实时事件、断线自动重连、重连和页面恢复可见时补齐消息。
- 文字先显示再确认；失败手动重试；唯一请求标识防止重试产生重复消息。
- 文件拖拽和多选上传，最多两个并行上传，百分比进度、取消、失败重试、大小限制。
- 下载通过浏览器下载管理器展示进度；后端支持 HTTP Range。重试上传会重新传输整个文件，暂不支持分片断点续传。
- 按每个浏览器识别设备、自动推测系统及浏览器名称、手动命名、查看并撤销登录。
- 密码 scrypt 哈希、HttpOnly 会话 Cookie、生产 Secure Cookie、请求来源检查、登录失败限速。
- SQLite WAL 保存消息，文件流式写入本地磁盘；历史记录每次加载 100 条。
- 桌面和手机布局、未读群标记、会话期间的各群输入草稿。

群的独立性指数据分类，不是不同账号的权限隔离。所有已登录设备都能访问所有项目群。清除浏览器数据/无痕窗口会成为新设备。登录有效期 30 天，之后重新登录。

## 推荐部署：Ubuntu 24.04 LTS

专用旧笔记本推荐 Ubuntu Server；如果还需要本机图形操作，可安装 Ubuntu Desktop。Windows 11 也能运行此程序，但 Ubuntu 的常驻服务、更新和权限管理更适合专用服务电脑。

架构：浏览器 → 云服务器 Caddy HTTPS → 云服务器 frps → 加密 frp 隧道 → 笔记本 frpc → 本地应用。

### 1. 笔记本安装应用

安装 Node.js 24 LTS，确认 `node --version` 为 v24，并确认 `command -v node` 路径。下面的服务模板默认 `/usr/bin/node`，实际路径不同时修改模板。将项目复制到 `/opt/multiworks`，执行：

```bash
sudo useradd --system --home /opt/multiworks --shell /usr/sbin/nologin multiworks
sudo install -d -o multiworks -g multiworks -m 700 /var/lib/multiworks
cd /opt/multiworks
npm ci --omit=dev
sudo cp .env.example .env
sudo chown root:multiworks .env
sudo chmod 640 .env
```

编辑 `.env`，先保持 `PUBLIC_ORIGIN=` 和 `COOKIE_SECURE=false`，设置 `DATA_DIR=/var/lib/multiworks`，其他值如下：

```ini
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/multiworks
PUBLIC_ORIGIN=
COOKIE_SECURE=false
MAX_FILE_MB=100
```

安装和启动：

```bash
sudo cp deploy/multiworks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now multiworks
```

在笔记本浏览器打开 http://127.0.0.1:3000 完成设置。如果 Ubuntu Server 无浏览器，在当前电脑建立 SSH 本地转发：`ssh -L 3000:127.0.0.1:3000 用户名@笔记本局域网地址`，再打开当前电脑的 http://127.0.0.1:3000。

### 2. 云服务器设置中转

准备域名，将 `work.example.com` 的 A 记录指向云服务器公网 IP。使用 frp 官方发行版，在云服务器放置 `/usr/local/bin/frps`，笔记本放置 `/usr/local/bin/frpc`。两端使用同一个版本。创建 `/etc/frp`，分别从 `deploy/frps.toml.example` 和 `deploy/frpc.toml.example` 复制配置，替换公网 IP 与两端相同的随机密钥。可用 `openssl rand -hex 32` 生成。

云服务器创建专用用户 `sudo useradd --system --shell /usr/sbin/nologin frp`，配置文件权限设为 `root:frp`、640。笔记本的客户端配置设为 `root:multiworks`、640。对应服务文件复制到 `/etc/systemd/system/` 后，运行 `systemctl daemon-reload` 和 `systemctl enable --now frps` / `frpc`。

配置强制 TLS；正式部署建议为 frps 配置证书，并在 frpc 设置 `transport.tls.trustedCaFile` 和 `transport.tls.serverName`，验证中转服务器身份。密钥不得提交到仓库。

云端安装 Caddy，使用 `deploy/Caddyfile.example` 替换为实际域名，配置到 `/etc/caddy/Caddyfile` 并重载 Caddy。它负责公网 HTTPS 和 WebSocket 转发。不要开启访问正文日志、响应缓存或上传请求缓冲。默认配置不在云端持久保存文件和消息。云端终止 HTTPS，因此管理员技术上能读取转发内容，这不是端到端加密系统。

腾讯云安全组只需开放公网 80/443、frp 7000，以及受限制的管理端口。18080 仅监听云端回环地址，不对公网开放；笔记本 3000 不对外开放。公网 HTTPS 依赖域名解析和证书签发成功。中国大陆云节点使用域名提供服务前，请按腾讯云控制台指引完成适用的备案流程。

### 3. 启用正式 HTTPS 地址

完成本地初始化后，在笔记本 `.env` 设置：

```ini
PUBLIC_ORIGIN=https://你的实际域名
COOKIE_SECURE=true
```

随后 `sudo systemctl restart multiworks`。其他设备访问这个 HTTPS 地址登录。`PUBLIC_ORIGIN` 不带末尾斜杠。正式模式必须通过此地址访问，本地 HTTP 的写操作将被拒绝，这是预期行为。

### 4. 保持在线与备份

- 禁止笔记本自动睡眠；合盖是否休眠也要检查。尽可能使用有线网络。
- 云端中转无法替代离线笔记本，笔记本关闭或断网时无法访问内容。
- 服务用户独占数据目录；不要直接公开 `data` 或 `/var/lib/multiworks`。
- 备份时先 `sudo systemctl stop multiworks`，复制整个 `/var/lib/multiworks`（含数据库、WAL/SHM 与 files）到外接硬盘，再启动服务。备份同样包含敏感信息与有效会话，妥善保管。
- 日志：`journalctl -u multiworks -u frpc -f`；云端检查 `frps` 与 `caddy`。

## Windows 11 服务电脑

同样使用 Node.js 24、`npm ci` 和 `.env`。首次在本机初始化，再将 frpc 指向本机 3000。通过任务计划程序分别让 Node 和 frpc 在开机时启动（无需用户登录），配置工作目录和失败重启，并关闭睡眠。云端中转配置不变。初版附带的是 Ubuntu systemd 模板，Windows 任务计划需在实际机器上设置。

## 验证

`npm test` 验证：未登录拒绝访问、跨来源请求拒绝、两个设备的实时消息、群记录隔离、重复请求去重、中文文件名、文件访问鉴权、Range 下载、文件大小限制、撤销会话、重启后的文件与记录持久性。测试使用独立临时数据，清理后不会影响真实资料。

还需在实际公网环境验收：两设备同时登录；分别切换不同群发消息；上传代表性的 PDF 和 ZIP；断开网络后恢复；检查上传、下载速度与重连补齐；重启笔记本验证服务自动恢复。速度由家里上传带宽、云服务器带宽和设备网络决定。

参考：[frp 官方文档](https://gofrp.org/zh-cn/docs/overview/)、[frp TLS](https://gofrp.org/zh-cn/docs/features/common/network/network-tls/)、[Ubuntu 生命周期](https://ubuntu.com/about/release-cycle)。
