'use strict';

const express = require('express');
const {
  getQuestions,
  getQuestion,
  createQuestion
} = require('../controllers/questionsController');

const router = express.Router();

router.get('/', getQuestions);
router.get('/:id', getQuestion);
router.post('/', createQuestion);

module.exports = router;