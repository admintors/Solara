# Docker 多用户运维、迁移与恢复

本分支只提供 Docker Compose 部署：Node.js/Express 管理账号、会话、权限和 SQLite 曲库。Wrangler 只在容器内部提供受保护的音乐代理；不部署 Cloudflare Pages，不使用 D1。反向代理、公开域名和 HTTPS 由部署方已有入口提供。

## 首次部署与管理员

在仓库目录准备 .env：

    APP_ENV=production
    PUBLIC_ORIGIN=https://music.example.com
    API_BASE_URL=https://music-api.gdstudio.xyz/api.php

启动容器后先创建数据库，再交互式创建首位管理员。密码通过终端隐藏输入，不要把密码放进命令参数或环境文件。

    docker compose up -d --build
    docker compose exec solara node /app/server/cli.js init-db
    docker compose exec solara node /app/server/cli.js create-admin --username admin --display-name 管理员

管理员离线恢复可执行 reset-password --username admin，密码仍由终端隐藏输入，并会撤销该账号现有会话。管理员登录后在“账号管理”生成七天有效邀请。邀请链接只在创建时显示一次；需要时可撤销尚未使用的邀请。重置链接只能使用一次，有效期 30 分钟。管理员重置后，目标账号已有会话会失效。初始管理员也可在容器内按需执行 create-admin，但只有不存在活动管理员时才会成功。

## 旧版 D1/SQLite 数据迁移

迁移前停止旧容器，留存完整 /data 目录副本。不要让旧版和新版同时写同一个数据目录。新版使用 /data/solara-multiuser.db，旧的 /data/solara.db 只作为来源，不会被自动认领。

    docker compose stop solara
    # 将原 data 目录做文件系统级副本并保留原目录
    docker compose up -d --build
    docker compose exec solara node /app/server/cli.js init-db
    docker compose exec solara node /app/server/cli.js create-admin --username admin --display-name 管理员
    docker compose exec solara node /app/server/cli.js import-legacy --owner admin --source /data/solara.db --dry-run
    docker compose exec solara node /app/server/cli.js import-legacy --owner admin --source /data/solara.db

必须把目标 owner 写清楚。迁移先用 SQLite VACUUM INTO 生成一致性快照并计算摘要；dry-run 输出队列、收藏、重复、异常和恢复进度计数，不写入新曲库。实际导入在单个事务内追加数据、保存隔离的异常记录和审计事件。相同来源摘要重复导入不会再次写入；同一旧库摘要改指定另一 owner 会被拒绝。

旧 currentSong、列表上下文和进度会作为 legacy-import 设备状态保存。登录后从“恢复设备进度”显式恢复到当前设备。缺少歌曲 ID、来源或格式错误的记录进入该 owner 的待修复报告，不按歌名猜配。播放器音量等设备偏好不会广播到其他设备。

### 导入个人 JSON 备份

完整的 Solara JSON 导出可通过离线 CLI 导入。先将文件放入宿主机的 ./data/imports/（该目录由 Compose 挂载到 /data/imports），先 dry-run，再执行：

    docker compose exec solara node /app/server/cli.js import-user --owner username --source /data/imports/solara-export-v2.json --dry-run
    docker compose exec solara node /app/server/cli.js import-user --owner username --source /data/imports/solara-export-v2.json

CLI 限制输入文件为 20 MiB、歌曲总数为 10000，并按账号、来源类型和 SHA-256 摘要去重。支持队列、收藏、命名歌单与允许的偏好字段；不信任文件中的 owner、role、设备或歌曲元数据。导入失败会回滚，不留下半次导入。

## 备份和恢复

运行中备份使用 SQLite 一致性快照，包含已提交的 WAL 内容。备份保存在 /data/backups，权限为私有文件权限；按需要将其复制到受控的离线存储：

    docker compose exec solara node /app/server/cli.js backup
    docker compose exec solara node /app/server/cli.js backup --output /data/backups/before-upgrade.db

恢复前停止所有连接到数据库的容器。CLI 会先校验备份的 SQLite 完整性，把当前库另存为 .pre-restore-<时间戳>.db，再切换数据库并重新运行迁移与完整性检查：

    docker compose stop solara
    docker compose run --rm --no-deps --entrypoint node solara /app/server/cli.js restore --input /data/backups/before-upgrade.db
    docker compose up -d solara

恢复时不要删除原数据库或 .pre-restore 文件。备份演练要在隔离的数据目录与同版本镜像上完成。不要将数据库、备份、导出文件或邀请链接放入 HTTP 静态目录或公开日志。

## 回退

回退到旧镜像前，先备份新版库并保存完整的新版导出。旧版共享数据模型不能接收新版新增账号、每人收藏/队列、命名歌单和设备进度；这些新数据不会自动合并回旧库。保留新版数据目录，避免回退覆盖可恢复的数据。

## 当前交付检查边界

远程自动化用例覆盖指定 owner 迁移、重复导入、跨 owner 拒绝、一次性 token 并发、跨用户访问、旧版本队列写入和备份恢复。未在本轮执行本地测试、Docker 容器或真实旧库迁移演练。最终以本分支 GitHub Actions 的实际状态和 PR 检查记录为准；设备检查与真实带宽容量试验待后续安排。
