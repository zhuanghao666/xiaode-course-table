# accountId 隔离约束

v39 的账号切换以服务端会话中的 `accountId` 为唯一数据边界。客户端提交的 `accountId` 不能改变写入目标。

## 后端约束

- 登录、注册和快速切换生成的 session 同时保存 `userId` 与 `accountId`。
- 每次鉴权都验证 account 必须存在且属于 session 的 user。
- 课程查询、更新、删除、覆盖导入和备份只使用 session 的精确 `accountId`。
- 设置和节次保存在 `settings[accountId]`，提醒保存在 `reminders[accountId]`。
- 一次性导入码绑定创建时的 `userId + accountId`；Android 提交的 accountId 必须与导入码一致。
- 旧数据启动迁移会为缺少 accountId 的 session、course、feedback 和 importCode 补齐兼容值，但业务接口不再使用 `userId OR accountId` 的宽松判断。

## Web 约束

- 当前 token、user 和 accountId 必须作为同一组切换。
- 已保存账号按 accountId 去重，用户名只用于兼容旧浏览器记录。
- 课程设置、提醒设置和偏好缓存使用带 accountId 的 localStorage key。
- 偏好保存防抖按 accountId 分区，并捕获对应 token 和快照，快速切换不会把旧账号设置写入新账号。
- 后端返回的课程必须与当前 accountId 完全一致，否则前端丢弃。

## Android 约束

- 小组件 payload 必须包含 accountId；SharedPreferences 按 accountId 保存，并单独记录当前激活账号。
- 小组件渲染前再次检查 payload accountId 与激活账号一致。
- 系统日历事件包含 `XIAODE_ACCOUNT::<accountId>` 标记；重新同步只删除相同 accountId 的旧事件。
- 原生导入流程捕获导入码所属 accountId，并在提交时交给后端复核。

## 验证

```powershell
cd C:\work3\xiaode-course-table\web\backend
npm test
```

测试覆盖两个账号的课程读取与修改、偏好与提醒、节次设置、覆盖导入、备份、一次性导入码以及 accountId 伪造请求。
