# 棋匠 (ChessCraft)

一个本地运行的中国象棋变体创作与对战平台：可视化编辑自定义棋规，用自带 JS 引擎（可选 Fairy-Stockfish）对弈，局域网内随时联机。

> 仅需 Node.js（无任何 npm 包），启动即用。

## ✨ 功能

- **自定义棋规** — 图形化编辑棋盘、棋子走法（直线 / 日字 / 田字 / 斜线 / 滑行 / 跳跃），规则实时生效
- **双引擎对弈** — 默认内置 JS AI（稳健 / 平衡 / 随机三种风格），开箱即用；可选对接 Fairy-Stockfish 获得更强棋力，自动把规则 JSON 转换为引擎变体定义，无法完全映射的棋规自动回退到内置 AI
- **联机对战** — 创建房间即可对战，支持局域网内设备访问页面加入
- **预设系统** — 内置标准象棋等预设，一键保存 / 加载 / 分享规则
- **独立版导出** — 把任一自定义变体导出为单文件 HTML，脱离服务器即可分享
- **自对弈报告** — 引擎自对弈并输出报告，便于验证平衡

## 🚀 快速开始

**前置条件**：安装 [Node.js](https://nodejs.org/)（任意较新版本即可）。

**方式一（推荐）**：双击 `点我启动.bat`，浏览器自动打开 http://localhost:8765

**方式二**：命令行运行

```bash
node server.js
```

然后访问 http://localhost:8765（保持终端窗口开启；关闭即停止服务）。

### Fairy-Stockfish 引擎安装（可选）

AI 对弈开箱即用（内置 JS 引擎）。Fairy-Stockfish 是可选增强引擎：棋力更强，但仅能映射部分棋规，无法完全映射的走法会自动回退到内置 AI。如需安装：

1. 前往 [Fairy-Stockfish 官方 Releases](https://github.com/fairy-stockfish/Fairy-Stockfish/releases) 下载
   **`fairy-stockfish-largeboard_x86-64.exe`**（Windows 64 位）
2. 将文件放入项目的 `engine/` 目录
3. 重启服务即可使用此引擎对弈

## 📁 目录结构

```
ChessCraft/
├── index.html          # 前端主页面（单文件应用）
├── server.js           # 本地服务（端口 8765）
├── 点我启动.bat         # 一键启动脚本
├── preset/             # 棋规预设
├── engine/             # 引擎目录（可选，需自行下载 Fairy-Stockfish exe）
└── game/               # 独立版导出目录（运行时生成）
```

## 🔌 主要 API

| 接口 | 说明 |
|---|---|
| `GET /api/presets` | 列出预设 |
| `GET /api/preset?file=xx` | 读取预设内容 |
| `POST /api/preset/save` | 保存当前规则为预设 |
| `POST /api/standalone` | 导出独立版单文件 HTML |
| `GET /api/engine/status` | 引擎状态 |
| `POST /api/engine/configure` | 规则 JSON → variants.ini 并重启引擎 |
| `POST /api/engine/move` | FEN + 变体 → 引擎着法 |
| `POST /api/room/*` | 联机房间（create / join / move / poll / restart / over / leave） |

## 📄 许可

- **本项目代码**：MIT License（见 [LICENSE](LICENSE)）
- **可选 AI 引擎**：[Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish)（**GPL-3.0**，[源码](https://github.com/fairy-stockfish/Fairy-Stockfish)）。本项目不附带其二进制，由用户自行下载安装；引擎以独立进程方式与项目通信，二者不构成衍生作品。
