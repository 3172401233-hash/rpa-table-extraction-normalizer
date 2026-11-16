'use strict';

const { encodeForJson, decodeFromJson } = require('./markers');

const FORMAT_VERSION = 1;

// 检查点只保存“已归一化状态”，不保存原始快照；恢复后可继续增量 ingest。
function createCheckpoint(normalizer) {
  const result = normalizer.toRecords();
  return {
    formatVersion: FORMAT_VERSION,
    createdAt: Date.now(),
    options: encodeForJson(normalizer.options),
    columns: normalizer.registry.toJSON(),
    rowsByKey: [...normalizer.rowsByKey.entries()].map(([key, record]) => [
      key,
      encodeForJson(record),
    ]),
    indexToKey: [...normalizer.indexToKey.entries()],
    loadedIndices: [...normalizer.loadedIndices].sort((a, b) => a - b),
    pages: [...normalizer.pages.values()].map((entry) => ({
      ...entry,
      tokens: [...entry.tokens],
      rowKeys: [...entry.rowKeys],
    })),
    knownLeafByIndex: [...normalizer.knownLeafByIndex.entries()],
    snapshotIds: [...normalizer.snapshotIds],
    snapshots: normalizer.snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      seq: snapshot.seq,
      pageIndex: snapshot.page ? snapshot.page.pageIndex : 0,
    })),
    anomalies: normalizer.anomalies,
    stats: normalizer.stats,
    totalRows: result.totalRows,
    gaps: result.gaps,
  };
}

function stringifyCheckpoint(normalizer) {
  return JSON.stringify(createCheckpoint(normalizer));
}

function restoreCheckpoint(checkpoint, TableNormalizer) {
  const data =
    typeof checkpoint === 'string' ? JSON.parse(checkpoint) : decodeFromJson(checkpoint);

  const normalizer = new TableNormalizer({
    ...data.options,
    columns: [],
  });

  normalizer.registry = restoreRegistry(data.columns);
  normalizer.rowsByKey = new Map(
    data.rowsByKey.map(([key, record]) => [key, decodeFromJson(record)]),
  );
  normalizer.indexToKey = new Map(
    data.indexToKey.map(([index, key]) => [Number(index), key]),
  );
  normalizer.loadedIndices = new Set(data.loadedIndices.map(Number));
  normalizer.pages = new Map(
    data.pages.map((entry) => [
      entry.pageIndex,
      {
        ...entry,
        tokens: new Set(entry.tokens),
        rowKeys: new Set(entry.rowKeys),
      },
    ]),
  );
  normalizer.knownLeafByIndex = new Map(
    data.knownLeafByIndex.map(([index, leaf]) => [Number(index), leaf]),
  );
  normalizer.snapshotIds = new Set(data.snapshotIds);
  normalizer.snapshots = data.snapshots || [];
  normalizer.anomalies = data.anomalies || [];
  normalizer.stats = data.stats || normalizer.stats;
  return normalizer;
}

function restoreRegistry(data) {
  // 延迟 require，避免与 columns 模块形成加载顺序耦合。
  const { ColumnRegistry } = require('./columns');
  return ColumnRegistry.fromJSON(data);
}

module.exports = {
  createCheckpoint,
  stringifyCheckpoint,
  restoreCheckpoint,
  FORMAT_VERSION,
};
