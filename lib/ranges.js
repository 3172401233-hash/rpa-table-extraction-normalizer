'use strict';

// 已加载全局行号集合 -> 连续区间列表。
function intervalsFromSet(set) {
  const sorted = [...set].sort((a, b) => a - b);
  const intervals = [];
  for (const value of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && value === last.end + 1) {
      last.end = value;
    } else {
      intervals.push({ start: value, end: value });
    }
  }
  return intervals;
}

// 在 [0, totalRows) 内求未加载区间，即 gap。
function gapIntervals(loaded, totalRows) {
  const loadedSet = loaded instanceof Set ? loaded : new Set(loaded);
  const gaps = [];
  let gapStart = null;
  let inGap = false;
  for (let index = 0; index < totalRows; index += 1) {
    if (loadedSet.has(index)) {
      if (inGap) {
        gaps.push({ start: gapStart, end: index - 1 });
        inGap = false;
      }
    } else if (!inGap) {
      gapStart = index;
      inGap = true;
    }
  }
  if (inGap) {
    gaps.push({ start: gapStart, end: totalRows - 1 });
  }
  return gaps.filter((gap) => gap.start <= gap.end);
}

module.exports = {
  intervalsFromSet,
  gapIntervals,
};
