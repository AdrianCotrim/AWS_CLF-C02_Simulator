'use strict';

const express = require('express');
const {
  getProgress,
  updateProgress,
  previewMigration,
  migrateProgress,
  importProgress
} = require('../controllers/progressController');

const router = express.Router();

router.get('/', getProgress);
router.put('/', updateProgress);
router.post('/migration/preview', previewMigration);
router.post('/migration', migrateProgress);
router.post('/import', importProgress);

module.exports = router;
