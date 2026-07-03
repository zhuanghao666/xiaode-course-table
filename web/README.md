# 小德课表 Web v39 - 本地 MySQL 测试版

v39 的目标是：在不破坏 v38 稳定功能的前提下，开始接入本地 MySQL。

## 本版新增

- 保留 `db.json`，默认仍然用本地 JSON，安全回滚。
- 新增 MySQL 双写/读取测试模式。
- 启用 MySQL 后：
  - 启动时优先读取 MySQL `app_state`。
  - 如果 MySQL 为空，会用当前 `backend/data/db.json` 初始化。
  - 每次写数据时，同时写入 `db.json` 和 MySQL。
  - MySQL 中会生成镜像表：`users`、`accounts`、`courses`、`settings`、`reminders`、`sessions`、`slots` 等。
- 新增管理员检查接口：
  - `/api/admin/schema`
  - `/api/admin/storage`
  - `/api/admin/mysql-sync-now`

## 先按普通模式运行

不装 MySQL 也能跑：

```powershell
cd backend
npm install
node src/server.js
```

打开：

```text
http://localhost:3001
```

这时仍然使用：

```text
backend/data/db.json
```

## 启用本地 MySQL 测试

### 1. 创建 MySQL 数据库用户，或者先用 root 测试

MySQL 里执行：

```sql
CREATE DATABASE IF NOT EXISTS xiaode_course_table
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

### 2. Windows PowerShell 设置环境变量

在 `backend` 目录下执行：

```powershell
$env:XIAODE_STORAGE="mysql"
$env:MYSQL_HOST="127.0.0.1"
$env:MYSQL_PORT="3306"
$env:MYSQL_USER="root"
$env:MYSQL_PASSWORD="你的MySQL密码"
$env:MYSQL_DATABASE="xiaode_course_table"
node src/server.js
```

看到类似：

```text
[storage] 已启用 MySQL 双写/读取测试模式。
存储模式：MySQL 双写测试
```

说明成功。

### 3. 检查健康状态

浏览器访问：

```text
http://localhost:3001/api/health
```

登录管理员后访问：

```text
http://localhost:3001/api/admin/storage
```

## 注意

v39 是“本地 MySQL 测试版”，不是最终公网数据库版。

当前策略是双保险：

```text
Node 后端
├─ db.json 本地备份
└─ MySQL app_state + 镜像表
```

这样即使 MySQL 配错了，也不会影响原来的 `db.json` 跑法。

## 推荐测试顺序

1. 先不启用 MySQL，确认 v39 普通模式正常。
2. 启用 MySQL 后启动。
3. 登录 demo / 123456。
4. 新增课程。
5. 切换账号。
6. 备份恢复。
7. 在 MySQL 里查看 `courses` 表是否出现数据。
8. 重启后确认课程仍然存在。

