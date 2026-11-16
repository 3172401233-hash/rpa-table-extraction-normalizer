'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TableNormalizer, isCovered } = require('../lib');

const columns = [
  { key: 'id', name: 'ID', index: 0 },
  { key: 'name', name: '名称', index: 1 },
  { key: 'city', name: '城市', index: 2 },
];

function bodySnapshot(pageIndex, rows, extra = {}) {
  const cells = [];
  rows.forEach((row, localRow) => {
    row.forEach((text, colIndex) => {
      if (text === null) return;
      cells.push({ role: 'cell', rowIndex: localRow, colIndex, text: String(text) });
    });
  });
  return {
    snapshot: {
      capturedAt: extra.capturedAt ?? 1000 + pageIndex,
      seq: extra.seq ?? pageIndex,
      loading: extra.loading ?? false,
      snapshotId: extra.snapshotId ?? `p${pageIndex}-${extra.attempt ?? 0}`,
      cells,
    },
    page: { pageIndex, pageSize: 2, ...(extra.token ? { token: extra.token } : {}) },
  };
}

test('业务主键生成稳定行键；相同文本不同行不会被错误合并', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshots([
    bodySnapshot(0, [
      ['1', '张三', '北京'],
      ['2', '张三', '北京'],
    ]),
    bodySnapshot(1, [
      ['3', '张三', '北京'],
      ['4', '李四', '上海'],
    ]),
  ]);

  const result = normalizer.toRecords();
  assert.equal(result.records.length, 4);
  assert.deepEqual(
    result.records.map((record) => record.rowKey),
    ['pk:1', 'pk:2', 'pk:3', 'pk:4'],
  );
  assert.deepEqual(
    result.records.map((record) => record.globalRowIndex),
    [0, 1, 2, 3],
  );
  assert.equal(result.stats.duplicateRows, 0);
});

test('分页重试与返回上一页：重复行按键去重，统计重试次数', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshots([
    bodySnapshot(0, [
      ['1', '张三', '北京'],
      ['2', '李四', '上海'],
    ]),
    // loading 期间分页按钮重复触发，抓到同一页。
    bodySnapshot(0, [
      ['1', '张三', '北京'],
      ['2', '李四', '上海'],
    ], { attempt: 1, loading: true, capturedAt: 1100, snapshotId: 'p0-retry1' }),
    bodySnapshot(1, [
      ['3', '王五', '广州'],
      ['4', '赵六', '深圳'],
    ]),
    // 返回上一页，旧行再抓一次。
    bodySnapshot(0, [
      ['1', '张三', '北京'],
      ['2', '李四', '上海'],
    ], { attempt: 2, capturedAt: 1300, snapshotId: 'p0-back' }),
  ]);

  const result = normalizer.toRecords();
  assert.equal(result.records.length, 4);
  assert.equal(result.loadedRowCount, 4);
  assert.equal(result.stats.duplicateRows, 4);

  const page0 = result.pages.find((page) => page.pageIndex === 0);
  assert.equal(page0.attempts, 3);
  assert.equal(page0.nonLoadingCaptures, 2);
  assert.equal(page0.retried, true);
  assert.equal(page0.distinctRowCount, 2);
  assert.ok(result.stats.retries >= 2);
});

test('同键内容变化触发异常；conflictPolicy=error 直接抛错', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshots([
    bodySnapshot(0, [
      ['1', '张三', '北京'],
      ['2', '李四', '上海'],
    ]),
    bodySnapshot(0, [
      ['1', '张三丰', '北京'],
      ['2', '李四', '上海'],
    ], { attempt: 1, capturedAt: 1200, snapshotId: 'p0-changed' }),
  ]);

  const result = normalizer.toRecords();
  assert.ok(result.anomalies.some((item) => item.type === 'duplicate-row-content-changed'));
  // keepLatest：后到快照覆盖。
  assert.equal(result.records[0].fields.name, '张三丰');

  const strict = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    conflictPolicy: 'error',
  });
  strict.ingestSnapshot(bodySnapshot(0, [['1', '张三', '北京']]).snapshot, {
    pageIndex: 0,
    pageSize: 2,
  });
  assert.throws(() => {
    strict.ingestSnapshot(
      bodySnapshot(0, [['1', '张三丰', '北京']], { snapshotId: 'x' }).snapshot,
      { pageIndex: 0, pageSize: 2 },
    );
  }, /不一致/);
});

test('无业务主键时回退到全局行号键，跨页仍稳定', () => {
  const normalizer = new TableNormalizer({ columns, pageSize: 2 });
  normalizer.ingestSnapshots([
    bodySnapshot(0, [['1', 'a', 'x'], ['2', 'b', 'y']]),
    bodySnapshot(1, [['3', 'c', 'z'], ['4', 'd', 'w']]),
  ]);
  const result = normalizer.toRecords();
  assert.deepEqual(
    result.records.map((record) => record.rowKey),
    ['row:0', 'row:1', 'row:2', 'row:3'],
  );
  assert.ok(result.records[0].primaryKeyMissing);
});

test('合并单元格默认传播值，并在 mergedCells 中保留锚点；关闭传播时为 COVERED', () => {
  const snapshot = {
    capturedAt: 1,
    cells: [
      { role: 'cell', rowIndex: 0, colIndex: 0, text: '门店A' },
      { role: 'cell', rowIndex: 1, colIndex: 0, text: '门店B' },
      { role: 'cell', rowIndex: 0, colIndex: 2, rowSpan: 2, text: '华东' },
      { role: 'cell', rowIndex: 0, colIndex: 1, text: 'A-1' },
      { role: 'cell', rowIndex: 1, colIndex: 1, text: 'B-1' },
    ],
  };

  const propagating = new TableNormalizer({ columns, primaryKey: 'name', pageSize: 2 });
  propagating.ingestSnapshot(snapshot, { pageIndex: 0, pageSize: 2 });
  const propagated = propagating.toRecords();
  assert.equal(propagated.records[0].fields.city, '华东');
  assert.equal(propagated.records[1].fields.city, '华东');
  assert.equal(propagated.records[1].mergedCells[0].anchor.rowIndex, 0);

  const raw = new TableNormalizer({
    columns,
    primaryKey: 'name',
    pageSize: 2,
    propagateMerged: false,
  });
  raw.ingestSnapshot(snapshot, { pageIndex: 0, pageSize: 2 });
  const rawResult = raw.toRecords();
  assert.ok(isCovered(rawResult.records[1].fields.city));
});

test('粘性列克隆：相同内容静默去重，不一致内容报异常', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshots([
    {
      snapshot: {
        capturedAt: 1,
        snapshotId: 's1',
        cells: [
          { role: 'cell', rowIndex: 0, colIndex: 0, text: '1', sticky: true },
          { role: 'cell', rowIndex: 0, colIndex: 1, text: '张三' },
          { role: 'cell', rowIndex: 0, colIndex: 2, text: '北京' },
        ],
      },
      page: { pageIndex: 0, pageSize: 2 },
    },
    {
      snapshot: {
        capturedAt: 2,
        snapshotId: 's2',
        cells: [
          { role: 'cell', rowIndex: 0, colIndex: 0, text: '1', sticky: true },
          { role: 'cell', rowIndex: 0, colIndex: 1, text: '张三' },
          { role: 'cell', rowIndex: 0, colIndex: 2, text: '北京' },
        ],
      },
      page: { pageIndex: 0, pageSize: 2 },
    },
  ]);
  const result = normalizer.toRecords();
  assert.equal(result.records.length, 1);
  assert.equal(result.stats.stickyClones, 1);
  assert.equal(result.stats.stickyCloneMismatches, 0);
});
