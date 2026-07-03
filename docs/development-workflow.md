# 开发规范

## 分支规则

- `main` 只保存稳定版本。
- 所有新功能从 `main` 拉 `feature` 分支。
- bug 修复从 `main` 拉 `fix` 分支。
- 不允许直接在 `main` 上改业务代码。

## 分支命名

```text
feature/功能名
fix/问题名
refactor/模块名
docs/文档名
```

## 提交信息规范

使用 conventional commit：

```text
feat: 新功能
fix: 修复问题
refactor: 重构
docs: 文档
chore: 工程配置
test: 测试
```

## Codex 修改前检查

每次 Codex 修改前必须执行：

```powershell
git status --branch --short
```

确认当前分支、工作区状态和未提交文件，再开始修改。

## 提交前安全检查

每次提交前必须确认不要提交：

- `node_modules`
- `.env`
- `db.json`
- `local.properties`
- APK / AAB
- keystore / jks
- `build` / `.gradle`

如果这些文件出现在 `git status` 或暂存区中，必须先停止并处理 `.gitignore` 或撤出暂存区。

## 版本 tag 规则

稳定版本使用：

```text
v40-功能名
v41-功能名
```

tag 只在稳定版本合并到 `main` 后创建。

## 推荐开发流程

```powershell
git checkout main
git pull
git checkout -b feature/xxx

# 修改代码
# 测试

git status --branch --short
git add .
git status --branch --short
git commit -m "feat: xxx"
git push -u origin feature/xxx
```

确认功能稳定后合并回 `main`，再按版本规则打 tag。
