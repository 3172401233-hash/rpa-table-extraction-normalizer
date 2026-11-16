'use strict';

const {
  TableNormalizer,
} = require('./normalizer');
const { normalizeSnapshot } = require('./snapshot');
const { resolveHeaderPaths } = require('./header');
const { materialize, cellAt, coveredRange } = require('./grid');
const {
  createCheckpoint,
  stringifyCheckpoint,
  restoreCheckpoint,
} = require('./checkpoint');
const { intervalsFromSet, gapIntervals } = require('./ranges');
const markers = require('./markers');

module.exports = {
  TableNormalizer,
  normalizeSnapshot,
  resolveHeaderPaths,
  materialize,
  cellAt,
  coveredRange,
  createCheckpoint,
  stringifyCheckpoint,
  restoreCheckpoint,
  intervalsFromSet,
  gapIntervals,
  ...markers,
};
