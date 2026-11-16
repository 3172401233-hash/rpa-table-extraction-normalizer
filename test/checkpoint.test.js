'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TableNormalizer,
  stringifyCheckpoint,
  restoreCheckpoint,
  isGap,
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
      seq: capturedAt,
      snapshotId: extra.snapshotId ?? `s-${capturedAt}-${pageIndex}`,
      cells,
    },
    page: { pageIndex, pageSize: 2 },
  };
}

test('断点续抓：检查点序列化恢复后补齐 gap 并保持去重', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    totalRows: 4,
  });
  normalizer.ingestSnapshots([
    snapshotAt(100, 0, [['1', 'a', 'x'], ['2', 'b', 'y']]),
  ]);

  const before = normalizer.toRecords();
  assert.equal(before.hasGaps, true);
  assert.ok(isGap(before.records[2].fields.id));

  const json = stringifyCheckpoint(normalizer);
  assert.equal(typeof json, 'string');
  const restored = restoreCheckpoint(JSON.parse(json), TableNormalizer);

  // 续抓时先重抓第 0 页（应去重），再补第 1 页。
  restored.ingestSnapshots([
    snapshotAt(400, 0, [['1', 'a', 'x'], ['2', 'b', 'y']], { snapshotId: 'resume-p0' }),
    snapshotAt(500, 1, [['3', 'c', 'z'], ['4', 'd', 'w']], { snapshotId: 'resume-p1' }),
  ]);

  const after = restored.toRecords();
  assert.equal(after.hasGaps, false);
  assert.equal(after.records.length, 4);
  assert.equal(after.records[2].rowKey, 'pk:3');
  assert.equal(after.records[3].fields.name, 'd');
  assert.equal(after.stats.duplicateRows, 2);
  assert.equal(after.stats.gapRows, 0);
});

test('检查点往返：列注册表、页状态、异常均保留', () => {
  const normalizer = new TableNormalizer({
    columns,
    primaryKey: 'id',
    pageSize: 2,
    totalRows: 2,
  });
  normalizer.ingestSnapshots([
    snapshotAt(100, 0, [['1', 'a', 'x'], ['2', 'b', 'y']]),
    snapshotAt(200, 0, [['1', 'a', 'x'], ['2', 'b', 'y']], { snapshotId: 'retry' }),
  ]);

  const restored = restoreCheckpoint(
    JSON.parse(stringifyCheckpoint(normalizer)),
    TableNormalizer,
  );
  const result = restored.toRecords();
  assert.equal(result.records.length, 2);
  assert.equal(result.pages[0].attempts, 2);
  assert.equal(result.columns.length, 3);
  assert.equal(restored.stats.duplicateRows, 2);
});
