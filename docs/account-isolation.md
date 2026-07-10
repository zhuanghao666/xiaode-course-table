# accountId 隔离约束

v39 的账号切换以服务端会话中的 `accountId` 为唯一数据边界。客户端提交的 `accountId` 不能改变写入目标。

## 后端约束

- 登录、注册和快速切换生成的 session 同时保存 `userId` 与 `accountId`。
- 每次鉴权都验证 account 必须存在且属于 session 的 user。
- 课程查询、更新、删除、覆盖导入和备份只使用 session 的精确 `accountId`。
- 设置和节次保存在 `settings[accountId]`，提醒保存在 `reminders[accountId]`。
- 普通接口若显式提交的顶层 `accountId` 或 `userId` 与会话不一致，直接返回 403；管理员接口另行校验管理员权限。
- 一次性导入码绑定创建时的 `userId + accountId + sessionTokenHash`，并记录 `expiresAt + usedAt`；Android 提交的 accountId 必须与导入码一致。
- 旧记录只有在 `userId` 能唯一映射到一个 accountId 时才自动补齐。无法唯一判断的数据原样保留、不会出现在任何普通账号查询中，并写入 `meta.migrationWarnings`。

## Web 约束

- 当前 token、user 和 accountId 必须作为同一组切换。
- 已保存账号按 accountId 去重，用户名只用于兼容旧浏览器记录。
- 课程设置、提醒设置和偏好缓存使用带 accountId 的 localStorage key。
- 偏好保存防抖按 accountId 分区，并捕获对应 token 和快照，快速切换不会把旧账号设置写入新账号。
- 后端返回的课程必须与当前 accountId 完全一致，否则前端丢弃。
- `loadMe()` 捕获请求开始时的 token 和请求版本；切换后到达的旧响应会被丢弃，切换期间以短暂遮罩隐藏旧账号内容。
- 保存的账号记录包含 `serverBaseUrl、userId、accountId、username、token、switchKey、lastUsedAt`；当前实现中的 token 字段等价于 `authToken`。

## Android 约束

- 小组件 payload 必须包含 accountId；SharedPreferences 按 accountId 保存，并单独记录当前激活账号。
- 小组件渲染前再次检查 payload accountId 与激活账号一致。
- 系统日历事件包含 `XIAODE_ACCOUNT::<accountId>` 标记；重新同步只删除相同 accountId 的旧事件。
- 原生导入流程捕获导入码所属 accountId，并在提交时交给后端复核。
- 导入成功事件携带被冻结的 accountId；只有该账号仍为 Web 当前账号时才刷新页面和 Widget，切换后的其他账号不会被旧导入任务刷新。
- Android 账号列表与 token 沿用现有 WebView/localStorage 架构；原生层不复制一份 token，避免两套账号状态漂移。localStorage 按服务器 origin 隔离。
- 当前工程没有 WorkManager 定时回写任务，因此不存在旧 WorkManager 任务覆盖新账号的问题。

## 用户级备份与系统级备份

- `/api/my/backup` 与 `/api/my/restore` 只处理会话 accountId 的课程、设置、提醒和节次。
- `scripts/backup-data.ps1` 与 `scripts/restore-data.ps1` 是管理员在服务停止后使用的整库 `db.json` 备份，不属于用户级接口。

## 验证

```powershell
cd C:\work3\xiaode-course-table\web\backend
npm test
```

测试账号 A、B 使用相同星期与节次，基线课程分别为 `A-物理` 与 `B-化学`。自动化覆盖：

- A 新增、修改、删除课程时 B 不变，A 猜测 B 的 courseId 不能修改或删除。
- A/B 各自覆盖导入、主题与提醒隔离。
- A 用户级备份恢复不覆盖 B。
- A token 携带 B accountId 返回 403，失效 token 返回 401。
- 导入码绑定 A，B accountId 提交不能使用；导入后 B 不变。
- MySQL 错端口时 JSON 写入与账号隔离仍正常。
- 旧数据唯一归属会补齐，歧义归属会保留并产生迁移警告。
