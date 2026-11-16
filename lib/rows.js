'use strict';

const { GAP, COVERED } = require('./markers');
const { cellAt } = require('./grid');

function buildRowKey(pkValue, rowIndex) {
  if (pkValue !== undefined && pkValue !== null && String(pkValue).trim() !== '') {
    return `pk:${String(pkValue)}`;
  }
  return `row:${rowIndex}`;
}

function extractRow(normalized, rowIndex, registry, options) {
  const { body } = normalized;
  const fields = {};
  const mergedCells = [];
  const cellOrigins = {};
  let hasStickyCell = false;

  for (const colIndex of body.colIndices) {
    const key = registry.keyAt(colIndex);
    if (!key) continue;
    const cell = cellAt(body, rowIndex, colIndex);
    if (!cell) {
      fields[key] = COVERED;
      continue;
    }

    const covered = cell.rowIndex !== rowIndex || cell.colIndex !== colIndex;
    cellOrigins[key] = cell.origin;
    if (cell.sticky) hasStickyCell = true;

    if (covered) {
      fields[key] = options.propagateMerged ? cell.text : COVERED;
      if (options.propagateMerged) {
        mergedCells.push({
          column: key,
          origin: cell.origin,
          anchor: { rowIndex: cell.rowIndex, colIndex: cell.colIndex },
          text: cell.text,
        });
      }
    } else {
      fields[key] = cell.text;
      if (cell.rowSpan > 1 || cell.colSpan > 1) {
        mergedCells.push({
          column: key,
          origin: cell.origin,
          anchor: { rowIndex: cell.rowIndex, colIndex: cell.colIndex },
          rowSpan: cell.rowSpan,
          colSpan: cell.colSpan,
          text: cell.text,
        });
      }
    }
  }

  // 声明了但本快照未出现的列：缺失而非 gap。
  for (const column of registry.listOrdered()) {
    if (!Object.prototype.hasOwnProperty.call(fields, column.key)) {
      fields[column.key] = undefined;
    }
  }

  const pkColumns = options.primaryKey
    ? (Array.isArray(options.primaryKey) ? options.primaryKey : [options.primaryKey])
    : [];

  let pkValue = null;
  let pkMissing = pkColumns.length === 0;
  if (pkColumns.length > 0) {
    const parts = pkColumns.map((key) => {
      const value = fields[key];
      if (value === undefined || value === COVERED || value === GAP || value === '') {
        return null;
      }
      return String(value);
    });
    if (parts.every((part) => part !== null)) {
      pkValue = parts.join('|');
      pkMissing = false;
    } else {
      pkMissing = true;
    }
  }

  const page = normalized.page ? normalized.page.pageIndex : null;
  const globalRowIndex = rowIndex;
  const rowKey = buildRowKey(pkValue, globalRowIndex);

  return {
    rowKey,
    rowIndex: rowIndex - normalized.rowOffset,
    globalRowIndex,
    pageIndex: page,
    primaryKey: pkMissing ? null : pkValue,
    primaryKeyMissing: pkMissing,
    fields,
    mergedCells,
    cellOrigins,
    isStickyRow: hasStickyCell,
  };
}

function gapRow(globalRowIndex, columns) {
  const fields = {};
  for (const column of columns) fields[column.key] = GAP;
  return {
    rowKey: `gap:${globalRowIndex}`,
    rowIndex: null,
    globalRowIndex,
    pageIndex: null,
    primaryKey: null,
    gap: true,
    fields,
    mergedCells: [],
    cellOrigins: {},
  };
}

module.exports = {
  extractRow,
  buildRowKey,
  gapRow,
};
