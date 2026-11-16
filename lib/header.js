'use strict';

const { cellAt } = require('./grid');

function pushSegment(segments, text) {
  const value = String(text ?? '').trim();
  if (value === '') return;
  if (segments[segments.length - 1] !== value) segments.push(value);
}

// 合并表头（多级表头）还原：为每个叶子列生成路径，如 ['订单','基本信息','订单号']。
// 同一列在多行表头里被同一个合并单元格覆盖时，重复的文本只保留一次。
function resolveHeaderPaths(headerLayout) {
  if (!headerLayout || headerLayout.rowIndices.length === 0) {
    return new Map();
  }

  const colIndices = headerLayout.colIndices;
  const rowIndices = headerLayout.rowIndices;
  const paths = new Map();

  for (const colIndex of colIndices) {
    const segments = [];
    for (const rowIndex of rowIndices) {
      const cell = cellAt(headerLayout, rowIndex, colIndex);
      if (cell) pushSegment(segments, cell.text);
    }
    paths.set(colIndex, segments);
  }
  return paths;
}

function leafHeaderText(paths, colIndex) {
  const segments = paths.get(colIndex);
  if (!segments || segments.length === 0) return null;
  return segments[segments.length - 1];
}

function stickyHeaderCols(headerLayout) {
  const sticky = new Set();
  if (!headerLayout) return sticky;
  for (const cell of headerLayout.grid.values()) {
    if (cell.sticky) {
      for (let c = cell.colIndex; c < cell.colIndex + cell.colSpan; c += 1) {
        sticky.add(c);
      }
    }
  }
  return sticky;
}

module.exports = {
  resolveHeaderPaths,
  leafHeaderText,
  stickyHeaderCols,
  pushSegment,
};
