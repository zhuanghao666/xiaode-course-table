# 小德课表 Android + Web v39 accountId 隔离版

Android v29 继续作为 WebView 原生壳，配套 Web v39 本地 MySQL 测试版。

## 本版变化

- WebView 账号切换后，小组件按当前 `accountId` 读取独立缓存。
- 原生日历提醒写入和清理均带 `accountId` 标记，不再清理其他账号的提醒。
- 一次性导入码同时绑定后端 `accountId`，App 上传时再次校验账号上下文。
- 后端仍以 `db.json` 为主存储，MySQL 仅作为镜像。
- 默认仍然连接你的 Web 后端地址，例如：

```text
http://电脑IPv4:3001
```

## 注意

MySQL 是后端的事情，不是在 Android App 里直连数据库。

正确结构：

```text
Android App
  ↓
Node.js 后端 3001
  ↓
MySQL / db.json
```

不要把 MySQL 账号密码写进 Android App。
