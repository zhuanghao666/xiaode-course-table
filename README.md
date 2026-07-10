# 小德课表

小德课表是一个课表管理项目，包含 Web 端、Node.js/Express 后端和 Android WebView App。当前稳定版本是 v39 本地 MySQL 测试版。

## 目录结构

```text
xiaode-course-table/
├─ web/       Web 前端与 Node.js/Express 后端
├─ android/   Android App
├─ docs/      部署、数据库和维护文档
├─ README.md
├─ VERSION.md
└─ .gitignore
```

## 当前版本

- 当前版本：v39
- Web 项目来源：xiaode-course-table-web-v39-mysql-local-test
- Android 版本：0.28.0-v39-account-isolation
- 默认存储：`web/backend/data/db.json`
- 可选模式：本地 MySQL 测试模式，使用 `XIAODE_STORAGE=mysql` 开启

## Web 启动方式

推荐直接在项目根目录运行一键启动脚本。默认安全提示输入 MySQL 密码，密码不会写入文件：

```powershell
cd C:\work3\xiaode-course-table
.\start-v39.ps1
```

纯 JSON 模式：

```powershell
.\start-v39.ps1 -JsonOnly
```

默认使用 `db.json` 本地文件模式：

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
.\health-v39.ps1
```

备份和恢复唯一主存储 `db.json`：

```powershell
.\backup-v39.ps1 -Label before-change
.\restore-v39.ps1 -BackupFile 'C:\work3\xiaode-course-table\backups\v39\db-时间-before-change.json'
```

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
