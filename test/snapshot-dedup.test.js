'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TableNormalizer } = require('../lib');

const columns = [{ key: 'id', name: 'ID', index: 0 }];

function snapshot(snapshotId, text, capturedAt) {
  return {
    capturedAt,
    snapshotId,
    cells: [{ role: 'cell', rowIndex: 0, colIndex: 0, text }],
  };
}

test('相同 snapshotId 的重复投递直接跳过，不产生重复行', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id', pageSize: 2 });
  normalizer.ingestSnapshot(snapshot('cap-1', '1', 100), { pageIndex: 0, pageSize: 2 });
  normalizer.ingestSnapshot(snapshot('cap-1', '1', 200), { pageIndex: 0, pageSize: 2 });

  const result = normalizer.toRecords();
  assert.equal(result.stats.snapshots, 1);
  assert.equal(result.stats.duplicateSnapshots, 1);
  assert.equal(result.records.length, 1);
});

test('分页状态缺少合法 pageIndex 时抛错', () => {
  const normalizer = new TableNormalizer({ columns });
  assert.throws(
    () => normalizer.ingestSnapshot(snapshot('x', '1', 1), { pageIndex: -1 }),
    /pageIndex/,
  );
});

test('无分页状态时页内行号即全局行号，记录到第 0 页', () => {
  const normalizer = new TableNormalizer({ columns, primaryKey: 'id' });
  normalizer.ingestSnapshot(snapshot('x', '1', 1));
  const result = normalizer.toRecords();
  assert.equal(result.records[0].globalRowIndex, 0);
  assert.equal(result.pages[0].pageIndex, 0);
});
