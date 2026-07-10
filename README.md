# 小德课表

小德课表包含 Web、Node.js/Express 后端和 Android WebView App。当前代码为 v39 JSON 主存储、MySQL 异步镜像与 accountId 隔离版本。

## 目录结构

```text
xiaode-course-table/
├─ web/       Web 前端与 Node.js/Express 后端
├─ android/   Android App
├─ docs/      部署、数据库和维护文档
├─ scripts/   启动、健康检查、备份和恢复脚本
├─ CHANGELOG.md
├─ VERSION
├─ README.md
├─ VERSION.md
└─ .gitignore
```

## 当前版本

- 当前版本：v39
- Web 版本：v39（`package.json` 版本 `39.0.0`）
- Android 版本：0.28.0-v39-account-isolation
- 默认存储：`web/backend/data/db.json`
- 可选模式：MySQL 异步镜像，使用 `XIAODE_STORAGE=mysql` 开启

## Web 启动方式

MySQL 镜像模式会安全提示输入密码，密码不会写入文件：

```powershell
cd C:\work3\xiaode-course-table
.\scripts\start-web-mysql.ps1
```

纯 JSON 模式：

```powershell
.\scripts\start-web-json.ps1
```

启动脚本会检查 Node、npm、后端目录和端口占用。Node 前台运行期间 PowerShell 窗口一直被占用是正常现象，按 `Ctrl+C` 可停止服务。

手工开发模式：

```powershell
cd C:\work3\xiaode-course-table\web\backend
npm install
npm start
```

开发时也可以使用：

```powershell
npm run dev
```

服务默认监听：

```text
http://localhost:3001
```

健康检查：

```powershell
.\scripts\check-storage.ps1
```

备份和恢复唯一主存储 `db.json`：

```powershell
.\scripts\backup-data.ps1 -Label before-change
.\scripts\restore-data.ps1 -BackupDirectory 'C:\work3\xiaode-course-table\backups\yyyyMMdd-HHmmss' -WhatIf
.\scripts\restore-data.ps1 -BackupDirectory 'C:\work3\xiaode-course-table\backups\yyyyMMdd-HHmmss'
```

恢复前必须先停止后端。系统级脚本恢复整个 `db.json`；网页内的“我的备份”只恢复当前 accountId，两者不能混用。详见 `docs/storage.md`。

## Android 打包方式

用 Android Studio 打开：

```text
C:\work3\xiaode-course-table\android
```

确认 SDK 与 Gradle 配置正常后，执行 Debug 构建。当前仓库不提交 APK/AAB 成品，也不提交签名文件。

如果本机已安装 Gradle，也可以在 Android 项目目录尝试：

```powershell
cd C:\work3\xiaode-course-table\android
gradle assembleDebug
```

后端 accountId 隔离回归测试：

```powershell
cd C:\work3\xiaode-course-table\web\backend
npm test
```

隔离设计与审计结果见 `docs/account-isolation.md`。

## db.json 默认模式

不设置 MySQL 环境变量时，后端使用：

```text
web/backend/data/db.json
```

该文件保存本地课程、账号、会话等运行数据。它可能包含真实个人数据，因此已被 `.gitignore` 忽略，不应该提交到 GitHub。

## MySQL 镜像模式

v39 始终以 `db.json` 为事实来源。开启 MySQL 后，后端会把成功落盘的完整 JSON 快照异步镜像到 MySQL；MySQL 数据不会在启动时覆盖本地 JSON。

详见：

```text
docs/mysql-local-test.md
```

## 安全注意事项

不要提交以下内容：

- MySQL 密码、token、cookie、环境变量文件
- `db.json` 真实课程数据、账号数据、会话数据
- Android 签名文件：`*.keystore`、`*.jks`
- APK/AAB 成品包
- `node_modules/`、Gradle `build/`、`.gradle/`

后续功能修改建议通过分支开发、提交记录和版本 tag 管理。
