# rpa-table-extraction-normalizer

面向 RPA 场景的 Node.js 表格抽取归一化库。输入按时间截取的 accessibility（AX）
节点快照、分页状态和列定义，根据单元格行列跨度、合并表头和业务主键，把多次、
乱序、部分加载的网格快照还原成稳定的二维记录集合。

## 职责边界

本库**只消费已经采集好的 AX 节点快照**，负责数据层面的还原与归一化：

- 不负责打开页面、滚动、点击分页按钮或处理浏览器时序；
- 不依赖任何浏览器驱动、CDP 连接或屏幕坐标；
- 分页按钮、loading 指示器等非网格节点会在归一化时被直接忽略；
- RPA 侧负责产生快照并驱动翻页，本库负责判断“还缺哪些行 / 哪一页需要补抓”。

## 解决的问题

- **合并单元格重复展开**：按 `rowSpan` / `colSpan` 建网格，合并起点保留真实值，
  覆盖位置标记为 `COVERED`，默认把锚点值传播到被覆盖的记录，并保留锚点坐标。
- **虚拟滚动缺口**：未加载的全局行输出 `gap: true` 的记录，字段值为 `GAP`
  标记，与空字符串、`null`、未声明列的 `undefined` 严格区分，绝不当作空值。
- **分页重试 / 返回上一页**：按业务主键生成稳定行键，重复抓取自动去重，
  记录每页尝试次数、loading 捕获次数和内容变化异常。
- **相同文本不同行**：行键来自业务主键（或回退到全局行号），文本相同但主键
  不同的行不会被错误合并。
- **快照乱序**：按 `capturedAt`（及 `seq`）排序，旧时间戳快照不会覆盖新数据。
- **动态列 / 合并表头 / 粘性列**：多级表头还原为列路径；快照中出现但未声明的
  列自动登记为动态列；粘性列产生的克隆行静默去重，内容不一致时报异常。
- **断点续抓**：检查点可序列化为 JSON，恢复后继续增量合并，并通过
  `pendingGapPages()` 指出需要补抓的页。

## 安装与测试

```bash
npm test        # node --test test/*.test.js
```

无运行时依赖，要求 Node.js >= 18，CommonJS 引入。

## 快速开始

```js
const { TableNormalizer, isGap, stringifyCheckpoint, restoreCheckpoint } =
  require('rpa-table-extraction-normalizer');

const normalizer = new TableNormalizer({
  columns: [
    { key: 'id', name: 'ID', index: 0 },
    { key: 'name', name: '名称', index: 1 },
  ],
  primaryKey: 'id',
  pageSize: 20,
  totalRows: 137,          // 可选；缺省时按最大已加载全局行号推断
  conflictPolicy: 'keepLatest', // keepLatest | keepFirst | error
  propagateMerged: true,   // 合并单元格是否向被覆盖记录传播值
});

// RPA 每次截到一屏 AX 节点后调用；快照可以乱序、重复、跨页。
normalizer.ingestSnapshot(snapshot, { pageIndex: 3, pageSize: 20 });
// 或批量喂入，内部会按 capturedAt 排序。
normalizer.ingestSnapshots([{ snapshot, page }]);

const result = normalizer.toRecords();
// result.records   二维记录（含 gap 占位行）
// result.gaps      未加载的全局行区间
// result.pages     每页尝试/重试统计
// result.anomalies 表头变更、同键内容变化、粘性克隆不一致等异常

for (const record of result.records) {
  if (record.gap || isGap(record.fields.id)) continue; // 缺口不是空值
  // record.rowKey 稳定行键：pk:<主键> 或 row:<全局行号>
}

// 断点：落盘后在另一个进程恢复并续抓。
const json = stringifyCheckpoint(normalizer);
const restored = restoreCheckpoint(JSON.parse(json), TableNormalizer);
restored.pendingGapPages(); // [{ gap: { start, end }, pageIndexes: [...] }]
```

## 快照输入格式

快照是普通 JSON 对象，支持嵌套节点树或平铺单元格数组：

```js
// 形态一：嵌套 AX 树（row -> cell），缺少坐标时按出现顺序自动排列
{
  capturedAt: 1710000000000,
  seq: 12,                       // 可选，同时间戳时的次序
  loading: false,                // loading 期间的抓取只累计尝试次数
  snapshotId: 'cap-12',          // 可选，重复 id 直接跳过
  headerNodes: [{ role: 'row', children: [{ role: 'columnheader', text: 'ID' }] }],
  root: [{ role: 'row', children: [{ role: 'cell', text: 'A1' }] }],
}

// 形态二：平铺 cells（合成测试常用），坐标为页内局部序号
{
  capturedAt: 1710000000000,
  cells: [
    { role: 'columnheader', rowIndex: 0, colIndex: 0, text: 'ID' },
    { role: 'cell', rowIndex: 0, colIndex: 0, rowSpan: 2, text: '华东', sticky: true },
    { role: 'cell', rowIndex: 0, colIndex: 1, colSpan: 2, text: '汇总' },
  ],
}
```

单元格支持 `rowSpan` / `colSpan`、`sticky`（或 `pinned` / `frozen`）、
`origin` / `nodeId`（节点来源标识）。分页状态 `{ pageIndex, pageSize, token }`
用于把页内局部行号换算成全局行号；`pageIndex` 为必填的非负整数。

## 输出语义

- `GAP`（Symbol）：虚拟滚动未加载，检查点 JSON 中编码为 `[[RPA_TABLE_GAP]]`。
- `COVERED`（Symbol）：被合并单元格覆盖、自身无独立值；关闭值传播时出现。
- `undefined`：列已声明但所有快照里都没出现过，属于“缺列”而非缺口。
- `''`：节点真实存在但文本为空，属于业务空值。

## 模块结构

- `lib/snapshot.js`：节点树拍平、分页按钮过滤、页内行号到全局行号平移。
- `lib/grid.js` / `lib/header.js`：跨度网格物化与多级表头路径还原。
- `lib/columns.js`：列注册表，静态列绑定与动态列自动登记。
- `lib/rows.js`：行抽取、合并值传播与稳定行键。
- `lib/normalizer.js`：分页状态、去重冲突策略、gap 区间与异常收集。
- `lib/checkpoint.js` / `lib/ranges.js` / `lib/markers.js`：断点、区间与标记。
- `test/`：基于合成节点快照的 `node:test` 用例。
