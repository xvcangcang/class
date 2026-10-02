# Class Analysis Platform（class-atlas）

把班上的人和关系，画成一张一眼就懂的图。附带班级事件记录和账号权限系统。

> 数据只保存在你自己部署的服务器上，不往外面传。

## 能干什么

| 模块 | 说明 |
| --- | --- |
| 关系图 | ECharts 力导向网络图。点的大小 = 关系多少，线粗细 = 亲密度；可按角色 / 小组着色，可按关系类型筛选，可搜索名字 |
| 个人视图 | 点某个圆点，右侧看这个人的全部关系、参与过的事件 |
| 班级事件 | 时间线记录「什么时候发生了什么事」，可挂上参与的人 |
| 人物 | 人物卡片墙，按老师 / 学生分组 |
| 操作日志 | 自动记录每一次改动：谁、什么时候、对什么、做了什么，可按关键字 / 动作 / 结果筛选并导出表格 |
| 账号与权限 | 每人一个账号，三级权限，能看 / 能改的都不一样 |

## 三级权限

| 等级 | 能做什么 |
| --- | --- |
| 管理员 admin | 管理账号、编辑全部内容 |
| 编辑者 editor | 编辑人物 / 关系 / 事件，但看不到账号管理 |
| 只读 viewer | 只能查看，页面上的编辑按钮直接不出现 |

后端对每个写接口都会再校验一次权限，**不是靠前端藏按钮**。

默认管理员：`admin` / `admin123` —— 登录后请立刻改密码。

### 注销账号

| 谁 | 怎么注销 | 说明 |
| --- | --- | --- |
| 本人 | 右上角「注销账号」按钮 | 需输入登录密码 + 手动输入「注销」两字确认；注销后所有设备的登录立即失效 |
| 管理员 | 账号页每行的「注销」按钮 | 可注销别人；对方所有设备被踢下线 |

- 注销**只删账号**，不会动人物 / 关系 / 事件数据。
- **最后一个管理员不能注销**（自己或别人都不行），避免没人能管平台。
- 注销会记入操作日志（`注销账号`）。

## 技术栈

- 前端：Vite 6 + TypeScript + ECharts 5（原生 DOM，无框架）
- 后端：Express 4 单体服务（`server/index.mjs`），同一个进程既托管静态页面又提供 `/api/*`
- 存储：JSON 文件。线上落在 PocketBay 持久卷 `/data`（读 `POCKETBAY_DATA_DIR`），本地落在 `./data`
- 密码：`scrypt` 加盐哈希，不存明文；登录令牌 7 天过期

## 本地开发

```bash
npm install

# 方式一：开发模式（热更新）
npm run server          # 终端 A：API 服务，127.0.0.1:8787
npm run dev             # 终端 B：Vite 5173，/api 自动代理到 8787

# 方式二：跑生产构建
npm start               # 构建 + 起服务，打开 http://127.0.0.1:8787
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8787 | 服务端口，PocketBay 会自动注入 |
| `POCKETBAY_DATA_DIR` | `./data` | 数据目录，线上是持久卷 `/data` |
| `DIST_DIR` | `../dist` | 静态文件目录 |

## 数据结构

```jsonc
// people.json
{ "id": "uuid", "name": "同学A", "role": "student|teacher", "group": "第一组", "tags": ["班长"], "note": "" }

// links.json
{ "id": "uuid", "source": "<personId>", "target": "<personId>", "type": "好友", "weight": 3 }

// events.json
{ "id": "uuid", "date": "2026-09-01", "title": "开学报到", "detail": "…", "participants": ["<personId>"], "createdBy": "管理员" }

// logs.json —— 操作日志，只追加不删除，超过 5000 条自动丢弃最旧的
{ "id": "uuid", "ts": 1759392000000, "action": "新增人物", "target": "同学A", "detail": "学生", "ok": true, "actor": "管理员", "actorUsername": "admin", "ip": "…" }
```

## 操作日志（留痕 / 可溯源）

- **谁、什么时候、改了什么**：登录、退出、改密码，以及人物 / 群组 / 关系类型 / 关系 / 事件 / 账号的新增改删，全部自动记一条。
- **登录失败也会记**，方便发现有人乱试密码。
- 每条包含：操作人、动作、对象、说明（改动了哪些字段、连带影响多少条数据）、成功还是失败、来源 IP。
- 界面只展示和导出，**没有删除入口**；日志文件在 `logs.json`，写失败也不会影响正常业务。
- 入口：**任意账号**登录后，顶栏「操作日志」标签页；支持关键字搜索、按动作 / 结果筛选，可一键导出 CSV（Excel 可直接打开）。
- 三种角色都能查看日志（只读，不能修改或删除），方便互相监督。

### 无痕模式（仅管理员）

顶栏「无痕模式」按钮，用于临时做不想留痕的操作：

- **开启时要求填写原因**（如「整理敏感数据」「给同学演示」），原因会写进日志。
- 开启后**本次登录**的所有操作不再写入日志；换设备或重新登录即恢复记录（标记跟着会话走，不跟着账号走）。
- 「开启」与「关闭」这两步本身**仍会留痕**，所以日志里会留下一段有起止、有原因的无痕区间，而不是凭空少一块，事后说得清。
- 开启期间页面顶部有醒目的黄色提示条，避免忘记关闭。

## 接口一览

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| POST | `/api/auth/login` | 公开 |
| GET | `/api/bootstrap` | 登录后（管理员才返回账号列表） |
| POST/PATCH/DELETE | `/api/people`、`/api/links`、`/api/events` | editor 及以上 |
| GET/POST/PATCH/DELETE | `/api/users` | admin |
| GET | `/api/logs` | 登录用户（支持 `q` / `action` / `result` / `limit` 筛选） |
| GET/POST | `/api/audit/incognito` | admin（查询 / 切换无痕模式，开启可带 `reason`） |
| GET | `/api/health` | 公开（部署健康检查用） |

## 隐私提醒

涉及同学信息，建议用昵称或代号，别把真实姓名放到公开网络。

## 部署到 PocketBay

线上地址：<https://class.pocketbay.app> （原 `class-atlas.pocketbay.app` 已停用；node 运行时，数据在 `/data` 持久卷，跨更新保留）

### 部署时踩过的三个坑（改仓库前先看这里）

1. **后端必须用框架（Express），不能是零依赖的 `node:http`。**
   平台按依赖判断运行时类型。纯内置模块的服务会被识别成 `static` —— 只起 nginx 托管 `dist/`，
   `/api/*` 全部回退成页面，登录和所有写操作都失效。加上 Express 后平台立刻识别为 `framework: node`。
2. **仓库根目录不能有 `index.html`。**
   平台文档写明 static 的判定条件就是「根目录 index.html」。所以入口改叫 `app.html`，
   构建后由 Vite 插件复制一份成 `dist/index.html`，供静态回退使用。
3. **`build` / `start` 脚本不要用 `&&` 串命令。**
   平台解析启动命令时会把链式命令里的 `cp` 当成「启动入口」，报 `listing_truncated`。
   复制文件改成 Vite 插件（`copy-app-html-to-index`）完成。

另外：`Dockerfile` 反而会让平台走「构建镜像 → 只抽取静态产物」的路径，同样固定成 static，所以本项目不带它。

### 部署命令

```bash
# 打包（排除依赖、git、构建产物、本地数据）
tar --exclude='./node_modules' --exclude='./.git' \
    --exclude='./dist' --exclude='./data' \
    -czf /tmp/class-atlas.tar.gz .

# 用配对会话上传（POST /api/deploy/sessions/upload），
# 然后轮询 /api/deploy/sessions/status 直到 project_status=running
# framework 必须显示 node 才算对
```
