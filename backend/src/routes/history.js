'use strict';

const express = require('express');
const { getHistory, addAttempt, updateAttempt } = require('../controllers/historyController');

const router = express.Router();

router.get('/', getHistory);
router.post('/', addAttempt);
router.put('/:id', updateAttempt);

module.exports = router;
