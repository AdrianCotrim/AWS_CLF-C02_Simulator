'use strict';

const express = require('express');
const {
  getQuestions,
  getQuestion,
  createQuestion,
  deleteQuestion,
  updateQuestion
} = require('../controllers/questionsController');

const router = express.Router();

router.get('/', getQuestions);
router.get('/:id', getQuestion);
router.post('/', createQuestion);
router.delete('/:id', deleteQuestion);
router.put('/:id', updateQuestion);

module.exports = router;