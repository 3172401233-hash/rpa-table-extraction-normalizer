'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TableNormalizer,
  isGap,
  GAP,
  gapIntervals,
} = require('../lib');

const columns = [
  { key: 'id', name: 'ID', index: 0 },
  { key: 'name', name: '名称', index: 1 },
  { key: 'remark', name: '备注', index: 2 },
];

function snapshotAt(capturedAt, pageIndex, rows, extra = {}) {
  const cells = [];
  rows.forEach((row, localRow) => {
    row.forEach((text, colIndex) => {
      cells.push({ role: 'cell', rowIndex: localRow, colIndex, text: String(text) });
    });
  });
  return {
    snapshot: {
      capturedAt,
      seq: extra.seq ?? capturedAt,
      snapshotId: extra.snapshotId ?? `s-${capturedAt}`,
      cells,
      ...extra,
    },
    page: { pageIndex, pageSize: 2 },
  };
}

test('虚拟滚动未加载的行标记 gap，不当作空值', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    totalRows: 6,
  });
  normalizer.ingestSnapshots([
    snapshotAt(100, 0, [['1', 'a', 'x'], ['2', 'b', 'y']]),
    snapshotAt(200, 2, [['5', 'i', 'p'], ['6', 'j', 'q']]),
  ]);

  const result = normalizer.toRecords();
  assert.equal(result.records.length, 6);
  assert.deepEqual(result.gaps, [{ start: 2, end: 3 }]);
  assert.equal(result.hasGaps, true);

  const gapRecord = result.records[2];
  assert.equal(gapRecord.gap, true);
  assert.ok(isGap(gapRecord.fields.id));
  assert.notEqual(gapRecord.fields.id, '');
  assert.notEqual(gapRecord.fields.id, null);
  assert.equal(result.records[0].gap, undefined);
});

test('未声明 totalRows 时按最大已加载行号推断，pendingGapPages 给出补抓页', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    totalRows: 8,
  });
  normalizer.ingestSnapshots([
    snapshotAt(100, 0, [['1', 'a', 'x'], ['2', 'b', 'y']]),
    {
      snapshot: {
        capturedAt: 200,
        snapshotId: 's-200',
        cells: [{ role: 'cell', rowIndex: 0, colIndex: 0, text: '7' }],
      },
      page: { pageIndex: 3, pageSize: 2 },
    },
  ]);

  const pending = normalizer.pendingGapPages();
  assert.deepEqual(pending, [
    { gap: { start: 2, end: 5 }, pageIndexes: [1, 2] },
    { gap: { start: 7, end: 7 }, pageIndexes: [3] },
  ]);
});

test('动态列：快照出现但定义里没有的列自动登记并参与输出', () => {
  const normalizer = new TableNormalizer({
    columns: [{ key: 'id', name: 'ID', index: 0 }],
    primaryKey: 'id',
    pageSize: 2,
  });
  normalizer.ingestSnapshot(
    {
      capturedAt: 1,
      cells: [
        { role: 'columnheader', rowIndex: 0, colIndex: 0, text: 'ID' },
        { role: 'columnheader', rowIndex: 0, colIndex: 1, text: '动态标签' },
        { role: 'cell', rowIndex: 0, colIndex: 0, text: '1' },
        { role: 'cell', rowIndex: 0, colIndex: 1, text: 'VIP' },
      ],
    },
    { pageIndex: 0, pageSize: 2 },
  );

  const result = normalizer.toRecords();
  const dynamic = result.columns.find((col) => col.dynamic);
  assert.ok(dynamic);
  assert.equal(dynamic.name, '动态标签');
  assert.equal(result.records[0].fields[dynamic.key], 'VIP');
});

test('声明但从未出现的列保留为 undefined，而不是 gap', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshot(
    {
      capturedAt: 1,
      cells: [
        { role: 'cell', rowIndex: 0, colIndex: 0, text: '1' },
        { role: 'cell', rowIndex: 0, colIndex: 1, text: 'a' },
      ],
    },
    { pageIndex: 0, pageSize: 2 },
  );
  const result = normalizer.toRecords();
  assert.equal(result.records[0].fields.remark, undefined);
  assert.ok(!isGap(result.records[0].fields.remark));
});

test('快照乱序：后处理的旧时间戳快照不会覆盖新数据', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    conflictPolicy: 'keepLatest',
  });
  normalizer.ingestSnapshot(
    snapshotAt(300, 0, [['1', '新名称', 'x'], ['2', 'b', 'y']], { snapshotId: 'new' })
      .snapshot,
    { pageIndex: 0, pageSize: 2 },
  );
  normalizer.ingestSnapshot(
    snapshotAt(100, 0, [['1', '旧名称', 'x'], ['2', 'b', 'y']], { snapshotId: 'old' })
      .snapshot,
    { pageIndex: 0, pageSize: 2 },
  );

  const result = normalizer.toRecords();
  assert.equal(result.records[0].fields.name, '新名称');
  assert.ok(
    result.anomalies.some((item) => item.type === 'duplicate-row-content-changed'),
  );
});

test('gapIntervals 工具：已加载集合求缺口区间', () => {
  assert.deepEqual(gapIntervals(new Set([0, 1, 4]), 6), [
    { start: 2, end: 3 },
    { start: 5, end: 5 },
  ]);
  assert.deepEqual(gapIntervals(new Set([0, 1, 2]), 3), []);
});

test('gap 记录所有字段都是 GAP 标记', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    totalRows: 1,
  });
  const result = normalizer.toRecords();
  assert.equal(result.records[0].gap, true);
  for (const value of Object.values(result.records[0].fields)) {
    assert.equal(value, GAP);
  }
});

test('未声明 totalRows 时按最大已加载全局行号推断，前置行全部为 gap', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
  });
  normalizer.ingestSnapshot(
    {
      capturedAt: 1,
      snapshotId: 'far-page',
      cells: [{ role: 'cell', rowIndex: 0, colIndex: 0, text: '9' }],
    },
    { pageIndex: 2, pageSize: 2 },
  );
  const result = normalizer.toRecords();
  assert.equal(result.totalRows, 5);
  assert.deepEqual(result.gaps, [{ start: 0, end: 3 }]);
  assert.equal(result.records[4].rowKey, 'pk:9');
});
