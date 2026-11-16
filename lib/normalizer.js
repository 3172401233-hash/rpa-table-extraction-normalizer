'use strict';

const { normalizeSnapshot } = require('./snapshot');
const { resolveHeaderPaths } = require('./header');
const { ColumnRegistry } = require('./columns');
const { extractRow, gapRow } = require('./rows');
const { intervalsFromSet, gapIntervals } = require('./ranges');

const MAX_ANOMALIES = 200;

const DEFAULT_OPTIONS = {
  primaryKey: null,
  pageSize: null,
  totalRows: null,
  conflictPolicy: 'keepLatest', // keepLatest | keepFirst | error
  propagateMerged: true,
};

class TableNormalizer {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.primaryKey && !Array.isArray(this.options.primaryKey)) {
      this.options.primaryKey = [this.options.primaryKey];
    }
    this.registry = new ColumnRegistry(options.columns || []);
    this.reset();
  }

  reset() {
    this.snapshots = [];
    this.snapshotIds = new Set();
    this.rowsByKey = new Map();
    this.indexToKey = new Map();
    this.loadedIndices = new Set();
    this.pages = new Map();
    this.knownLeafByIndex = new Map();
    this.anomalies = [];
    this.stats = {
      snapshots: 0,
      duplicateSnapshots: 0,
      rowsIngested: 0,
      rowsReplaced: 0,
      duplicateRows: 0,
      stickyClones: 0,
      stickyCloneMismatches: 0,
      gapRows: 0,
      retries: 0,
    };
  }

  ingestSnapshot(rawSnapshot, page) {
    const normalized = normalizeSnapshot(rawSnapshot, page ?? rawSnapshot?.page);

    if (normalized.snapshotId !== null) {
      if (this.snapshotIds.has(normalized.snapshotId)) {
        this.stats.duplicateSnapshots += 1;
        return this;
      }
      this.snapshotIds.add(normalized.snapshotId);
    }

    this.snapshots.push(normalized);
    this.snapshots.sort(compareSnapshot);
    this.stats.snapshots += 1;

    this.trackPage(normalized);
    this.observeHeader(normalized);
    this.applyBody(normalized);
    return this;
  }

  ingestSnapshots(batch) {
    const sorted = [...batch].sort((a, b) => {
      const ta = Number(a.capturedAt ?? a.timestamp ?? 0);
      const tb = Number(b.capturedAt ?? b.timestamp ?? 0);
      return ta - tb;
    });
    for (const item of sorted) {
      this.ingestSnapshot(item.snapshot ?? item, item.page);
    }
    return this;
  }

  trackPage(normalized) {
    const pageIndex = normalized.page ? normalized.page.pageIndex : 0;
    let entry = this.pages.get(pageIndex);
    if (!entry) {
      entry = {
        pageIndex,
        attempts: 0,
        nonLoadingCaptures: 0,
        tokens: new Set(),
        rowKeys: new Set(),
        firstCapturedAt: normalized.capturedAt,
        lastCapturedAt: normalized.capturedAt,
      };
      this.pages.set(pageIndex, entry);
    }
    entry.attempts += 1;
    if (!normalized.loading) entry.nonLoadingCaptures += 1;
    if (entry.attempts > 1) this.stats.retries += 1;
    if (normalized.page && normalized.page.token) entry.tokens.add(normalized.page.token);
    entry.lastCapturedAt = Math.max(entry.lastCapturedAt, normalized.capturedAt);
  }

  observeHeader(normalized) {
    const headerPaths = resolveHeaderPaths(normalized.header);
    this.registry.observeSnapshot(normalized.header, headerPaths);

    // 动态列 / 表头变更检测：同一列位置的叶子表头发生变化时记录异常。
    for (const [colIndex, path] of headerPaths.entries()) {
      const leaf = path[path.length - 1] ?? '';
      const previous = this.knownLeafByIndex.get(colIndex);
      if (previous !== undefined && previous !== leaf) {
        this.report('header-changed', {
          colIndex,
          previous,
          current: leaf,
          snapshotId: normalized.snapshotId,
        });
      }
      this.knownLeafByIndex.set(colIndex, leaf);
    }
  }

  applyBody(normalized) {
    for (const localRowIndex of normalized.body.rowIndices) {
      const record = extractRow(normalized, localRowIndex, this.registry, this.options);
      this.stats.rowsIngested += 1;

      const existingKeyAt = this.indexToKey.get(record.globalRowIndex);
      if (existingKeyAt !== undefined && existingKeyAt !== record.rowKey) {
        this.report('row-key-conflict-at-index', {
          globalRowIndex: record.globalRowIndex,
          existingRowKey: existingKeyAt,
          incomingRowKey: record.rowKey,
          snapshotId: normalized.snapshotId,
        });
      }

      const existing = this.rowsByKey.get(record.rowKey);
      if (existing) {
        this.handleDuplicate(existing, record, normalized);
      } else {
        record.firstSeenAt = normalized.capturedAt;
        record.lastSeenAt = normalized.capturedAt;
        record.snapshotIds = normalized.snapshotId !== null ? [normalized.snapshotId] : [];
        this.rowsByKey.set(record.rowKey, record);
      }

      this.indexToKey.set(record.globalRowIndex, record.rowKey);
      this.loadedIndices.add(record.globalRowIndex);
      const pageIndex = normalized.page ? normalized.page.pageIndex : 0;
      this.pages.get(pageIndex).rowKeys.add(record.rowKey);
    }
  }

  handleDuplicate(existing, incoming, normalized) {
    this.stats.duplicateRows += 1;
    const stickyClone = incoming.isStickyRow === true;
    if (stickyClone) this.stats.stickyClones += 1;

    const sameContent = recordsEqual(existing, incoming);
    if (stickyClone && sameContent) return;
    if (stickyClone && !sameContent) {
      this.stats.stickyCloneMismatches += 1;
      this.report('sticky-clone-mismatch', {
        rowKey: incoming.rowKey,
        globalRowIndex: incoming.globalRowIndex,
        snapshotId: normalized.snapshotId,
      });
    }

    if (!sameContent && !stickyClone) {
      this.report('duplicate-row-content-changed', {
        rowKey: incoming.rowKey,
        globalRowIndex: incoming.globalRowIndex,
        snapshotId: normalized.snapshotId,
      });
    }

    if (this.options.conflictPolicy === 'error' && !sameContent) {
      throw new Error(
        `行键 ${incoming.rowKey} 在多个快照中内容不一致（conflictPolicy=error）`,
      );
    }

    const incomingWins =
      this.options.conflictPolicy === 'keepFirst'
        ? false
        : normalized.capturedAt >= existing.lastSeenAt;

    if (incomingWins) {
      incoming.firstSeenAt = existing.firstSeenAt;
      incoming.lastSeenAt = normalized.capturedAt;
      incoming.snapshotIds = unique([
        ...(existing.snapshotIds || []),
        ...(normalized.snapshotId !== null ? [normalized.snapshotId] : []),
      ]);
      this.rowsByKey.set(incoming.rowKey, incoming);
      this.stats.rowsReplaced += 1;
    }
  }

  report(type, detail) {
    if (this.anomalies.length >= MAX_ANOMALIES) return;
    this.anomalies.push({ type, ...detail });
  }

  get totalRows() {
    if (Number.isInteger(this.options.totalRows) && this.options.totalRows >= 0) {
      return this.options.totalRows;
    }
    if (this.loadedIndices.size === 0) return 0;
    return Math.max(...this.loadedIndices) + 1;
  }

  toRecords() {
    const totalRows = this.totalRows;
    const columns = this.registry.listOrdered();
    const records = [];
    const gapRanges = gapIntervals(this.loadedIndices, totalRows);

    for (let index = 0; index < totalRows; index += 1) {
      const rowKey = this.indexToKey.get(index);
      if (rowKey !== undefined) {
        records.push(this.rowsByKey.get(rowKey));
      } else {
        records.push(gapRow(index, columns));
      }
    }

    this.stats.gapRows = gapRanges.reduce((sum, gap) => sum + gap.end - gap.start + 1, 0);

    return {
      records,
      columns: columns.map((col) => ({
        key: col.key,
        name: col.name,
        index: col.index,
        sticky: col.sticky,
        dynamic: col.dynamic,
        observed: col.observed,
        headerPath: col.headerPath,
      })),
      gaps: gapRanges,
      loadedRanges: intervalsFromSet(this.loadedIndices),
      pages: this.pageSummaries(),
      totalRows,
      loadedRowCount: this.loadedIndices.size,
      hasGaps: gapRanges.length > 0,
      stats: { ...this.stats, gapRows: this.stats.gapRows },
      anomalies: [...this.anomalies],
    };
  }

  pageSummaries() {
    return [...this.pages.values()]
      .map((entry) => ({
        pageIndex: entry.pageIndex,
        attempts: entry.attempts,
        nonLoadingCaptures: entry.nonLoadingCaptures,
        retried: entry.attempts > 1,
        distinctRowCount: entry.rowKeys.size,
        tokens: [...entry.tokens],
        firstCapturedAt: entry.firstCapturedAt,
        lastCapturedAt: entry.lastCapturedAt,
      }))
      .sort((a, b) => a.pageIndex - b.pageIndex);
  }

  isComplete() {
    return !this.toRecords().hasGaps;
  }

  // 断点续抓：还缺哪些全局行区间，RPA 侧据此决定补抓哪一页。
  pendingGapPages(pageSize = this.options.pageSize) {
    return gapIntervals(this.loadedIndices, this.totalRows).map((gap) => {
      if (!Number.isInteger(pageSize) || pageSize <= 0) {
        return { gap, pageIndexes: null };
      }
      const first = Math.floor(gap.start / pageSize);
      const last = Math.floor(gap.end / pageSize);
      const pageIndexes = [];
      for (let p = first; p <= last; p += 1) pageIndexes.push(p);
      return { gap, pageIndexes };
    });
  }
}

function recordsEqual(a, b) {
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const key of keys) {
    if (a.fields[key] !== b.fields[key]) return false;
  }
  return a.primaryKey === b.primaryKey;
}

function unique(list) {
  return [...new Set(list)];
}

function compareSnapshot(a, b) {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt - b.capturedAt;
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
  return 0;
}

module.exports = {
  TableNormalizer,
  recordsEqual,
  compareSnapshot,
};
