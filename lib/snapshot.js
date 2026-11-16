'use strict';

const HEADER_ROLES = new Set(['columnheader', 'rowheader', 'header']);
const ROW_ROLES = new Set(['row', 'rowgroup']);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(node) {
  if (node === null || node === undefined) return '';
  if (node.text !== undefined) return String(node.text);
  if (node.name !== undefined) return String(node.name);
  if (node.value !== undefined && typeof node.value !== 'object') return String(node.value);
  return '';
}

function positiveInt(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function boolAttr(node, ...keys) {
  return keys.some((key) => node[key] === true || node[key] === 'true');
}

function isRowNode(node) {
  return ROW_ROLES.has(node.role) || node.isRow === true;
}

function isCellNode(node) {
  return (
    HEADER_ROLES.has(node.role) ||
    node.role === 'cell' ||
    node.role === 'gridcell' ||
    node.isCell === true
  );
}

function isHeaderCell(node) {
  return HEADER_ROLES.has(node.role) || node.isHeader === true;
}

// 拍平嵌套快照（row -> cell），分页按钮、loading 指示器等非网格节点在此被丢弃。
// 每个 cell 带上它所属 row 节点的隐式行序号（同层 row 的出现顺序）。
function collectNodes(nodes, out, rowPath) {
  let rowCounter = 0;
  for (const node of asArray(nodes)) {
    if (node === null || typeof node !== 'object') continue;
    if (isCellNode(node)) {
      out.push({ node, implicitRow: rowPath.length ? rowPath[rowPath.length - 1] : 0 });
      continue;
    }
    const children = node.children || node.childNodes || node.nodes;
    if (Array.isArray(children) && children.length > 0) {
      const nextPath = isRowNode(node) ? [...rowPath, rowCounter] : rowPath;
      if (isRowNode(node)) rowCounter += 1;
      collectNodes(children, out, nextPath);
    }
  }
  return out;
}

function rowIndexOf(cell, rowIndex) {
  const explicit = cell.rowIndex ?? cell.row;
  if (Number.isInteger(explicit)) return explicit;
  return rowIndex;
}

function colIndexOf(cell) {
  const explicit = cell.colIndex ?? cell.columnIndex ?? cell.column ?? cell.col;
  return Number.isInteger(explicit) ? explicit : null;
}

function normalizeCell(cell, isHeader, implicitRowIndex) {
  const rowSpan = positiveInt(cell.rowSpan ?? cell.rowspan, 1);
  const colSpan = positiveInt(cell.colSpan ?? cell.colspan, 1);
  return {
    id: cell.id ?? null,
    origin: cell.origin ?? cell.originId ?? cell.nodeId ?? null,
    text: nodeText(cell),
    rowIndex: rowIndexOf(cell, implicitRowIndex),
    colIndex: colIndexOf(cell),
    rowSpan,
    colSpan,
    isHeader,
    sticky: boolAttr(cell, 'sticky', 'isSticky', 'pinned', 'isPinned', 'frozen'),
    raw: cell,
  };
}

function buildLayout(cells) {
  const grid = new Map();
  const rows = new Map();

  for (const cell of cells) {
    const rowIdx = cell.rowIndex;
    if (!Number.isInteger(rowIdx) || rowIdx < 0) continue;

    let colIdx = cell.colIndex;
    if (colIdx === null) {
      const row = rows.get(rowIdx);
      colIdx = row ? row.nextCol : 0;
    }

    for (let r = rowIdx; r < rowIdx + cell.rowSpan; r += 1) {
      for (let c = colIdx; c < colIdx + cell.colSpan; c += 1) {
        const key = `${r}:${c}`;
        if (grid.has(key)) continue;
        grid.set(key, cell);
      }
      const rowMeta = rows.get(r) || { nextCol: 0 };
      rowMeta.nextCol = Math.max(rowMeta.nextCol, colIdx + cell.colSpan);
      rows.set(r, rowMeta);
    }
  }

  const rowIndices = [...rows.keys()].sort((a, b) => a - b);
  const colIndices = [...new Set([...grid.keys()].map((key) => Number(key.split(':')[1])))].sort(
    (a, b) => a - b,
  );

  return { grid, rowIndices, colIndices };
}

// 页内局部行号 -> 全局行号：整体平移布局坐标（合并单元格的锚点一并平移）。
function shiftLayout(layout, rowOffset) {
  if (!rowOffset) return layout;
  const grid = new Map();
  for (const [key, cell] of layout.grid.entries()) {
    const [r, c] = key.split(':').map(Number);
    grid.set(`${r + rowOffset}:${c}`, cell);
  }
  for (const cell of new Set(layout.grid.values())) {
    cell.rowIndex += rowOffset;
  }
  return {
    ...layout,
    grid,
    rowIndices: layout.rowIndices.map((rowIndex) => rowIndex + rowOffset),
  };
}

// 输入快照允许两种形态：
// 1. { headerNodes, bodyNodes } 或 { nodes } 的节点树（可嵌套 row -> cell）
// 2. 已经显式给出 { cells, rows } 的平铺布局（合成测试常用）
function normalizeSnapshot(snapshot = {}, page) {
  const capturedAt = Number(snapshot.capturedAt ?? snapshot.timestamp ?? Date.now());
  const seq = Number.isInteger(snapshot.seq) ? snapshot.seq : null;

  let headerCells = [];
  let bodyCells = [];

  if (Array.isArray(snapshot.cells)) {
    headerCells = snapshot.cells
      .filter((cell) => isHeaderCell(cell))
      .map((cell) => normalizeCell(cell, true, cell.rowIndex ?? 0));
    bodyCells = snapshot.cells
      .filter((cell) => !isHeaderCell(cell))
      .map((cell) => normalizeCell(cell, false, cell.rowIndex ?? 0));
  } else {
    const headerNodes = asArray(snapshot.headerNodes ?? snapshot.headers);
    const bodyNodes = asArray(
      snapshot.bodyNodes ?? snapshot.rows ?? snapshot.nodes ?? snapshot.root,
    );

    const flatHeader = collectNodes(headerNodes, [], []);
    headerCells = flatHeader.map(({ node, implicitRow }) =>
      normalizeCell(node, true, node.rowIndex ?? implicitRow),
    );

    const flatBody = collectNodes(bodyNodes, [], []);
    bodyCells = flatBody.map(({ node, implicitRow }) =>
      normalizeCell(node, false, node.rowIndex ?? implicitRow),
    );
  }

  const normalizedPage = normalizePage(page ?? snapshot.page);
  const header = buildLayout(headerCells);
  const bodyLayout = buildLayout(bodyCells);
  const pageSize =
    (normalizedPage && normalizedPage.pageSize) ||
    positiveInt(snapshot.pageSize, 0) ||
    null;
  const rowOffset =
    normalizedPage && pageSize ? normalizedPage.pageIndex * pageSize : 0;
  const body = shiftLayout(bodyLayout, rowOffset);

  return {
    snapshotId: snapshot.snapshotId ?? null,
    capturedAt,
    seq,
    loading: snapshot.loading === true,
    page: normalizedPage,
    rowOffset,
    viewport: normalizeViewport(snapshot.viewport),
    header,
    body,
    stats: {
      headerCells: headerCells.length,
      bodyCells: bodyCells.length,
      bodyRows: bodyLayout.rowIndices.length,
    },
  };
}

function normalizePage(page) {
  if (page === undefined || page === null) return null;
  const pageIndex = Number(page.pageIndex ?? page.page ?? page.pageNo);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('分页状态 page.pageIndex 必须是非负整数');
  }
  const pageSize = Number.isInteger(page.pageSize) && page.pageSize > 0 ? page.pageSize : null;
  return {
    pageIndex,
    pageSize,
    token: page.token ?? page.cursor ?? null,
    source: page.source ?? null,
  };
}

function normalizeViewport(viewport) {
  if (viewport === undefined || viewport === null) return null;
  const startRow = Number(viewport.startRow ?? viewport.firstRow ?? viewport.offset);
  const endRow = Number(viewport.endRow ?? viewport.lastRow);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow)) return null;
  return {
    startRow: Math.min(startRow, endRow),
    endRow: Math.max(startRow, endRow),
    startCol: Number.isInteger(viewport.startCol) ? viewport.startCol : null,
    endCol: Number.isInteger(viewport.endCol) ? viewport.endCol : null,
  };
}

module.exports = {
  normalizeSnapshot,
  normalizePage,
  buildLayout,
  collectNodes,
  isCellNode,
  isHeaderCell,
  isRowNode,
  nodeText,
};
