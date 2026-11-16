'use strict';

const { COVERED } = require('./markers');

function cellAt(layout, rowIndex, colIndex) {
  if (!layout) return undefined;
  return layout.grid.get(`${rowIndex}:${colIndex}`);
}

// 返回 cell 覆盖的所有网格坐标（含起点）。
function coveredRange(cell) {
  const out = [];
  for (let r = cell.rowIndex; r < cell.rowIndex + cell.rowSpan; r += 1) {
    for (let c = cell.colIndex; c < cell.colIndex + cell.colSpan; c += 1) {
      out.push([r, c]);
    }
  }
  return out;
}

function isCoveredCell(layout, rowIndex, colIndex, cell) {
  return cell.rowIndex !== rowIndex || cell.colIndex !== colIndex;
}

// 把布局物化成二维矩阵：合并起点放真实 cell，覆盖位置放 COVERED 标记，
// 没有任何节点覆盖的位置也是 COVERED（对调用方等价于“该格无独立值”）。
function materialize(layout, rowIndices, colIndices) {
  const matrix = [];
  for (const r of rowIndices) {
    const row = [];
    for (const c of colIndices) {
      const cell = cellAt(layout, r, c);
      if (!cell) {
        row.push(COVERED);
      } else if (isCoveredCell(layout, r, c, cell)) {
        row.push(COVERED);
      } else {
        row.push(cell);
      }
    }
    matrix.push(row);
  }
  return matrix;
}

module.exports = {
  cellAt,
  coveredRange,
  isCoveredCell,
  materialize,
};
