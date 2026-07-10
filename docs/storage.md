# v39 存储与运维

## 存储原则

`web/backend/data/db.json` 永远是 primary 和事实来源。MySQL 仅是异步完整镜像：启动时只允许 JSON 推向 MySQL，禁止用 MySQL 快照覆盖本地 JSON。JSON 写入成功后接口即可返回，MySQL 失败只进入健康状态和日志。

## 日常启动

```powershell
cd C:\work3\xiaode-course-table

# db.json primary + MySQL mirror
.\scripts\start-web-mysql.ps1

# only db.json
.\scripts\start-web-json.ps1
```

可用参数示例：

```powershell
.\scripts\start-web-mysql.ps1 -Port 3001 -MysqlHost 127.0.0.1 -MysqlPort 3306 -MysqlUser xiaode -MysqlDatabase xiaode_course_table
```

密码通过 `Read-Host -AsSecureString` 输入。脚本不会打印密码，并在 `finally` 中清除密码环境变量、释放 SecureString 指针。Node 是前台服务，运行期间占用当前窗口属于正常现象。

如果端口已占用，脚本只显示进程信息并退出，不会自动终止其他进程。

## 健康检查

```powershell
.\scripts\check-storage.ps1
.\scripts\check-storage.ps1 -BaseUrl http://localhost:3001
```

`HEALTHY` 表示主存储和已启用的镜像正常；`DEGRADED` 表示 JSON 主业务正常、MySQL 镜像异常；`OFFLINE` 表示服务不可访问。

## 系统级备份

```powershell
.\scripts\backup-data.ps1 -Label daily -Keep 20
```

默认生成：

```text
backups/<yyyyMMdd-HHmmss>/db.json
backups/<yyyyMMdd-HHmmss>/manifest.json
```

manifest 记录版本、源路径、文件大小、SHA-256 和健康摘要。复制完成后会再次校验哈希。可选 MySQL 导出：

```powershell
.\scripts\backup-data.ps1 -IncludeMysql
```

找不到 `mysqldump.exe` 或导出失败不会破坏 JSON 备份。密码不进入命令行、manifest 或日志。

## 系统级恢复

恢复前先按 `Ctrl+C` 停止后端，再预览：

```powershell
.\scripts\restore-data.ps1 -BackupDirectory 'C:\work3\xiaode-course-table\backups\20260710-120000' -WhatIf
```

确认后执行：

```powershell
.\scripts\restore-data.ps1 -BackupDirectory 'C:\work3\xiaode-course-table\backups\20260710-120000'
```

恢复脚本会验证 manifest、JSON 和 SHA-256，自动为当前 `db.json` 建立新备份，然后用同目录临时文件原子替换。MySQL 不是恢复前提；下次启动或业务写入会重新镜像恢复后的 JSON。

网页内用户备份只作用于当前会话 accountId；本脚本是整个系统 `db.json` 的灾难恢复工具。
