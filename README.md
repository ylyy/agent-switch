# ⚡ Agent Switch

> 多 Agent 对话管理工具（快捷浏览、统一搜索、自定义标签与归类）

`agent-switch` 是一个零依赖的轻量级本地 AI Agent 会话管理工具。它可以自动扫描本地多种 AI 编程助手（如 Claude Code、Codex、Gemini、Qoder、OpenCode、OpenClaw 等）的会话记录，并提供高效的浏览、检索和分类管理能力。

---

## ✨ 核心特性

- 🔍 **统一扫描**：一键归集多个 Agent 的本地历史对话。
- 🏷️ **标签归类**：支持自定义标签、规则归类与标记。
- ⚡ **全文搜索**：快速搜索历史对话中的代码段与关键讨论。
- 📁 **层级导航**：按 Agent / 项目 / 标签灵活筛选查看。
- 🚀 **零外部依赖**：使用 Node.js 原生 API 开发，轻量即启。

---

## 🛠️ 快速开始

### 依赖环境
- Node.js >= 16.0.0

### 方式一：npx 一条命令启动（推荐，无需 clone）
在任意电脑上执行：
```bash
npx github:ylyy/agent-switch
```
启动后访问 `http://localhost:4777`，看到的即是当前这台电脑本地的 Agent 会话记录。

> 标签、配置、AI 总结等数据保存在 `~/.agent-switch/` 目录，不会随 npx 缓存清理而丢失。

### 方式二：本地启动
```bash
git clone https://github.com/ylyy/agent-switch.git
cd agent-switch
npm start
```
默认会在本地启动服务：`http://localhost:4777`

---

## 📄 开源协议
[MIT License](LICENSE)
