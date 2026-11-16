'use strict';

const { leafHeaderText } = require('./header');

function normalizePath(path) {
  if (path === undefined || path === null) return null;
  const list = Array.isArray(path) ? path : [path];
  const out = list.map((part) => String(part).trim()).filter((part) => part !== '');
  return out.length > 0 ? out : null;
}

function samePath(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((part, index) => part === b[index]);
}

function pathStartsWith(prefix, path) {
  if (!prefix || !path) return false;
  if (prefix.length > path.length) return false;
  return prefix.every((part, index) => part === path[index]);
}

class ColumnRegistry {
  constructor(columns) {
    // key: 稳定列标识；indexKey -> col；colIndex 可能随快照变化，只代表最近一次观察位置。
    this.columns = new Map();
    this.indexKey = new Map();
    this.seq = 0;

    for (const col of columns || []) {
      this.upsertDeclared(col);
    }
  }

  upsertDeclared(col) {
    const key = col.key || col.name || col.id;
    if (!key) throw new Error('column 定义必须包含 key（或 name/id）');
    const headerPath = normalizePath(col.headerPath ?? col.header);
    this.columns.set(String(key), {
      key: String(key),
      name: col.name || String(key),
      headerPath,
      index: col.index ?? null,
      sticky: col.sticky === true,
      dynamic: col.dynamic === true,
      observed: false,
      order: this.seq += 1,
    });
  }

  observe(colIndex, headerPaths, stickySet) {
    const headerPath = headerPaths.get(colIndex) || null;
    const leaf = leafHeaderText(headerPaths, colIndex) || null;
    const sticky = stickySet.has(colIndex);

    let column = this.matchDeclared(colIndex, headerPath, leaf);
    if (!column) {
      const dynamicKey = leaf
        ? `dynamic:${leaf}`
        : `dynamic:col${colIndex}`;
      column = this.columns.get(dynamicKey);
      if (!column) {
        column = {
          key: dynamicKey,
          name: leaf || dynamicKey,
          headerPath,
          index: colIndex,
          sticky,
          dynamic: true,
          observed: true,
          order: this.seq += 1,
        };
        this.columns.set(dynamicKey, column);
      }
    }

    column.observed = true;
    column.index = colIndex;
    column.sticky = column.sticky || sticky;
    if (headerPath) column.headerPath = headerPath;
    this.indexKey.set(colIndex, column.key);
    return column;
  }

  matchDeclared(colIndex, headerPath, leaf) {
    for (const column of this.columns.values()) {
      if (column.observed) continue;
      if (column.index === colIndex) return column;
    }
    for (const column of this.columns.values()) {
      if (column.observed) continue;
      if (column.headerPath && headerPath && samePath(column.headerPath, headerPath)) {
        return column;
      }
    }
    for (const column of this.columns.values()) {
      if (column.observed) continue;
      if (leaf && (column.name === leaf || column.key === leaf)) return column;
    }
    return null;
  }

  keyAt(colIndex) {
    const observed = this.indexKey.get(colIndex);
    if (observed) return observed;
    // 没有表头快照时，列定义里声明的静态 index 直接生效。
    for (const column of this.columns.values()) {
      if (column.index === colIndex) return column.key;
    }
    return null;
  }

  observeSnapshot(headerLayout, headerPaths) {
    const stickySet = require('./header').stickyHeaderCols(headerLayout);
    const seen = new Set();
    for (const colIndex of headerLayout ? headerLayout.colIndices : []) {
      const column = this.observe(colIndex, headerPaths, stickySet);
      seen.add(column.key);
    }
    return seen;
  }

  // 声明但从未在快照中出现的列：记录保留键、值缺失（与 gap 区分）。
  listOrdered() {
    return [...this.columns.values()].sort((a, b) => {
      const ai = Number.isInteger(a.index) ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.index) ? b.index : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.order - b.order;
    });
  }

  toJSON() {
    return {
      seq: this.seq,
      columns: [...this.columns.values()],
      indexKey: [...this.indexKey.entries()],
    };
  }

  static fromJSON(data) {
    const registry = new ColumnRegistry([]);
    registry.seq = data.seq;
    registry.columns = new Map(data.columns.map((col) => [col.key, col]));
    registry.indexKey = new Map(data.indexKey.map(([index, key]) => [Number(index), key]));
    return registry;
  }
}

module.exports = {
  ColumnRegistry,
  normalizePath,
  samePath,
  pathStartsWith,
};
