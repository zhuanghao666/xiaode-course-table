# v40 教务导入链路审计

本文记录 v40 开发开始时的真实实现，作为诊断模型、解析规则和回归测试的基线。`db.json` 仍是唯一主存储，MySQL 只在 `writeDb()` 成功后接收异步完整镜像。

## 数据流

```text
教务系统课表接口 JSON
  → Android MainActivity.fetchJwxtSchedule()
  → Android fetchAndUploadSchedule() 冻结导入码与 accountId
  → POST /api/import-code/:code/submit
  → collectJwxtCourseItems()
  → convertJwxtKbData()
  → parseJwxtDay() / mapJwxtItemToSlots() / normalizeWeeks()
  → normalizeCourse()
  → uniqueCourses()
  → accountId 范围内替换或追加
  → writeDb() 原子写 db.json
  → MySQL 异步事务镜像
  → Android xiaode-import-success 事件
  → Web loadMe() 与 Widget 刷新
```

## 分步审计

| 阶段 | 文件与函数 | 输入 | 输出 | 当前可能丢失或误判的条件 |
|---|---|---|---|---|
| 教务请求 | `android/.../MainActivity.kt`：`fetchJwxtSchedule()` | Cookie、xnm、xqm | 教务 JSON | Cookie 失效会返回登录页；当前首先要求 `kbList` 非空，其他来源有数据时也可能提前失败 |
| Android 上传 | `fetchAndUploadSchedule()` | JSON、importCode、accountId | `/api/import-code/:code/submit` 请求 | server URL 和 accountId 已在点击时读取，但 Activity 重建后上下文不持久；原生不持有小德 token，导入码是短期可验证上下文 |
| 导入码校验 | `server.js`：导入码 GET/submit 路由 | code、submitted accountId | 绑定的 userId/accountId/xnm/xqm/replace | 已使用、过期和不存在目前合并成同一 404；失败没有 traceId |
| 候选数组识别 | `collectJwxtCourseItems()` | 任意嵌套 JSON | `items + sourceCounts` | 深度最多 2；数组只扫描前 20 个子节点；`looksLikeJwxtCourseItem()` 会先过滤缺名称、缺星期等记录，后续无法回答为何丢失 |
| 字段提取 | `convertJwxtKbData()` | 候选对象 | 课程候选 | 只记录最终成功项，没有 sourceIndex、原始字段名摘要和 reasonCode |
| 星期解析 | `parseJwxtDay()` | xqj/weekday/day 或星期文本 | 1～7 | 文本通过包含任意数字/汉字匹配，未知格式返回 0 后被静默过滤 |
| 节次解析 | `mapJwxtItemToSlots()` | ksjc/jsjc 或 jcor/jcs/jc/skjc/jcxx | slot 数组 | 异常多区间只取第一个区间；倒序和越界直接空数组；连续课程被拆成多条逐 slot 记录 |
| 周次解析 | `normalizeWeeks()` | weeks 或 weekText | 数字数组 | 空周次在教务转换时被补为 `1-17周`；倒序范围会被自动交换；没有合理上限；单双周由另一函数单独处理 |
| 单双周 | `inferOddEvenFromText()` | weekText | all/odd/even | `weeks` 与 oddEven 的语义没有统一定义，容易出现范围与单双周重复过滤或不同文本产生不同指纹 |
| 规范化 | `normalizeCourse()` | 转换结果、会话 userId/accountId | v39 course | 只保留固定字段，不能标记教务来源、学期、trace、连续节次和调课属性 |
| 去重 | `uniqueCourses()` | 逐 slot 课程 | 去重课程 | 键为 day/slot/name/teacher/location/weekText/oddEven；同语义不同 weekText 不去重，同课程不同周次不能安全合并，也没有冲突诊断 |
| 保存前过滤 | 两个教务导入路由中的 `.filter()` | normalized course | 可写课程 | name/day/slot 无效时静默消失，没有候选级原因 |
| replace/append | `/api/my/import/jwxt-json`、导入码 submit | 当前 db + normalized | next db | replace 会删除该 accountId 的全部课程，手动课程和其他学期也会被删；没有导入前用户备份和来源范围 |
| JSON 提交 | `writeDb()` | 完整 next db | 原子 `db.json` | JSON 先写、MySQL 后镜像的顺序正确；单次路由只调用一次 writeDb |
| Android 完成 | `notifyXiaodeWebImportSuccess()` | ImportSummary | `xiaode-import-success` | 事件已携带原 accountId；摘要仍只展示 count/rawCount，缺少过滤、合并和冲突信息 |
| Web 刷新 | `index.html`：事件监听、`loadMe()` | 完成事件 | 当前账号 UI/Widget | 当前账号相同时会刷新；切换后会忽略旧账号事件，符合隔离要求，但没有“原账号已更新”的轻量状态 |

## 当前输入与输出结构

教务响应没有稳定单一结构。已知候选来源包括顶层 `kbList`，以及顶层或二级对象中的其他数组。候选常见字段：

- 名称：`kcmc、kcmcMc、kcmc_name、courseName、name`
- 星期：`xqj、xqjmc、weekday、day`
- 节次：`jcor、jcs、jc、ksjc、jsjc、skjc、jcxx、startSection、endSection`
- 周次：`zcd、zc、zcmc、weekText、weeks`
- 教师：`xm、jsxm、teacher、teachers、jsxx`
- 地点：`cdmc、jxcdmc、croomName、location、jxdd、skdd`

v39 课程是一条记录代表一个 `slot`。连续 1～2 节会转换为两条课程记录，Web 再按相邻同课程卡片做视觉跨行。v40 必须保留该兼容模型，同时记录原始 `startSlot/endSlot` 和拆分来源，避免无法解释的重复卡片。

## accountId 绑定

1. Web 创建导入码时从已验证 session 取得 userId/accountId，并保存 session token 的 SHA-256。
2. Android 只接收一次性导入码和绑定 accountId，不接收或保存小德明文 token。
3. submit 只能写导入码记录绑定的 accountId；客户端 accountId 仅作一致性校验。
4. normalizeCourse 强制覆盖 userId/accountId，候选数据不能改变归属。
5. replace 过滤条件是精确 `course.accountId === record.accountId`，不会删除其他账号数据。
6. 完成事件携带原 accountId；Web 只在它仍是当前账号时刷新。

## v40 需要建立的证据

- 所有候选，包括失败候选，都要有 source/sourceIndex、阶段结果和 reasonCode。
- 周次诊断中的 parsedWeeks 定义为应用单双周后的真实周次集合；为兼容 v39，持久课程仍可保存基础 weeks 与 oddEven，但不能把 oddEven 同时预过滤进基础 weeks。
- 去重必须区分完全重复、安全周次合并和排课冲突。
- 调课、不同教师、不同教室不能只按 name/day/slot 合并。
- replace 只替换当前 accountId、同学期、来源为 jwxt 的课程；保留手动课程和其他学期。
- 完整解析和 nextCourses 校验成功后，先创建当前账号用户级备份，再一次调用 writeDb；任何失败都不得先清空旧课程。
- 诊断不得保存 Cookie、密码、token、学号或完整原始教务响应。

## v41 当前落地结果

实现位于 `web/backend/src/import-pipeline.js` 和 `web/backend/src/import-diagnostics-store.js`。解析器不再递归导入所有课程型数组：正式课表只接受 `kbList`，额外课程只接受明确白名单；未知数组只诊断不导入。每条带学期字段的记录必须与冻结的 `selectedTermLabel/xnm/xqm` 一致。`parsedWeeks` 统一表示已应用单双周的最终真实周次集合，不再默认空周次为固定 17 周。

课程仍保持 v39 的逐 `slot` 兼容结构，新增 `source/sourceDetail/sourceIndex/startSlot/endSlot/term/xnm/xqm/isAdjusted/importTraceId` 供追踪。去重指纹包含账号、名称、日期节次、教师、地点、班组、周次、单双周、类别和来源；仅周次不同时安全合并，教室、教师或调课差异保留并标记冲突。

replace 最终范围是「导入码绑定 accountId + 同 `termKey` 学期 + `source=jwxt`」。`termKey` 固定包含 accountId，导入成功后写入账号 `activeTermKey`；Web、今日课程和 Widget 只消费激活学期。完整解析成功后先组装 `nextCourses`、验证归属、创建用户级导入前备份，再用一次 `writeDb()` 提交。Android 的 `ImportTaskContext` 在任务开始时冻结 server/importCode/accountId/学期/替换模式，完成事件只刷新仍处于激活状态的原账号。

总周数不再从任意嵌套元数据递归猜测。当前真实响应没有验证通过的总周数字段，`zxs` 明确按课程总学时处理并忽略；导入最多使用有效课程的最晚周次作为不可靠预览下界。`totalWeeksReliable=false` 时 Web、后端与 Android Widget 都保持 active 计算，不会仅凭该下界宣告学期结束；用户在当前账号和 term 的设置中确认后才形成可靠结束边界。
