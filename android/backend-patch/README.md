# 后端兼容入口

Android 不维护独立后端副本。仓库唯一后端实现位于：

```text
web/backend/src/server.js
web/backend/src/mysql-store.js
```

本目录的两个 JavaScript 文件仅用于兼容旧命令，并直接加载或导出上述实现。不要再把历史 server patch 应用到当前 v39 后端，否则可能绕过 accountId 隔离和 JSON 主存储逻辑。
