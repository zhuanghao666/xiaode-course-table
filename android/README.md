# 小德课表 Android v29 + Web v39 配套版

Android v29 继续作为 WebView 原生壳，配套 Web v39 本地 MySQL 测试版。

## 本版变化

- App 原生端功能保持 v28 稳定逻辑。
- 配套后端补丁升级到 Web v39：支持本地 MySQL 双写/读取测试。
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
