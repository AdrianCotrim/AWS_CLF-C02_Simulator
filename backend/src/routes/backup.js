'use strict';

const express = require('express');
const { exportBackup, validateBackupRequest, restoreBackupRequest } = require('../controllers/backupController');

const router = express.Router();

router.post('/create', exportBackup);
router.post('/validate', validateBackupRequest);
router.post('/restore', restoreBackupRequest);

module.exports = router;
