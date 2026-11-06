# Solara Docker 多用户第一版实施方案

本方案交由 Luna 执行，将 Solara 改造成邀请制的多用户音乐站。第一版采用 Docker、Node.js、Express 和 SQLite，保留现有播放器和原生 JavaScript 前端。每位用户拥有独立收藏、播放队列、命名歌单和设置；同一用户可以在不同设备间同步曲库并主动恢复播放进度。

交付范围仅为 Docker 版。账号和业务数据全部由 Node.js 与 SQLite 管理。容器内部现有的 Wrangler 仅保留为音乐 API 兼容代理，不承担登录、用户存储或 D1 数据同步。

执行方式以 GitHub 为准：直接读取、修改并提交目标仓库的开发分支。当前暂时忽略本地测试，不要求克隆仓库、搭建本地环境或运行本地 Docker。测试脚本和验收标准保留；可运行的验证优先放到 GitHub Actions，尚未执行的检查必须标为待验证。

# 1 项目基线与执行约定

| 项目 | 确定值 |
| --- | --- |
| 目标仓库 | [admintors/Solara](https://github.com/admintors/Solara) |
| 基准提交 | [f18015be89724e0951ee3319735093da7edab22e](https://github.com/admintors/Solara/commit/f18015be89724e0951ee3319735093da7edab22e) |
| 开发分支 | feat/multi-user-v1 |
| 方案在仓库中的路径 | docs/SOLARA_DOCKER_MULTIUSER_PLAN.md |
| 代码修改方式 | 通过 GitHub 连接或 GitHub API 直接修改开发分支并分阶段提交 |
| 当前验证方式 | 暂不做本地测试；优先 GitHub Actions，记录真实状态 |
| 主要部署方式 | Docker Compose 单实例 |
| 前端 | 保留现有 HTML、CSS、ES modules 和 Audio 播放逻辑 |
| 后端与数据库 | Express、Node.js 22 的兼容补丁版本、node:sqlite |
| 交付结果 | GitHub 开发分支与草稿 PR、Docker 配置、远程检查记录、迁移和恢复说明；CI 可用时附镜像构建结果 |

先通过 GitHub 读取 main、开发分支的最新提交、文件树、仓库内适用的 AGENTS.md 和现有 workflows。已有开发分支时继续该分支，不覆盖他人提交；分支不存在时从已核对的 main 创建。基线已经前移时先阅读差异，不强制复位或强推。

直接在 GitHub 上读取文件、创建或更新文件、提交变更并创建草稿 PR。更新前读取当前文件 blob SHA，成组文件尽量使用同一提交；出现并发修改冲突时重新读取并合并，不能覆盖远程新内容。只有在仓库权限范围内执行，不索取本地构建机、SSH 或额外服务凭据。

按后文阶段依次完成，每个阶段保持可检查的独立提交。当前不运行本地测试、win-build、本地容器或本地浏览器验收；编写必要的测试代码与 GitHub Actions 配置不受此限制。Actions 可用时运行并处理代码导致的失败；因权限、额度或环境条件无法运行时记录原因，继续完成代码和草稿 PR，不把缺少本地测试环境当作停工条件。

本轮交付以 GitHub 上的开发分支、草稿 PR、Docker 配置和如实记录的验证状态为终点；现有线上环境的切换另行安排。

# 2 第一版功能边界

| 功能 | 第一版行为 |
| --- | --- |
| 管理员初始化 | 使用容器内 CLI 创建首位管理员，无公网初始化接口 |
| 注册 | 管理员生成一次性邀请链接，受邀者设置自己的用户名和密码 |
| 登录与退出 | 独立账号、服务端会话、明确的退出入口 |
| 账号管理 | 查看账号、禁用和启用账号、生成一次性密码重置链接 |
| 个人曲库 | 独立收藏、一个系统播放队列、多个命名歌单 |
| 歌单操作 | 创建、重命名、删除、添加和移除歌曲、排序、导入和导出 |
| 跨设备同步 | 收藏、歌单、系统队列和账号偏好可同步；播放进度按设备保存 |
| 接续播放 | 用户主动选择从最近设备恢复，加载歌曲和进度后保持待播放 |
| 原有音乐能力 | 保留搜索、音质选择、歌词、榜单雷达、锁屏控制、移动端布局 |
| 初始运营方式 | 非商业、邀请制、小范围使用 |

公开无邀请注册、邮箱和短信服务、第三方登录、付费会员、公开歌单分享、社交互动、一起听、多人协同编辑、音乐文件上传和离线后台写入队列放到后续版本。管理员第一版管理账号，不增加浏览其他用户私有曲库的产品接口。

初始业务限额作为可配置默认值：每人 50 个命名歌单，每歌单和系统队列各 2000 首，收藏 5000 首；普通批量操作最多 200 首。普通 JSON 请求体最多 1 MiB，在线导入接口单独允许 2 MiB、最多 10000 个条目，并在一次事务内处理整次导入。前端在提交前检查序列化后的大小。超过限额给出明确提示，不截断后静默保存；超出在线上限的导出文件由离线导入 CLI 处理。

# 3 Docker 架构

浏览器通过同一来源访问 Express。Express 负责静态页面、登录会话、权限检查、个人曲库 API、SQLite 读写和音频流代理。搜索和歌曲解析通过容器内的音乐代理访问既有第三方 API。

| 组件 | 职责与边界 |
| --- | --- |
| Express 8787 | 唯一对外应用入口，执行用户认证和数据授权 |
| SQLite | 唯一用户数据源，文件位于 /data/solara-multiuser.db |
| Wrangler 8788 | 仅监听容器内 127.0.0.1，提供内部音乐代理 |
| 内部代理目录 | 仅包含音乐代理及其服务认证中间件，不包含登录、storage 或 D1 路由 |
| 本地浏览器缓存 | 按用户分区，辅助恢复界面和暂存失败操作，不充当远程数据真值 |
| 共享内存缓存 | 只缓存公共音乐元数据，不缓存用户歌单、会话或带凭据的响应 |

Docker 构建时复用 functions/proxy.ts 到隔离的内部代理工作目录，避免复制两份音乐解析业务逻辑。内部代理通过随机服务令牌鉴权，令牌随容器启动生成并仅在服务之间传递。Express 不向 Wrangler 传递浏览器 Cookie。容器不发布 8788 端口，不绑定 D1，也不把 Wrangler 临时状态写入用户数据库目录。

保留一个 Express 实例和一个 SQLite 文件。启用 WAL、foreign_keys、busy_timeout，采用短事务和参数化查询；事务内不等待外部网络。需要多实例部署时再单独制定 PostgreSQL 迁移方案。SQLite 适合低至中等流量网站，但同一个数据库同时只有一个写入者，因此容量根据实际写入负载验证。[SQLite 官方说明](https://www.sqlite.org/whentouse.html)

# 4 账号与会话合同

用户名使用 3 至 32 位小写英文字母、数字、下划线或连字符，规范化后唯一。显示名称独立保存并支持中文。密码长度按 Unicode 字符计为 12 至 128，同时限制 UTF-8 字节数最多 512，避免隐式截断。

密码使用 Node.js 异步 crypto.scrypt：N 为 32768，r 为 8，p 为 3，随机盐至少 16 字节，派生结果 64 字节，maxmem 设置为 64 MiB。存储格式包含算法、参数、盐和结果；验证使用安全比较。哈希任务并发最多 2 个、排队最多 16 个，超限返回可重试错误，避免登录请求耗尽内存。参数选自 [OWASP 的 scrypt 配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)，调用方式依据 [Node.js crypto 文档](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。

| 项目 | 固定行为 |
| --- | --- |
| 会话令牌 | crypto.randomBytes 生成 32 字节随机值，数据库只存 SHA-256 摘要 |
| 生产 Cookie | __Host-solara_session，HttpOnly、Secure、SameSite=Lax、Path=/，不设置 Domain |
| 会话期限 | 绝对期限 7 天，空闲期限 48 小时，全部由服务端检查 |
| 会话活跃时间 | 最多每 5 分钟写回一次，避免每个请求都写数据库 |
| 退出 | 服务端撤销当前会话并清除 Cookie |
| 改密或重置密码 | 撤销该用户全部旧会话，要求重新登录 |
| 禁用用户 | 事务内撤销会话；后续请求立即失效 |
| 邀请令牌 | 单次使用，默认 7 天过期，仅创建普通用户 |
| 重置令牌 | 单次使用，默认 30 分钟过期，绑定指定用户 |
| 令牌存储与展示 | 邀请及重置令牌只存摘要，明文链接仅创建成功时显示一次 |
| 最后一个管理员 | 不允许被禁用或降级，数据库事务保证该约束 |

邀请和重置链接把令牌放在 URL fragment 中；页面读取后清除地址栏中的 fragment，再通过 JSON 请求提交，避免令牌进入访问日志和 Referer。一次性令牌的校验、消费及账号变更必须在同一事务内完成，并发使用只能成功一次。

所有浏览器写请求校验 PUBLIC_ORIGIN。已登录写请求额外校验与当前会话绑定的 CSRF 令牌；GET /api/auth/me 可向当前页面返回该令牌，前端只保存在内存中。登录、注册和密码重置要求正确 Origin 与 JSON Content-Type。个人数据与认证响应使用 Cache-Control: no-store，不配置通配凭据 CORS。会话失效必须依赖服务端，不能依赖 localStorage 中的到期时间。[OWASP 会话管理说明](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

开发环境的无 Secure Cookie 只允许显式 development 模式加 loopback 来源。生产环境缺少 PUBLIC_ORIGIN、数据库不可用或未初始化管理员时，受保护服务返回明确错误，不能回退成开放访问。

# 5 数据结构

第一版直接使用有用户归属的关系表，替换原有全局键值业务接口。数据库迁移放在 server/migrations，使用 schema_migrations 记录版本和校验和。所有 ID 使用随机 UUID，时间统一保存为 UTC Unix 毫秒整数。

| 表 | 主要字段 | 约束与用途 |
| --- | --- | --- |
| users | id，username，display_name，password_hash，role，status，favorites_version，created_at，updated_at | username 唯一；role 为 admin 或 user；status 为 active 或 disabled；收藏集合版本初值为 1 |
| sessions | token_hash，user_id，csrf_token，device_id，created_at，last_seen_at，expires_at | token_hash 主键；user_id 外键；校验用户状态及两个过期条件 |
| auth_tokens | id，token_hash，purpose，user_id，created_by，expires_at，used_at，revoked_at | token_hash 唯一；purpose 为 invite 或 password_reset；重置必须绑定用户 |
| playlists | id，user_id，kind，name，version，created_at，updated_at | kind 为 queue 或 custom；每位用户只允许一个 queue；唯一索引保证 |
| playlist_items | id，playlist_id，user_id，source，track_id，song_json，position，created_at | 同歌单的 source 与 track_id 唯一；包含歌单归属复合外键 |
| favorites | user_id，source，track_id，song_json，created_at | 复合主键为 user_id、source、track_id，支持幂等收藏与取消 |
| user_settings | user_id，settings_json，version，updated_at | user_id 主键；只接受已定义的偏好字段 |
| playback_states | user_id，device_id，state_json，version，updated_at | 复合主键为 user_id、device_id；设备间独立保存进度 |
| data_imports | id，user_id，source_type，source_digest，result_json，created_at | 用于旧库和浏览器数据导入的幂等记录；旧库来源摘要全局唯一 |
| import_unresolved | id，import_id，user_id，raw_json，reason | 保留无法规范化的旧条目，支持本人查看和导出 |
| audit_events | id，actor_id，target_id，action，created_at，request_id | 记录邀请、禁用、改密、迁移等事件，不保存密码、令牌或私人歌曲内容 |

playlists 添加 UNIQUE(id, user_id)，playlist_items 使用 FOREIGN KEY(playlist_id, user_id) REFERENCES playlists(id, user_id)。删除歌单时级联删除其条目；所有数据库连接都启用外键。索引至少覆盖歌单归属、歌单条目顺序、用户收藏分页、会话用户、令牌摘要与到期时间。

歌曲身份固定为 source 与 track_id，source 与现有支持的数据源白名单一致，track_id 作为字符串处理。song_json 仅保存经过字段与长度校验的标题、歌手、专辑、图片及歌词标识等元数据；不持久化会过期的音频直链，不接受任意额外字段。导入的歌曲元数据保存在当前用户的条目中，不能覆盖其他用户的元数据。

创建用户时在同一事务内创建系统队列及 version 为 1 的默认 user_settings。播放状态尚不存在时，GET 返回空状态与 v0；第一次 PUT 使用 v0 做原子插入，以后的修改使用递增版本。

账号级偏好保存音质、搜索源、雷达设置。主题、音量与搜索界面记忆保存在当前设备的用户分区。设备标识是唯一允许放在浏览器来源级公共键中的随机非凭据值。playback_states 保存上下文类型、歌单 ID、歌曲身份、进度毫秒数、播放模式和更新时间；通过歌曲身份恢复，避免删除或排序后索引指向另一首歌。搜索或榜单试听可使用 transient 上下文，不强制加入歌单；涉及歌单 ID 时必须验证归属。

# 6 接口合同

成功响应统一使用 data，失败响应使用 error，其中包含 code、message、requestId。列表接口采用分页，默认 50 条、最多 100 条。请求字段采用白名单，客户端提交 user_id、role 或 status 等非当前接口可写字段时拒绝请求。

| 方法与路径 | 行为 |
| --- | --- |
| POST /api/auth/login | 用户名和密码登录，创建新会话 |
| POST /api/auth/register | 使用邀请令牌注册普通用户并创建会话 |
| GET /api/auth/me | 返回当前用户、设备 ID、CSRF 令牌及服务能力版本 |
| POST /api/auth/logout | 撤销当前会话 |
| POST /api/auth/change-password | 校验当前密码，改密并撤销全部会话 |
| POST /api/auth/reset-password | 消费重置令牌并设置新密码 |
| GET /api/admin/users | 管理员查看账号列表，不返回密码和令牌字段 |
| PATCH /api/admin/users/:id | 管理员启用或禁用账号，事务内执行最后管理员保护 |
| POST /api/admin/invites | 生成一次性普通用户邀请 |
| DELETE /api/admin/invites/:id | 撤销未使用邀请 |
| POST /api/admin/users/:id/reset-token | 生成该用户的一次性重置链接 |
| GET /api/me/playlists | 列出系统队列和本人的命名歌单 |
| POST /api/me/playlists | 创建命名歌单 |
| GET /api/me/playlists/:id | 读取本人歌单信息、条目和版本 |
| PATCH 或 DELETE /api/me/playlists/:id | 重命名或删除本人命名歌单；系统队列不可删除 |
| POST /api/me/playlists/:id/items/batch | 原子批量添加歌曲，返回添加和重复数量 |
| DELETE /api/me/playlists/:id/items/:itemId | 移除条目 |
| POST /api/me/playlists/:id/items/clear | 清空列表但保留歌单本身 |
| PUT /api/me/playlists/:id/order | 根据完整条目 ID 序列排序 |
| GET /api/me/favorites | 分页读取本人收藏 |
| PUT 或 DELETE /api/me/favorites/:source/:trackId | 幂等收藏或取消收藏 |
| POST /api/me/favorites/batch | 原子批量添加收藏 |
| POST /api/me/favorites/clear | 清空本人收藏 |
| GET 或 PATCH /api/me/settings | 读取或修改账号级偏好 |
| GET 或 PUT /api/me/playback | 读取或更新当前会话设备的播放状态 |
| GET /api/me/devices | 查看本人其他设备的最近播放状态摘要 |
| POST /api/me/playback/resume | 从本人指定设备复制播放状态到当前设备，保持待播放 |
| POST /api/me/import | 导入经过预览确认的浏览器旧数据或导出文件，返回导入记录 |
| GET /api/me/export | 导出当前用户的曲库、设置与待修复条目 |
| GET /proxy | 保持现有音乐查询参数接口，先认证与限流再访问共享缓存及上游 |
| GET /palette | 保留封面取色能力，使用受限远程请求规则 |
| GET /healthz 与 /readyz | 进程存活与数据库、迁移、管理员及内部代理就绪状态 |

所有 /api/me 资源的 user_id 只能来自服务端会话。查询和修改均同时限定资源 ID 与 user_id；别人的资源统一返回 404。管理员接口单独验证角色，管理员访问曲库接口仍只访问自己的数据。分页、导出、导入记录和设备查询都遵守同样的归属限制。

playlists、user_settings、playback_states 使用乐观并发控制：GET 返回 version 与 ETag: "v12"；修改时必须提供 If-Match: "v12"。缺少版本返回 428，版本不一致返回 412 和 VERSION_CONFLICT。版本比较、数据修改及版本递增放在同一事务。排序必须与当前条目集合完全一致；普通批量写入任一条校验失败则全部回滚。导入由专门的事务同时保存有效条目、待修复原始记录及完整报告，不进行隐式分批上传。

收藏采用单条幂等 PUT 和 DELETE，避免整份收藏数组覆盖。收藏实际增删时，在同一事务内递增 users.favorites_version；重复 PUT 已有歌曲或 DELETE 不存在歌曲不递增。GET 收藏返回该集合版本，清空收藏必须提交对应 If-Match，避免清掉另一台设备刚增加而当前页面未见到的收藏。单曲增删及新增收藏批次不要求集合版本，它们按歌曲身份处理且在事务内检查配额。

一般错误为 400 或 422；未登录为 401；角色或 CSRF 拒绝为 403；资源不存在或不属于本人为 404；重复用户名等业务冲突为 409；限流为 429 并包含 Retry-After；上游故障和超时为 502 或 504。

原 /api/login 共享口令流程与 /api/storage 全局接口退出 Docker 业务链路。新版对旧 storage 请求明确返回 API_UPGRADE_REQUIRED，不能继续读写旧表或伪装成 d1Available。旧 Cookie auth 被清理且不再接受。

# 7 前端启动与同步规则

现有 index.html 直接导入 js/app.js，移动端脚本另行加载；js/state.js 在模块初始化时就读取固定 localStorage 键名。需要把启动入口改为唯一的 js/index.js，完成认证和用户存储命名空间初始化后，再加载 app、state 和 mobile 模块，防止提前显示上一个账号的曲库。[现有入口](https://github.com/admintors/Solara/blob/f18015be89724e0951ee3319735093da7edab22e/index.html#L675)

启动顺序固定为：获取 /api/auth/me → 建立用户分区及当前账号代次 → 读取该用户缓存 → 拉取云端曲库及当前设备状态 → 装配播放器和移动端交互 → 开启写入。读取失败时显示明确的离线或服务异常状态，不能把网络失败当作空数据库，也不能自动将本地快照覆盖服务器。

本地用户缓存键名前缀为 solara:v2:{userId}:。Cookie 中的会话令牌不进入 localStorage。首次访问时生成随机 UUID，保存在来源级 solara:v2:deviceId；登录和注册通过 X-Solara-Device 提交，服务端验证格式后绑定到新会话。已登录接口从会话取得 device_id，不接受请求体覆盖。服务端始终与当前用户组合查询，device_id 不能用来选择其他用户。

每个已初始化页面的请求携带 X-Solara-Account: 当前 userId，服务端只用它检查页面身份是否与会话一致，不据此选择用户。所有异步操作绑定发起时的 userId 和前端账号代次；账号改变后丢弃旧响应、取消请求、清除待发送操作。这样即使浏览器 Cookie 已切换，也不会将旧页面的操作写入新账号。

同一浏览器来源一次登录一个账号。通过 BroadcastChannel 或 storage 事件通知其他标签页退出和切换；收到变更后停止音频、清空当前界面、暂停同步，再重新认证。退出时撤销服务器会话并清理当前用户的敏感缓存。界面上常驻可发现的账号入口和退出入口，管理员可进入简洁的账号管理页。

| 数据类型 | 同步规则 |
| --- | --- |
| 收藏 | 按歌曲 PUT 和 DELETE，同步成功后确认；失败显示未保存并保留可重试操作 |
| 系统队列与命名歌单 | 按条目增删，整体排序携带版本；412 后重新拉取，不能静默覆盖 |
| 多设备并发添加 | 重新拉取后可以重放一次明确的添加意图，再冲突则提示用户重试 |
| 清空、删除和排序冲突 | 保留服务器最新版本，由用户确认后重新发起，不能自动合并 |
| 偏好设置 | 合并已修改的白名单字段，携带 settings 版本 |
| 播放进度 | 各设备独立，播放中最多每 15 秒保存；切歌、暂停时保存；离页做小请求的尽力提交 |
| 其他设备恢复 | 用户主动触发；仅复制自己的状态，不遥控另一台设备，不强制自动播放 |
| 读取同步 | 页面回到前台时刷新；可见时每 30 秒检查当前使用资源的版本，后台停止轮询 |

服务端的空列表就是有效状态，不能再使用“云端为空但本地非空就上传”的恢复逻辑，否则删除的数据会复活。第一版不实现离线后台写入队列；失败的操作仅留在当前账号当前页面，用户重试前重新验证账号与资源版本。

同步状态至少包含已同步、正在保存、未保存、登录已过期。setItems 和 removeItems 等客户端请求必须检查 HTTP 状态；401、403、412、429 和 5xx 不能被视为成功。[现有请求封装](https://github.com/admintors/Solara/blob/f18015be89724e0951ee3319735093da7edab22e/js/core/storage.js#L68)

# 8 旧数据迁移与恢复

新库使用 /data/solara-multiuser.db，旧版 /data/solara.db 保留为迁移来源。首次启动自动建新结构，但不自动认领旧数据，也不把所有新用户关联到旧的全局收藏和队列。

实施 server/cli/create-admin.js、import-legacy.js、import-user.js、reset-password.js、backup.js 和 restore.js。CLI 支持明确目标路径、dry-run、退出码与结果摘要。create-admin 仅用于首位管理员初始化；离线 reset-password 用于管理员账号恢复。管理员密码通过交互式隐藏输入或标准输入传入，不放入命令参数、日志或仓库。禁止使用原 PASSWORD 自动创建所有用户共享的密码。

迁移按以下顺序执行：停止旧容器写入 → 对旧库做 SQLite 一致性备份并计算摘要 → 初始化新库与指定管理员 → dry-run 检查数量和异常 → 使用 --owner 指定管理员执行迁移 → 运行完整性与归属检查 → 启动新 Docker 版。无旧数据时直接跳过导入。

| 旧数据 | 新数据目标 |
| --- | --- |
| playlistSongs | 指定管理员的系统队列，保持顺序，按歌曲身份去重 |
| favoriteSongs | 指定管理员收藏 |
| playbackQuality、searchSource、radarSettings | 指定管理员的账号级偏好 |
| currentSong、列表上下文和进度 | 指定管理员的 legacy-import 设备恢复快照 |
| playerVolume 和设备显示偏好 | 留作可选设备恢复值，不自动广播到其他设备 |
| 其他旧键 | 保存在迁移原始快照中，不猜测其业务含义 |

旧数据中缺失来源、标识或格式异常的条目写入本人隔离的 import_unresolved，并在报告中列出原因及原始记录；不能静默丢弃或按歌名猜配另一首歌曲。导入报告包含原始数、成功数、重复数、待修复数和来源摘要。旧库同一摘要只能迁给一个指定用户，重复执行不产生重复数据，更换 owner 时明确拒绝。

浏览器检测到旧版无用户前缀的数据时，只显示带当前用户名的导入预览，由用户主动选择导入；不自动上传。JSON 导入兼容旧版导出格式，并定义新版格式版本；以当前用户、来源类型和来源摘要去重。在线导入使用专用的请求上限和一次事务；超过上限的完整个人导出交由离线 import-user CLI 处理，CLI 仍验证目标归属与业务配额，失败不能留下半次导入。

backup 使用 SQLite 一致性备份机制，不能在运行中只复制 .db 而遗漏 WAL。restore 要求停写、验证备份完整性并保留当前库的恢复副本。自动备份开关与保留天数通过配置提供，默认每日一次、保留 7 份，备份位于 /data/backups 且不对 HTTP 暴露。

回退使用旧镜像与保留的旧库。回退前备份新库并保留新版本导出；新版本新增的账号与曲库不会自动回写旧版共享数据库，恢复文档必须明确这一点。

# 9 Docker 配置与现有问题修复

docker-compose.yml 必须构建并运行改造后的代码，使用 build 配置或本次构建的明确镜像标签，不能继续只拉取 ghcr.io/akudamatata/solara:latest。最终镜像带版本和提交 SHA，Dockerfile 固定已验证的 Node 与 Wrangler 版本并保存依赖锁文件，安装使用 npm ci。

| 配置项 | 第一版约定 |
| --- | --- |
| APP_ENV | production 或显式 development |
| PUBLIC_ORIGIN | 必填，生产使用实际 HTTPS 来源；本地开发可使用 loopback HTTP |
| DATA_DIR | /data |
| DB_PATH | /data/solara-multiuser.db |
| API_BASE_URL | 保留既有默认上游，支持运营者通过环境变量配置 |
| SESSION_ABSOLUTE_TTL_SECONDS | 默认 604800 |
| SESSION_IDLE_TTL_SECONDS | 默认 172800 |
| INTERNAL_PROXY_TOKEN | 启动时生成的内部服务凭据，不写入日志 |
| PASSWORD | 从新版登录体系移除，不参与会话验证 |

默认只将宿主机 127.0.0.1:8080 映射到 8787，交由现有反向代理提供 HTTPS；适配同一 Docker 网络中的反向代理时按实际拓扑配置。可信代理范围必须明确，不能无条件信任客户端的 X-Forwarded-For 或 X-Forwarded-Proto。Cookie 的生产安全属性以固定 PUBLIC_ORIGIN 和运行模式决定。

运行进程采用受限用户。初始化时检查挂载目录的属主与写权限，数据库和备份按私有文件权限创建；权限不符时报告具体目录与修复步骤，不使用 chmod 777 处理。

进程管理须转发 SIGTERM 和 SIGINT、停止接收新请求、终止后台 Wrangler、取消音频上游并关闭数据库。内部代理启动失败时不能伪装为就绪。就绪探针检查本地依赖，不因第三方音乐 API 暂时不可用而反复重启容器。

同时完成以下与多用户上线直接相关的修复：

- 用明确静态目录和文件白名单替换整个项目根目录的 express.static。/server、/functions、数据库、备份、配置及源码配置文件不对 HTTP 提供；API 不因路径带 .json 或其他扩展名跳过认证。
- 清除启动脚本输出 PASSWORD 明文的行为；日志不记录 Cookie、密码、邀请及重置令牌、完整请求体或私人曲库内容。[当前启动脚本](https://github.com/admintors/Solara/blob/f18015be89724e0951ee3319735093da7edab22e/docker-entrypoint.sh#L35)
- 歌名、歌手、歌单名和歌词使用 textContent 或安全 DOM 构造，不将用户或上游文本直接插入 innerHTML。导入文件中的元数据也按不可信文本处理。[当前歌单渲染](https://github.com/admintors/Solara/blob/f18015be89724e0951ee3319735093da7edab22e/js/features/playlist.js#L224)，[当前歌词渲染](https://github.com/admintors/Solara/blob/f18015be89724e0951ee3319735093da7edab22e/js/features/lyrics.js#L123)
- /palette 远程图片请求必须限制 HTTPS 与封面域名白名单，拒绝私网、loopback、link-local 和保留地址，覆盖 IPv4 与 IPv6。DNS 解析通过后连接到已验证地址，保持原始 TLS 主机名；重定向逐跳重验，最多 3 次；5 秒超时，最多 5 MiB，并限制解码尺寸。失败使用现有前端取色或默认渐变降级，不放宽目标限制。
- /proxy 只接受已支持的 types、source、音质和受限查询参数，音频代理保持目标域名限制并逐跳校验重定向，不成为任意 URL 转发器。前端断开、切歌或退出后及时取消上游，保留 Range 支持。
- 共享缓存设置条目数与总字节上限，仅以规范化的公共音乐查询参数为键，不携带会话或内部令牌。个人 API 始终 no-store，反向代理也不缓存个人响应。
- 登录按账号及来源地址限流，默认账号与地址组合每 15 分钟最多 5 次失败、单地址每 15 分钟最多 30 次尝试。音乐搜索默认每用户每分钟 30 次，普通个人 API 每分钟 120 次，音频代理每用户最多 2 条同时连接；作为可配置初值，不作为容量承诺。

# 10 文件改造清单

下表路径均为目标仓库内的相对路径；新增项是实施目标，不代表已经存在。

| 位置 | 改造内容 |
| --- | --- |
| server/index.js | 拆分可测试的 app factory 与监听启动，注册新路由、静态白名单和统一错误处理 |
| server/db.js 与 server/migrations | 新库路径、迁移、外键、事务、预编译查询和初始化 |
| server/repositories | 集中实现带 user_id 的曲库、会话、偏好及播放状态访问 |
| server/services | 密码、会话、一次性令牌、导入、备份和审计服务 |
| server/middleware | 认证、管理员授权、Origin、CSRF、身份一致性、校验和限流 |
| server/routes/auth.js 与 login.js | 替换原有共享口令验证，完成独立账号流程 |
| server/routes/storage.js | 移除全局键值读写并提供升级错误 |
| server/routes 下新增个人与管理路由 | 实现 playlists、favorites、settings、playback、import、export、admin |
| server/routes/proxy.js 与 palette.js | 入口认证、限流、超时、受限目标、取消和安全日志 |
| server/cache.js | 有容量上限的公共元数据缓存 |
| server/internal-proxy 与 functions/proxy.ts | 内部路由隔离和服务鉴权，复用音乐代理实现 |
| server/cli | 管理员初始化与恢复、旧库和个人文件导入、备份和恢复命令 |
| index.html 与 js/index.js | 单一认证后启动入口，统一移动端加载 |
| login.html 与认证页面 | 用户名登录、邀请注册、密码重置，保留现有视觉风格 |
| js/core/auth.js 与 api-client.js | 会话初始化、CSRF、状态码处理、请求取消、账号代次 |
| js/core/storage.js 与 js/state.js | 用户命名空间、延迟初始化、缓存及远程业务 API 适配 |
| js/app.js | 停用整份快照自动上传，接入曲库和设备恢复 |
| js/features/playlist.js 与 favorites.js | 对接条目 API、命名歌单、版本冲突和导入导出 |
| js/features/settings.js 与 lyrics.js | 账号偏好、同步状态、账号入口及安全歌词渲染 |
| admin.html 与对应模块 | 最小账号管理、邀请和重置链接界面 |
| Dockerfile、docker-entrypoint.sh、docker-compose.yml | 自有镜像、进程管理、内部代理隔离、健康检查和持久化 |
| server/test 与 tests/e2e | 自动化测试、固定上游响应和两个用户的独立浏览器上下文 |
| README.md、docs 与 CI | Docker 使用说明、接口合同、迁移恢复步骤、测试与镜像验证 |

# 11 Luna 执行阶段

| 阶段 | 实施内容 | 完成条件 |
| --- | --- | --- |
| P0 GitHub 基线 | 读取远程分支、AGENTS、源码和 workflows；确认 Docker 与播放器入口；准备开发分支 | 远程基线、修改位置及 Actions 可用性记录清楚 |
| P1 数据层 | 提交新库结构、版本化迁移、repository、事务、管理员 CLI 和系统队列初始化 | 实现完整并附幂等、外键和归属测试；可用 CI 的结果已检查 |
| P2 账号 | 提交密码、会话、邀请、注册、改密、重置、禁用、CSRF、限流 | 账号与会话流程衔接完整；关键失败与撤销场景有自动化用例 |
| P3 个人 API | 提交曲库、队列、收藏、偏好、设备状态、导入导出和版本冲突 | 所有资源操作使用会话归属；跨用户与并发场景有测试覆盖 |
| P4 前端接入 | 提交单一启动入口、账号分区、多标签页处理、新 API 与命名歌单 | 前后端调用合同一致；桌面移动端关键场景有可执行验收脚本 |
| P5 迁移与恢复 | 提交旧库指定 owner 导入、浏览器预览导入、备份和恢复 | 命令、样本和说明齐备；演练结果由 CI 提供或明确标为待验证 |
| P6 Docker 与 CI | 提交镜像配置、内部代理隔离、受限取色、流取消、进程退出、健康检查及 Linux CI | CI 可用时完成镜像构建和容器冒烟；未运行项与原因如实记录 |
| P7 GitHub 交付 | 核对分阶段提交、说明文档、CI 状态和草稿 PR | PR 列出完成范围、CI 链接、待验证项和后续容量试验计划 |

顺序以完整业务闭环为主：先完成两个账号的独立收藏和队列，再加入命名歌单、跨设备恢复与管理界面。每个阶段结束记录提交 SHA 和远程检查状态；CI 已发现的代码问题及时修复，尚未执行的检查不能写成通过。当前不以完成本地运行或人工验收作为继续实施和提交 PR 的前置条件。

# 12 验收清单与远程验证

以下 20 项是功能合同与后续验收清单，保留其通过条件，但当前不要求在本地逐项执行。交付时逐项标记为 GitHub CI 已通过、CI 失败或待验证；人工设备检查、真实带宽与容量试验尚未开展时列入待验证，不能凭代码阅读推断通过。

| 编号 | 必须验证的场景 | 通过条件 |
| --- | --- | --- |
| A01 | A 与 B 使用独立浏览器上下文收藏不同歌曲 | 两人只看到自己的收藏、队列与命名歌单 |
| A02 | A 直接请求 B 的歌单 ID、条目 ID、设备 ID和导入记录 | 读取、修改、清空、排序、删除及导出均不能访问 B 数据 |
| A03 | 伪造 user_id 或将普通用户请求发往管理员路由 | 不改变数据归属，不产生权限提升 |
| A04 | 同一浏览器 A 退出后 B 登录，同时 A 还有延迟请求 | 不显示 A 缓存，不把 A 的旧请求写入 B，其他标签页同步退出或重载 |
| A05 | 会话过期、重置密码、禁用用户后复用旧令牌 | 服务端拒绝，不依赖浏览器是否删除 Cookie |
| A06 | 两个请求同时使用同一邀请或重置令牌 | 只有一个成功，无重复账号或重复重置 |
| A07 | 跨来源写入、缺失 CSRF、伪造代理头、尝试禁用最后管理员 | 全部被拒绝；合法同来源请求正常 |
| A08 | 同用户两设备同时编辑同一版本歌单，分别增加不同收藏 | 歌单一方产生可处理的版本冲突；不同歌曲收藏都保留 |
| A09 | 手机与电脑播放不同歌曲，并主动恢复另一台设备进度 | 进度相互独立，恢复准确并保持待播放 |
| A10 | 一台设备清空收藏或队列，另一台保留旧缓存后重新进入 | 空列表保持为空，不恢复已删除内容 |
| A11 | 网络中断、写入 500、429、401 和 412 | 界面不显示虚假成功；可安全重试，不跨账号重放 |
| A12 | 迁移同一旧库两次，并用另一 owner 再次导入 | 仅指定 owner 获得旧数据，无重复，变更 owner 被拒绝 |
| A13 | 导入缺失歌曲 ID、损坏 JSON、超额和含 HTML 的数据 | 不静默丢失；不执行脚本；报告错误与待修复条目 |
| A14 | 请求数据文件、服务器源码、配置路径及扩展名变化的 API | 数据与配置不泄露，扩展名不绕过认证 |
| A15 | 取色请求指向私网、IPv6 loopback、重定向私网及超大图片 | 拒绝或安全终止；播放器正常使用视觉降级 |
| A16 | 音频 Range、快速切歌、关闭页面和容器停止 | 播放及拖动正常；上游连接释放，进程可退出 |
| A17 | 容器重启、重建镜像并挂载原数据目录 | 账号、收藏和歌单持续存在，无自动创建新空库的错觉 |
| A18 | 从备份恢复到新目录，再启动同版本容器 | 数据一致，完整性检查通过，原目录仍可恢复 |
| A19 | 桌面和窄屏移动端搜索、歌词、榜单、收藏、命名歌单及 MediaSession | 核心流程可用，控件不遮挡，已有能力无明显回退 |
| A20 | 20 个测试账号、10 个同时活跃客户端运行 15 分钟的固定上游试验 | 无串数据、无丢写、无未处理锁错误；错误率和延迟达到下述目标 |

自动化脚本使用 node:test 覆盖服务与数据库合同，Playwright 覆盖双账号、切号、并发及桌面移动端关键流程，统一面向 GitHub Actions 的 Linux runner。CI 的测试数据库位于 runner 独立临时目录，使用固定上游样本；不使用生产数据，也不大量请求免费 API。真实上游与真实设备的人工冒烟后续安排。

新增 Linux 验证 workflow，支持 pull_request 和 workflow_dispatch，至少配置依赖安装、服务与数据库测试、Docker 镜像构建和容器健康检查；前端流程成熟后接入 Playwright。默认仅授予 contents: read，测试与普通构建不依赖生产 secrets，也不默认发布镜像或部署生产。远程任务触发后检查状态与失败日志；无法触发时在 PR 中写明，而不是转而要求本地测试。

A20 作为后续容量试验，当前不阻塞 GitHub 代码与 PR 交付。负载模型固定为：收藏与歌单混合读写每客户端每 5 秒一次、播放进度每 15 秒一次、分页读取与缓存查询；测试期间开启两个音频代理流，验证断开后的资源释放。个人数据 API 的 p95 目标小于 500 毫秒、非预期 5xx 为零；超时、数据库锁与内存占用单独记录。未来报告注明 CPU、内存、镜像版本和数据量；结果只对应当次环境和负载模型，真实音频带宽另外测量。

后续性能试验达到目标后不继续无目的扩压。若失败，记录明确瓶颈并先调整事务、请求合并、缓存或限额；不直接用增加基础设施替代问题定位。

# 13 文档与交付物

Luna 交付草稿 PR 时，应附上 GitHub 分支和提交记录、数据库和接口说明、Docker 配置样例、管理员初始化步骤、邀请与重置流程、迁移 dry-run 用法、备份和恢复命令、CI 链接和实际结果，以及逐项待验证清单。CI 已构建镜像或生成截图时附上对应产物；未执行的迁移演练、设备检查和容量试验注明后续安排，不要求为本轮交付启动本地环境。

README 明确本分支只提供 Docker 多用户部署；原上游地址、署名和许可声明保留。原仓库 README 声明 CC BY-NC-SA 并禁止商业化，本轮按非商业范围实施。第三方音乐 API 的使用条款、稳定性和带宽另行记录，不承诺永久可用。[上游许可声明](https://github.com/akudamatata/Solara#-许可证)

PR 描述说明用户可观察到的新行为、旧数据迁移方式、已执行的远程检查和仍存在的限制，并明确“本轮按要求未执行本地测试”。代码或文档中不能出现真实密码、会话、邀请链接令牌、生产数据库和私人导出文件。

# 14 可直接交给 Luna 的执行指令

```text
请直接从 GitHub 读取并按 docs/SOLARA_DOCKER_MULTIUSER_PLAN.md 执行，目标仓库是 https://github.com/admintors/Solara，基准提交为 f18015be89724e0951ee3319735093da7edab22e，开发分支为 feat/multi-user-v1。该分支存在时继续使用并保留已有提交。

只实现 Docker 版。保留现有原生前端、播放器和音乐 API 链路；账号、会话、权限与用户数据集中在 Node.js + SQLite。Wrangler 只作为容器内部受保护的音乐代理，不部署 Cloudflare Pages，不使用 D1。

直接通过 GitHub 连接或 GitHub API 在开发分支读取、修改文件并分阶段提交，先核对远程 HEAD、仓库 AGENTS.md 和 workflows，保留已有工作。暂时忽略本地测试，不要求克隆、本地环境、win-build、本地 Docker 或本地浏览器验收。

按 P0 至 P7 顺序完成邀请制账号、数据隔离、收藏、系统队列、命名歌单、版本冲突处理、设备进度恢复、旧数据指定 owner 迁移、管理界面和 Docker 加固，保留现有视觉风格。针对切号延迟请求、跨用户访问、删除数据复活、一次性令牌并发及备份恢复编写必要的自动化用例。

验证优先使用 GitHub Actions。可用时执行并修复代码导致的失败；因权限或环境条件无法运行时如实记录，继续完成代码和草稿 PR。交付 GitHub 分支、提交与草稿 PR 链接、Docker 配置、CI 实际状态、迁移恢复说明和待验证清单，不声称未执行的测试已通过。现有线上环境的切换另行安排。
```
