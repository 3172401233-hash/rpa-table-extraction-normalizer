'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSnapshot,
  materialize,
  resolveHeaderPaths,
  cellAt,
  GAP,
  COVERED,
} = require('../lib');

// 合并单元格快照：A 跨行合并两行；B 跨两列。
function mergedSnapshot() {
  return {
    capturedAt: 1,
    cells: [
      { role: 'cell', rowIndex: 0, colIndex: 0, rowSpan: 2, text: 'A' },
      { role: 'cell', rowIndex: 0, colIndex: 1, colSpan: 2, text: 'B' },
      { role: 'cell', rowIndex: 1, colIndex: 1, text: 'C' },
      { role: 'cell', rowIndex: 1, colIndex: 2, text: 'D' },
    ],
  };
}

test('行列跨度：合并起点保留真实节点，覆盖位置标记 COVERED', () => {
  const normalized = normalizeSnapshot(mergedSnapshot());
  assert.deepEqual(normalized.body.rowIndices, [0, 1]);
  assert.deepEqual(normalized.body.colIndices, [0, 1, 2]);

  const matrix = materialize(normalized.body, normalized.body.rowIndices, normalized.body.colIndices);
  assert.equal(matrix[0][0].text, 'A');
  assert.equal(matrix[0][1].text, 'B');
  assert.equal(matrix[0][2], COVERED);
  assert.equal(matrix[1][0], COVERED);
  assert.equal(matrix[1][1].text, 'C');
  assert.equal(matrix[1][2].text, 'D');

  // 被覆盖位置仍能找回 span 起点（用于值传播，而不是重复展开）。
  const anchor = cellAt(normalized.body, 1, 0);
  assert.equal(anchor.text, 'A');
  assert.deepEqual([anchor.rowIndex, anchor.colIndex], [0, 0]);
});

test('合并表头：多级表头还原为列路径，重复层级去重', () => {
  const snapshot = {
    capturedAt: 1,
    cells: [
      { role: 'columnheader', rowIndex: 0, colIndex: 0, colSpan: 2, text: '订单' },
      { role: 'columnheader', rowIndex: 1, colIndex: 0, text: '订单号' },
      { role: 'columnheader', rowIndex: 1, colIndex: 1, text: '金额' },
      { role: 'columnheader', rowIndex: 0, colIndex: 2, rowSpan: 2, text: '状态' },
    ],
  };
  const normalized = normalizeSnapshot(snapshot);
  const paths = resolveHeaderPaths(normalized.header);

  assert.deepEqual(paths.get(0), ['订单', '订单号']);
  assert.deepEqual(paths.get(1), ['订单', '金额']);
  // rowSpan=2 的表头在第二行覆盖同列，重复文本只保留一次。
  assert.deepEqual(paths.get(2), ['状态']);
});

test('分页按钮和 loading 指示器不属于网格，不会被当成单元格', () => {
  const normalized = normalizeSnapshot({
    capturedAt: 1,
    root: [
      {
        role: 'row',
        children: [
          { role: 'cell', text: 'x' },
          { role: 'button', name: '下一页' },
          { role: 'progressbar', name: '加载中' },
        ],
      },
    ],
  });
  assert.equal(normalized.stats.bodyCells, 1);
  assert.equal(normalized.body.colIndices.length, 1);
});

test('缺少坐标的嵌套行节点按出现顺序自动排列', () => {
  const normalized = normalizeSnapshot({
    capturedAt: 1,
    root: [
      { role: 'row', children: [{ role: 'cell', text: 'a' }, { role: 'cell', text: 'b' }] },
      { role: 'row', children: [{ role: 'cell', text: 'c' }] },
    ],
  });
  assert.equal(cellAt(normalized.body, 1, 0).text, 'c');
  assert.equal(cellAt(normalized.body, 0, 1).text, 'b');
});

test('GAP 与 COVERED 是不同的语义标记，均不等于空字符串', () => {
  assert.notEqual(GAP, COVERED);
  assert.notEqual(GAP, '');
  assert.notEqual(COVERED, '');
  assert.notEqual(GAP, null);
});
