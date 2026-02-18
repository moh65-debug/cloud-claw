# Cloud Claw (Cloudflare + OpenClaw)

**Cloud Claw** 是一个在 Cloudflare Workers + Containers 上运行 [OpenClaw](https://github.com/openclaw/openclaw) 的容器化 AI 助手。

Worker 负责路由和认证，将请求转发到运行 OpenClaw 网关实例的单例容器，并通过 Cloudflare Browser Rendering 代理 Chrome DevTools Protocol (CDP) 会话。

[English](README.md) | 简体中文

---

## 🛠 技术栈

- **运行时**: Cloudflare Workers + Containers
- **语言**: TypeScript (ES2024)
- **包管理器**: pnpm
- **容器规格**: 1 vCPU, 4GB RAM, 8GB 磁盘
- **浏览器**: Cloudflare Browser Rendering（远程 CDP）
- **核心库**:
  - `cloudflare:workers`: Workers 标准库
  - `@cloudflare/containers`: 容器管理
- **容器基础镜像**: `nikolaik/python-nodejs:python3.12-nodejs22-bookworm`
- **存储**: TigrisFS 挂载 S3/R2

## 🚀 快速开始

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/miantiao-me/cloud-claw)

### 前置要求

- Node.js (v22+)
- pnpm (v10.28.2+)
- Wrangler CLI (`npm i -g wrangler`)

### 安装依赖

```bash
pnpm install
```

### 本地开发

启动本地开发服务器：

```bash
pnpm dev
```

### 代码检查

运行格式化工具 (oxfmt) 和代码检查 (oxlint)：

```bash
pnpm lint
```

### 生成类型定义

如果你修改了 `wrangler.jsonc` 中的 bindings，需要重新生成类型文件：

```bash
pnpm cf-typegen
```

## 📦 部署

部署代码到 Cloudflare 全球网络：

```bash
pnpm deploy
```

## 📂 项目结构

```
.
├── src/
│   ├── index.ts        # Workers 入口，路由，基本认证
│   ├── container.ts    # AgentContainer 类（继承自 Container），WebSocket 网关
│   └── cdp.ts          # Chrome DevTools Protocol 代理（分块二进制 WebSocket 帧）
├── Dockerfile          # 容器镜像：OpenClaw 网关 + TigrisFS S3 挂载
├── worker-configuration.d.ts # 自动生成的 Cloudflare 绑定类型（请勿编辑）
├── wrangler.jsonc      # Wrangler 配置（容器、绑定、部署区域）
├── tsconfig.json       # TypeScript 配置
└── package.json
```

## 💾 数据持久化 (S3/R2)

容器内置了对 S3 兼容存储（如 Cloudflare R2, AWS S3）的支持，通过 `TigrisFS` 将对象存储挂载为本地文件系统，实现数据的持久化保存。

### 环境变量配置

要启用数据持久化，需要在容器运行环境中配置以下环境变量：

| 变量名                   | 描述                                     | 是否必须 | 默认值   |
| ------------------------ | ---------------------------------------- | -------- | -------- |
| `S3_ENDPOINT`            | S3 API 端点地址                          | ✅ 是    | -        |
| `S3_BUCKET`              | 存储桶名称                               | ✅ 是    | -        |
| `S3_ACCESS_KEY_ID`       | 访问密钥 ID                              | ✅ 是    | -        |
| `S3_SECRET_ACCESS_KEY`   | 访问密钥 Secret                          | ✅ 是    | -        |
| `S3_REGION`              | 存储区域                                 | ❌ 否    | `auto`   |
| `S3_PATH_STYLE`          | 是否使用 Path Style 访问                 | ❌ 否    | `false`  |
| `S3_PREFIX`              | 存储桶内的路径前缀（子目录）             | ❌ 否    | (根目录) |
| `TIGRISFS_ARGS`          | 传递给 TigrisFS 的额外挂载参数           | ❌ 否    | -        |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 访问令牌（用于 Web UI 连接验证） | ✅ 是    | -        |
| `WORKER_URL`             | Worker 公开 URL（用于 CDP 代理配置）     | ✅ 是    | -        |

### 工作原理

1. **挂载点**: 容器启动时，会将 S3 存储桶挂载到 `/data`。
2. **工作目录**: 实际的工作空间位于 `/data/workspace`。
3. **OpenClaw 配置**: OpenClaw 的配置文件会存储在 `/data/.openclaw` 中，确保状态持久化。
4. **初始化**:
   - 如果 S3 存储桶（或指定的前缀路径）为空，容器会自动将预置的目录结构初始化。
   - 如果 S3 配置缺失，容器将回退到非持久化的本地目录模式。

### Web UI 初始化

首次启动后，OpenClaw 需要通过 Web UI 进行初始化配置。
请访问部署后的 URL（例如 `https://your-worker.workers.dev`），按照屏幕提示完成设置。

## 🌐 浏览器渲染（CDP 代理）

Cloud Claw 集成了 [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/)，通过 Chrome DevTools Protocol (CDP) 为 AI 助手提供无头浏览器功能。

### 工作原理

1. **OpenClaw** 通过 WebSocket 连接到 Worker 的 CDP 代理端点（`/cloudflare.browser/{token}`）。
2. **Worker** 从 Cloudflare Browser Rendering API 获取浏览器会话，并在 OpenClaw 和远程浏览器之间代理 CDP 消息。
3. **二进制帧**：CDP 消息使用 4 字节长度头进行分块，以处理 Cloudflare WebSocket 基础设施上的大负载。

### 配置

设置 `WORKER_URL` 和 `OPENCLAW_GATEWAY_TOKEN` 后，CDP 代理会自动配置。OpenClaw 容器会生成指向以下地址的浏览器配置：

```
{WORKER_URL}/cloudflare.browser/{OPENCLAW_GATEWAY_TOKEN}
```

认证通过 URL 路径中的令牌完成，无需额外配置。

## ⏰ 容器生命周期

默认情况下，容器在 10 分钟无活动后会自动休眠以节省资源。你可以自定义此行为：

### 保持容器常驻运行

如需阻止容器休眠，修改 `src/container.ts`：

```typescript
export class AgentContainer extends Container {
  sleepAfter = 'never' // 永不休眠（默认: '10m'）
  // ...
}
```

### 基于活动的保活（默认行为）

当前实现使用智能保活策略：容器在 AI 对话期间保持活跃，空闲时休眠。通过在收到聊天事件时调用 `renewActivityTimeout()` 实现：

```typescript
// 在 watchContainer() 中 - 每次对话完成时重置休眠计时器
if (frame.event === 'chat' && frame.payload?.state === 'final') {
  this.renewActivityTimeout()
}
```

### 可用选项

| `sleepAfter` 值 | 行为                        |
| --------------- | --------------------------- |
| `'never'`       | 容器永久运行                |
| `'10m'`         | 10 分钟无活动后休眠（默认） |
| `'1h'`          | 1 小时无活动后休眠          |
| `'30s'`         | 30 秒无活动后休眠           |

> **注意**：休眠时容器状态会被保留。下次请求时会自动唤醒，但冷启动可能需要几秒钟。

## 📝 开发规范

详细的开发规范、代码风格和 AI Agent 行为准则，请参考 [AGENTS.md](./AGENTS.md)。
