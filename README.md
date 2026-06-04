# AI-VPN: AI-Friendly VPN & Proxy Client

![AI-VPN Banner](./banner.png)

AI-VPN 是一款面向大语言模型（LLM / AI Agent）自主运行及人机协同场景设计的 **智能网络路由代理系统**。它能够方便 AI Agent 通过命令行（CLI）或 REST API 自动感知网络延迟、一键拉取节点、自我修复网络联通性，同时为人类管理员提供直观的可视化 Web 仪表盘和「人类覆盖锁定」（Human Override Lock）安全隔离墙，保障代理运行的安全和网络稳定。

---

## 🌟 核心特性

- **🤖 AI Agent 友好**：支持完全的命令行操控及 JSON 格式输出，方便 Agent 解析、监控及调度路由。
- **🛡️ 人类覆盖锁定（Human Override Lock）**：管理员可在 Web 仪表盘一键锁定配置。锁定状态下，AI 任何路由切换请求均会被拦截，只有人类用户通过传递 `--human` 参数才能强制切换，防止大模型发生网络配置暴走。
- **🌎 物理出口地理位置深度感知**：通过独立的 SOCKS5 握手协议，穿透代理通道请求 `http://ifconfig.co/json`，从而精准获知代理出口的真实 IP 与地理位置（国家、城市、时区），且完全不与宿主机系统本身的默认 VPN 路由冲突。
- **🛡️ 纯净 DNS 解析（DoH 旁路劫持）**：在拉取节点及启动网络通道前，使用 **AliDNS** / **Cloudflare** 的 DNS-over-HTTPS (DoH) 进行解析，完美规避 Clash/Fake-IP 导致的 DNS 回环超时及 EOF 错误。
- **📦 Git 代理自动配置**：当 `sing-box` 隧道建立后，后台守护进程将自动配置全局 Git 代理（`http://127.0.0.1:4141`），保证 AI 的 `git push/pull` 稳定畅通，并在断开连接后自动清除，零残留。
- **⚡ 智能自愈（Auto-Healer）**：当网络检测到连续 3 次心跳超时时，自愈模块将自动检索可用备用节点进行测试，成功连通后自动更新配置。

---

## 🛠️ 系统架构

AI-VPN 分为三大核心模块：
1. **`backend/` (Daemon 守护服务)**：运行在 `4140` 端口。管理持久化 JSON 数据，调度 `sing-box` 与 `OpenVPN` 子进程，负责心跳检测、自愈及本地 HTTP/SOCKS5 代理分发（`4141` 端口）。
2. **`cli/` (命令行客户端)**：供人类或 AI 调用，与守护进程的 API 交互。
3. **`frontend/` (可视化仪表盘)**：基于 React + Vite 构建的赛博朋克风暗黑仪表盘，提供网速折线图、心跳延迟、地理位置定位及 AI 操作日志实时滚动监控。

---

## 🚀 快速开始

### 1. 运行守护进程
```bash
cd backend
npm install
npm start
```

### 2. 运行 Web 仪表盘
```bash
cd frontend
npm install
npm run dev
```
打开浏览器访问 [http://localhost:5173](http://localhost:5173)。

### 3. 全局安装 CLI
```bash
cd cli
npm install
npm link
```

---

## 💻 CLI 常用命令

```bash
# 查看当前连接状态、出口 IP 及地理位置
ai-vpn status

# 以 JSON 格式输出状态（供 AI 解析）
ai-vpn status --json

# 导入订阅链接（Trojan / anytls Base64 格式）
ai-vpn import "https://your-subscription-url/api/v1/sub"

# 列出当前所有可用网络节点
ai-vpn list

# 连接到指定节点 (AI 执行)
ai-vpn connect "香港1"

# 人类管理员强制覆盖锁定连接到指定节点
ai-vpn connect "香港1" --human

# 断开所有 VPN/Proxy 隧道，恢复直连
ai-vpn disconnect

# 强制触发自愈（Heal）检查，自动切换到低延迟健康节点
ai-vpn heal
```

---

## 🧪 自动化集成测试

本项目包含完整的网络诊断与联通性测试套件。可运行以下命令测试节点解析、Google 联通性及出口 IP 匹配逻辑：
```bash
cd backend
node src/test-vpn.js
```
