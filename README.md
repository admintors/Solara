# 🎶 Solara 2.0（光域）

<p align="center">
  <a href="https://trendshift.io/repositories/23480" target="_blank"><img src="https://trendshift.io/api/badge/trendshift/repositories/23480/daily?language=JavaScript" alt="#1 JavaScript Repository Of The Day" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/23480" target="_blank"><img src="https://trendshift.io/api/badge/trendshift/repositories/23480/weekly?language=JavaScript" alt="#2 JavaScript Repository Of The Week" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/23480" target="_blank"><img src="https://trendshift.io/api/badge/trendshift/repositories/23480/monthly?language=JavaScript" alt="#13 JavaScript Repository Of The Month" width="250" height="55"/></a>
</p>

> 🚀 **Solara 2.0 重磅进化**：由轻量后端服务支撑的现代化网页音乐播放器。2.0 版本彻底告别单体脚本，迈向现代化工业级模块解耦架构，带来网易云三大官方顶尖榜单音乐雷达、全功能自由拖拽与胶囊折叠调试台、Apple Design 深度流体美学与 iPhone 性能优化，以及极致平滑稳定的全平台播放体验。

> **Docker 多用户版（feat/multi-user-v1）**：账号、邀请、会话、收藏、队列、命名歌单和设备进度由 Node.js + SQLite 管理；Wrangler 仅在容器内作为受保护音乐代理。此实现不部署 Cloudflare Pages 或使用 D1。部署、旧数据指定 owner 迁移、备份与恢复说明见 [Docker 多用户运维文档](docs/DOCKER_MULTIUSER_OPERATIONS.md)。本轮不是线上环境切换指南。

![Solara Preview](./Preview.gif)
| | | |
|:--:|:--:|:--:|
| <img src="./1.png" height="700"/> | <img src="./2.png" height="700"/> | <img src="./3.png" height="700"/> |


## 🤝 参与贡献
感谢 GD音乐台(music.gdstudio.xyz)提供的免费API

感谢 来自Linux.do 牛就是牛@ufoo 大佬 https://linux.do/t/topic/942415 提供的灵感


## 🌟 2.0 核心特性

- 🔍 **跨站曲库检索与无感记忆**：一键切换数据源（网易云/QQ/酷狗等），切换平台不再误触发自动请求；自动记忆检索关键词与最近搜索结果，重焦即刻恢复；支持分页浏览与批量导入播放队列。
- 🧭 **官方榜单音乐雷达**：重构为动态轮询网易云三大官方榜单（**热歌榜、飙升榜、新歌榜**）Top 20，并执行实时智能去重与随机注入，兼顾爆款流行与新鲜探索。
- 🎨 **Apple Design 流体极光美学**：内置亮/暗模式与玻璃拟态界面。采用**前后端双重取色算法**（后端调色板分析 + 前端 Canvas 智能降级），全域无缝消除原生滚动条；重构登录界面，与主站流体极光和磨砂玻璃 100% 视觉对齐。
- 🚀 **受保护的音乐 API 代理**：保留歌曲搜索、播放和歌词链路；容器内代理只短时缓存有效响应，并跳过空搜索结果与上游错误。
- 👤 **Docker 多用户曲库**：Node.js + SQLite 管理邀请账号、会话、个人收藏、队列、命名歌单和设备进度；Wrangler 只在容器内作为受保护的音乐代理。
- 📝 **动态歌词视图**：逐行平滑滚动高亮，当前行自动聚焦，手动滚动后锁定视图并支持 3 秒自动回位。
- ❤️ **收藏列表独立管理**：搜索结果与播放列表均可一键收藏，收藏列表拥有独立的播放进度、播放模式与批量操作面板。
- 📥 **多码率自由切换**：支持 128K / 192K / 320K / FLAC 无损等高音质切换并直接获取音频。
- 🔒 **全平台锁屏控制**：锁屏界面自动同步高分辨率专辑封面与曲目信息，完美支持 MediaSession 标准。
- 🔄 **列表导入导出**：支持播放队列与收藏列表统一导入/导出，可一键迁移或恢复歌曲。
- ⚙️ **隐藏式高级设置**：桌面端**双击左上角 Logo/站点标题**、移动端**双击顶部标题栏**，即可呼出极简设置面板，配置音质首选项、调试模式开关与个性化参数。
- 🛠️ **全功能调试悬浮窗**：支持桌面/移动端自由拖拽、一键/双击折叠为 38px 胶囊横条，全链路生命周期彩标药丸日志输出。

## 🚀 Docker 多用户版部署

此分支提供 Docker Compose 单实例部署。账号、会话、权限和个人曲库由 Node.js + SQLite 管理；Wrangler 只在容器内运行受保护的音乐代理。没有 Cloudflare Pages 部署或 D1 数据库配置。

```bash
git clone -b feat/multi-user-v1 https://github.com/admintors/Solara.git
cd Solara
cp .env.example .env
```

编辑 `.env`，至少设置反向代理对外使用的 HTTPS 来源地址：

```dotenv
APP_ENV=production
PUBLIC_ORIGIN=https://music.example.com
API_BASE_URL=https://music-api.gdstudio.xyz/api.php
# 仅当反向代理 IP/CIDR 固定且可信时填写
TRUSTED_PROXY_CIDRS=
```

准备持久化目录并启动容器。Compose 默认仅将服务绑定到本机 `127.0.0.1:8080`，由现有反向代理提供 HTTPS：

```bash
install -d -o 1000 -g 1000 ./data ./data/backups ./data/imports
docker compose up -d --build
docker compose exec solara node /app/server/cli.js init-db
docker compose exec solara node /app/server/cli.js create-admin --username admin --display-name 管理员
```

创建管理员时，密码通过终端输入，不写入 `.env`。管理员登录后可在“账号管理”页面创建一次性邀请。用户需通过邀请设置自己的用户名和密码。

- `PUBLIC_ORIGIN` 在生产环境必须是外部 HTTPS 来源，并与访问域名完全一致。
- `API_BASE_URL` 可选；数据持久化在宿主机 `./data`。
- `TRUSTED_PROXY_CIDRS` 只填写部署拓扑中固定、可信的反向代理地址。
- 不再使用旧版 `PASSWORD`、`LANGUAGE` 环境变量，也不需要手工创建 D1 表。

旧数据指定 owner 迁移、个人 JSON 导入、备份和恢复步骤见 [Docker 多用户运维文档](docs/DOCKER_MULTIUSER_OPERATIONS.md)。本 README 说明的是本分支部署方式，不代表线上环境已切换。

---
## 🧭 音乐雷达 (Official Top Charts Radar)
- **权威官方榜单联动**：雷达每次触发时，会自动从网易云官方三大顶尖榜单——**热歌榜**（3778678）、**新歌榜**（3779629）、**飙升榜**（19723756）中轮询抽取并解析前 20 首曲目。
- **智能去重与随机注入**：自动过滤当前播放列表中已存在的歌曲，经随机乱序后无缝加入队列，让每一次雷达探索既能听到当下最火热的高品质音乐，又能发现宝藏冷门新歌。

## ⚙️ 隐藏高级设置 (双击标题呼出)
为了保持界面的极致极简与沉浸感，播放器的高级设置面板采用了隐式彩蛋交互设计：
- **桌面端**：**双击左上角「Solara」Logo / 站点标题** 即可打开高级设置面板。
- **移动端**：**双击顶部导航栏标题** 即可随时唤出设置。
- **设置能力**：支持自定义雷达榜单（热歌榜/新歌榜/飙升榜）、快捷开关调试控制台、配置首选音质解析策略并查看账号同步状态。

## 🎵 使用流程
1. 输入关键词并选择想要的曲库后发起搜索（切换曲库不自动清空和刷新）。
2. 在结果列表中可试听、播放、下载或加入播放队列。
3. 点击列表中的心形图标即可收藏歌曲，收藏列表支持快捷下载、添加至播放列表或批量清空。
4. 右侧播放/收藏列表展示当前曲目，可拖动播放、移除或一键清空。
5. 底部控制栏提供播放控制、播放模式切换、进度条与音量滑块。
6. 打开歌词面板即可查看实时滚动的高亮歌词。

## 📱 移动端体验提示
- 将网页添加到手机主屏（PWA 体验）或通过移动浏览器访问，自动切换至竖屏极简布局；
- 底栏控件重新排布，保证竖向滑动不遮挡核心信息；
- 虚拟键盘唤起时自适应视口高度，保证搜索面板操作不被遮挡；
- 点击封面可切换到沉浸式歌词面板，支持丝滑手势展开/收起。

## ❓ 常见问题解答
- **搜索没有结果怎么办？** 检查浏览器控制台日志，如接口被阻挡可尝试切换数据源或更新 `API.baseUrl` 至可用服务，很有可能是免费 API 临时波动。
- **如何重置本地数据？** 在浏览器开发者工具的 Application / Storage 面板清理 `localStorage`，即可恢复默认播放列表和配置。
- **收藏或播放列表如何备份？** 使用播放队列或收藏列表顶部的「导出」按钮生成 JSON 文件，日后可通过对应列表的「导入」按钮恢复，同时可一键将收藏歌曲添加回播放列表。

## 🛠️ 调试控制台 (Debug Console)
* **呼出方式**：PC 端按下快捷键 **Ctrl + D**；移动端可在「设置」面板中一键开启。
* **自由拖拽**：按住控制台顶部标题栏可自由拖拽至屏幕任意角落，具备可视窗口边缘碰撞保护，防止拖出屏幕。
* **胶囊横条折叠**：点击右上角折叠按钮（`－` / `＋`）或**双击标题栏**，面板即刻平滑收缩为 38px 高度的单行胶囊横条，不遮挡界面，且在折叠状态下依然支持拖动停靠。
* **全链路彩标药丸日志**：

| 日志徽标 | 监控范围 | 核心记录指标 |
| :--- | :--- | :--- |
| `[音频播放]` | 播放核心 | 切歌事件、码率音质选择（128k/320k/999k）、音频直链/代理耗时、解码就绪与异常重试 |
| `[歌曲搜索]` | 检索链路 | 发起搜索、音源平台、请求关键词、分页页码、API 返回曲目数量与缓存状态 |
| `[音乐雷达]` | 榜单抓取 | 官方榜单名称/ID、抓取 Top 20 进度、智能去重增量曲目数 |
| `[歌词解析]` | 歌词引擎 | 歌词请求 URL、成功解析有效行数统计、暂无歌词/错误降级 |
| `[极光背景]` | 视觉渲染 | 封面图片地址、本地色盘缓存命中、内存复用、云端后端/前端 Canvas 取色 |
| `[播放列表]` | 队列状态 | 单曲增删（实时剩余数追踪）、列表清空、收藏增删、循环播放模式切换 |
| `[异常错误]` | 容灾防线 | 网络断开、API 鉴权失败、音频上下文被阻断拦截警告 |

---

## 🗂️ 项目结构
```
Solara/
├── css/                         # 原生 CSS 设计系统与响应式界面
├── js/
│   ├── core/auth.js             # 同源会话、CSRF、账号切换与请求保护
│   ├── core/storage.js          # 用户分区和 Node API 同步
│   ├── core/audio.js            # 原生音频播放器状态机
│   ├── features/                # 搜索、收藏、队列、歌词与设置
│   └── account-ui.js            # 账号、歌单和设备进度界面
├── functions/proxy.ts           # 由容器内 Wrangler 运行的音乐代理逻辑
├── server/
│   ├── migrations/              # SQLite 版本化迁移
│   ├── routes/                  # 账号、曲库、代理与安全取色接口
│   └── internal-proxy/          # 仅容器内使用的 Wrangler 运行目录
├── docs/DOCKER_MULTIUSER_OPERATIONS.md
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── index.html
└── login.html
```
## 📄 许可证
本项目采用 CC BY-NC-SA 协议，禁止任何商业化行为，任何衍生项目必须保留本项目地址并以相同协议开源。
