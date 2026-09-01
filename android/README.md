# 小德课表 Android v33 local-first / ScheduleTemplate 版

Android 继续复用现有 Web 课表界面，但不再依赖局域网服务器才能启动。页面 shell 由 `WebViewAssetLoader` 从 APK 内的 `appassets` 加载，Android 原生桥把前端 API 路由到 Room；服务器恢复后，WorkManager 再完成后台同步。

## 数据链路

```text
Node.js 后端（db.json 主存储，MySQL 可降级镜像）
                ↕ snapshot / idempotent mutation
Android WorkManager + 冲突记录
                ↕
Room（账号、学期、课程、模板、偏好、outbox、同步状态）
                ↓
WebView 课表 UI + Android Widget
```

- 本地写入先在一个 Room 事务中更新课程/偏好并创建 `PendingMutation`，界面和 Widget 立即看到结果。
- 同步时按创建顺序先推送 outbox，再拉取服务器快照；普通 pull 不覆盖仍有本地 mutation 的记录。
- mutation 带稳定 `operationId` 和 `baseRevision`。服务器检测到并发修改时返回冲突，Android 保留本地值和冲突快照，不静默丢数据。
- token 使用 Android 加密存储；Room、WebView 响应和 JavaScript 本地存储均不保存原始 token 或账号切换密钥。
- 每个账号保存独立服务器地址、active term、课程和同步队列，地址失效不会清空本地缓存。

## 节次模板

Web、Android、截图、今日/下一节和 Widget 共享 `ScheduleTemplate`。课程同时保留学校原始 `sourceStartSlot/sourceEndSlot` 与小德逻辑 `startSlotKey/endSlotKey`。

- `legacy-default` 保持旧课程的视觉位置。
- 学校 A 的 source 5 映射为 `MIDDAY_1`（午间加时），source 6 映射为逻辑第 5 节。
- 学校 B 的 source 5 直接映射为逻辑第 5 节。
- `MIDDAY_EXTENSION + AUTO` 只在当前显示周确有课程时展开；它不占普通节次编号，也不会和 REGULAR 课程因原始数字连续而错误合并。
- 导入会冻结并保存当前学期模板；置信度不足时由用户在导入确认页选择，不静默猜测。

## 本地数据库与兼容

Room 当前 schema 版本为 2，包含 `accounts`、`terms`、`courses`、`slot_templates`、`preferences`、`pending_mutations`、`sync_metadata` 和 `sync_conflicts`。正式 `MIGRATION_1_2` 只建表/补齐 local-first 数据，不使用 destructive migration。旧 Widget SharedPreferences 会一次性迁入 `legacy-default`，原课节位置保持不变。

## 验证与构建

在 `android` 目录、Android Studio JBR 环境下执行：

```text
.\gradlew.bat :app:testDebugUnitTest --no-daemon
.\gradlew.bat :app:assembleDebug --no-daemon
```

调试 APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。构建产物、数据库、备份、`.env`、密钥和账号凭据均由 Git 忽略，不能提交。
