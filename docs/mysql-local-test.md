# MySQL 本地测试模式

v39 默认仍然使用 `db.json`。只有显式设置 `XIAODE_STORAGE=mysql` 时，后端才会进入本地 MySQL 测试模式。

## 创建数据库

在 MySQL 中执行：

```sql
CREATE DATABASE IF NOT EXISTS xiaode_course_table
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

后端启动时也会尝试自动创建数据库和所需表，但建议先手动确认 MySQL 服务可用。

## 通过环境变量启动

在 PowerShell 中进入后端目录：

```powershell
cd C:\work3\xiaode-course-table\web\backend
```

设置本次终端会话的环境变量：

```powershell
$env:XIAODE_STORAGE="mysql"
$env:MYSQL_HOST="127.0.0.1"
$env:MYSQL_PORT="3306"
$env:MYSQL_USER="root"
$env:MYSQL_PASSWORD="你的本地 MySQL 密码"
$env:MYSQL_DATABASE="xiaode_course_table"
npm start
```

也支持兼容变量名：

```text
DB_HOST
DB_PORT
DB_USER
DB_PASSWORD
DB_NAME
```

不要把这些密码写进 Git 仓库，不要提交 `.env` 文件。

## 确认 MySQL 是否写入数据

启动后先访问：

```text
http://localhost:3001/api/health
```

管理员登录后可以查看：

```text
http://localhost:3001/api/admin/storage
http://localhost:3001/api/admin/schema
```

在 MySQL 中确认 `courses` 表：

```sql
USE xiaode_course_table;
SHOW TABLES;
SELECT COUNT(*) AS course_count FROM courses;
SELECT id, user_id, account_id, day, slot, name
FROM courses
ORDER BY user_id, day, slot
LIMIT 20;
```

如果新增课程后 `course_count` 增加，说明双写测试生效。v39 同时会保留 `web/backend/data/db.json` 作为回退数据文件。

## 为什么 Android App 不应该直接连接 MySQL

Android App 不应该直接保存或使用 MySQL 账号密码。直接连接数据库会带来几个问题：

- 数据库密码会被打包进 App，容易被反编译获取。
- MySQL 暴露到公网或局域网会扩大攻击面。
- App 端难以统一做权限校验、数据校验和兼容迁移。
- 后续更换数据库或部署方式时，所有客户端都需要更新。

正确结构是：

```text
Android App
  -> Node.js/Express 后端
  -> db.json 或 MySQL
```

Android 只访问后端 API。数据库连接、密码、迁移和双写逻辑都放在后端。
