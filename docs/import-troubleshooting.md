# v40 教务导入诊断与验收

v40 开发分支为每次教务导入生成 `traceId`，并返回「收到、识别、接受、过滤、合并、写入」摘要。`db.json` 仍是唯一主存储，MySQL 只在 JSON 成功落盘后接收异步镜像。

## 开启持久化诊断

诊断文件默认关闭。在后端启动前设置：

```powershell
$env:XIAODE_IMPORT_DIAGNOSTICS='1'
npm start
```

开启后，脱敏 trace 保存到 `web/backend/data/import-diagnostics/`，每个 trace 一个 JSON，默认只保留最新 20 份。目录与原子写入临时文件均已被 Git 忽略。文件不保存 Cookie、密码、token、sessionToken 原文、学号或完整教务响应。

## 查看诊断

- 普通用户：`GET /api/my/import-diagnostics/latest`，只返回当前会话 `accountId` 的最新安全摘要。
- 管理员：`GET /api/admin/import-diagnostics` 查看摘要列表，`GET /api/admin/import-diagnostics/:traceId` 查看单次脱敏详情。
- `GET /api/health` 的 `importDiagnostics` 字段显示是否开启、保留数量与内存摘要数量。

即使诊断文件关闭，进程内仍保留最基本的安全摘要，供导入响应和当前用户接口返回。

## reasonCode

`MISSING_NAME`、`MISSING_DAY`、`INVALID_DAY`、`MISSING_SECTION`、`INVALID_SECTION`、`MISSING_WEEKS`、`INVALID_WEEKS`、`DUPLICATE_EXACT`、`MERGED_SAME_COURSE`、`CONFLICTING_SCHEDULE`、`UNSUPPORTED_STRUCTURE`、`ACCOUNT_MISMATCH`、`EXPIRED_IMPORT_CODE`、`USED_IMPORT_CODE`、`MISSING_TERM_PARAMS`、`INVALID_TERM_PARAMS`、`TERM_RESPONSE_MISMATCH`、`UNKNOWN`。

学期选择必须使用界面选项携带的原始 `xnm/xqm` value。Web、Android 和后端均不再回退到固定学期。trace 同时记录 `selectedTermLabel/requestedXnm/requestedXqm/effectiveXnm/effectiveXqm`；只要教务课程响应中的学期与请求不一致，本次导入就会在 `writeDb()` 前终止。

失败响应包含明确 HTTP 状态码、`traceId`、`reasonCode` 和可读消息，不返回敏感原始数据。

## 替换与冲突策略

`replace=true` 只替换导入码绑定 `accountId` 下、相同 `xnm/xqm` 学期且 `source=jwxt` 的课程。手工课程、其他学期和其他账号不受影响。完整解析、校验和用户级导入前备份完成后，才调用一次 `writeDb()`；失败不会先清空旧课程。

完全重复去重；同课程仅周次不同时合并周次；教师、教室、班组或调课标记不同时保留两条可表达记录，并产生 `CONFLICTING_SCHEDULE` 警告。

## 自动化验证

```powershell
cd C:\work3\xiaode-course-table\web\backend
npm install
node --check src/server.js
node --check src/mysql-store.js
node --check src/import-pipeline.js
node --check src/import-diagnostics-store.js
npm test

cd C:\work3\xiaode-course-table\android
.\gradlew.bat --no-daemon --console=plain testDebugUnitTest assembleDebug
```

## 真机后续验收

1. 当前账号导入成功后，课程、今日/下节课和 Widget 无需手动刷新。
2. 导入过程切到另一账号，旧账号的完成事件不覆盖新账号页面；切回后自动刷新。
3. 导入期间将 App 退到后台并重建 Activity，确认冻结的 server/accountId/importCode/学期不丢失。
4. 验证导入码过期、已使用与账号不匹配的明确错误。
5. 使用实际教务样本核对首次读取、刷新后读取、调课、单双周和不连续周次。
