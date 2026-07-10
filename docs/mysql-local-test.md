# MySQL 本地测试模式

v39 始终使用 `db.json` 作为主存储和事实来源。只有显式设置 `XIAODE_STORAGE=mysql` 时，后端才会额外启用本地 MySQL 镜像。

## 创建数据库

在 MySQL 中执行：

```sql
CREATE DATABASE IF NOT EXISTS xiaode_course_table
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

后端启动时也会尝试自动创建数据库和所需表，但建议先手动确认 MySQL 服务可用。

## 一键启动

推荐在项目根目录运行：

```powershell
cd C:\work3\xiaode-course-table
.\start-v39.ps1
```

脚本会安全提示输入密码，输入不会显示，密码只在本次后端进程内存和环境中存在。

纯 JSON 模式使用：

```powershell
.\start-v39.ps1 -JsonOnly
```

## 手工通过环境变量启动

在 PowerShell 中进入后端目录：

```powershell
cd C:\work3\xiaode-course-table\web\backend
```

设置本次终端会话的环境变量：

```powershell
$env:XIAODE_STORAGE="mysql"
$env:MYSQL_HOST="127.0.0.1"
$env:MYSQL_PORT="3306"
$env:MYSQL_USER="xiaode"
$securePassword = Read-Host "MySQL 密码" -AsSecureString
$env:MYSQL_DATABASE="xiaode_course_table"
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:MYSQL_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  npm start
} finally {
  Remove-Item Env:MYSQL_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
}
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

如果新增课程后 `course_count` 增加，说明镜像同步生效。`web/backend/data/db.json` 始终是主存储，不是回退副本。

## 健康检查、备份和恢复

```powershell
.\health-v39.ps1
.\backup-v39.ps1 -Label before-change
.\restore-v39.ps1 -BackupFile '备份文件完整路径'
```

恢复脚本会先校验 JSON 和 SHA-256，再为当前 `db.json` 建立恢复前备份，并以同目录原子替换完成恢复。重启后端后，MySQL 会自动镜像恢复后的 JSON 快照。

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
