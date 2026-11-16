'use strict';

// 虚拟滚动未加载的行 / 单元格：语义上是“缺口”，不是空值。
const GAP = Symbol.for('rpaTableNormalizer.gap');

// 被合并单元格覆盖（自身没有独立值，值由 span 起点传播）。
const COVERED = Symbol.for('rpaTableNormalizer.covered');

const GAP_TAG = '[[RPA_TABLE_GAP]]';
const COVERED_TAG = '[[RPA_TABLE_COVERED]]';

function isGap(value) {
  return value === GAP;
}

function isCovered(value) {
  return value === COVERED;
}

// 检查点需要 JSON 序列化，用字符串标签替代 Symbol。
function encodeForJson(value) {
  if (value === GAP) return GAP_TAG;
  if (value === COVERED) return COVERED_TAG;
  if (Array.isArray(value)) return value.map(encodeForJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = encodeForJson(value[key]);
    }
    return out;
  }
  return value;
}

function decodeFromJson(value) {
  if (value === GAP_TAG) return GAP;
  if (value === COVERED_TAG) return COVERED;
  if (Array.isArray(value)) return value.map(decodeFromJson);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = decodeFromJson(value[key]);
    }
    return out;
  }
  return value;
}

module.exports = {
  GAP,
  COVERED,
  GAP_TAG,
  COVERED_TAG,
  isGap,
  isCovered,
  encodeForJson,
  decodeFromJson,
};
