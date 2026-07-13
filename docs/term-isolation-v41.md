# v41 学期隔离与动态周数

## 根因与边界

v40 已经把 Web 选择的原始 `xnm/xqm` 冻结进 Android `ImportTaskContext`，Activity 重建后也能原样恢复。实际混课根因位于后端：旧候选收集器递归扫描教务响应中的所有数组，只要对象看起来像课程就会导入；同时账号接口返回该账号所有课程，显示层没有 `activeTermKey` 边界。

v41 只把以下明确数组当作课程来源：正式课表 `kbList`，以及 `sjkList、practiceList、adjustmentList、tkList、bkList、bkkbList、temporaryCourseList、extraCourseList`。未知数组中的课程型对象只计入 `filteredUnknownSourceCount`，不进入转换。白名单记录若带 `xnm/xqm` 或完整学期名称，必须和冻结学期一致，否则计入 `filteredWrongTermCount`。

## 数据模型

正式学期键固定为：

```text
termKey = accountId + ":" + xnm + ":" + xqm
```

`db.json` 的 `terms[]` 为每个账号学期保存 `selectedTermLabel、termStart、totalWeeks、totalWeeksSource`。课程保存相同 `termKey/xnm/xqm/selectedTermLabel`，账号保存 `activeTermKey`。`/api/auth/me` 只返回当前 activeTerm 的课程，并同时返回 `activeTerm` 与 `availableTerms`。

无法确定学期的旧课程不会删除或猜测归属，而是迁移到该账号的 `accountId:legacy` 学期。旧 `xnm:xqm` 键会幂等升级为 `accountId:xnm:xqm`。

## 总周数

每次教务导入按以下顺序确定当前 term 的 `totalWeeks`：

1. 教务响应中的明确总周数字段；
2. 本次有效课程 weeks 的最大值；
3. 已保存的 term 总周数；
4. 默认 20 周。

如果来自课程最大周次，诊断返回 `totalWeeksSource=course-max-week`。用户可在“课表设置”里手工修改当前学期的总周数和开学日期，修改不会影响其他学期。

## 历史混合数据的安全处理

修复上线后，在 Web 顶部选择目标学期，再对该学期执行一次“覆盖导入”。覆盖范围严格是当前 `accountId + termKey + source=jwxt`，不会删除其他账号、其他学期或 legacy 学期。若旧课程没有可验证的学期字段，它会留在“历史课程”学期供人工核对，不会被静默删除。

建议操作前先运行：

```powershell
cd C:\work3\xiaode-course-table
.\scripts\backup-data.ps1 -Label before-v41-term-cleanup
```

## 接口摘要

- `GET /api/auth/me`：返回 `activeTerm、availableTerms、courses、termStart、totalWeeks`。
- `PUT /api/my/active-term`：仅可切换当前会话账号拥有的 termKey。
- `PUT /api/my/active-term/settings`：修改当前 term 的 `termStart/totalWeeks`。
- 导入 submit 必须逐项等于导入码冻结的 `accountId、selectedTermLabel、xnm、xqm、replace`。

MySQL 仍只是镜像。v41 镜像新增 `terms` 表及课程 term 字段；启动和同步方向仍然只能从 `db.json` 到 MySQL。
