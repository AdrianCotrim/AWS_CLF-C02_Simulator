'use strict';

const express = require('express');
const {
  getQuestions,
  getQuestion,
  getCatalogStatus,
  getQuestionMetadata,
  createQuestion,
  deleteQuestion,
  deleteAllQuestions,
  updateQuestion,
  restoreDefaultQuestion,
  acknowledgeCatalogUpdate,
  importQuestions
} = require('../controllers/questionsController');

const router = express.Router();

router.post('/import', importQuestions);
router.get('/catalog-status', getCatalogStatus);
router.post('/catalog-status/acknowledge', acknowledgeCatalogUpdate);
router.delete('/', deleteAllQuestions);
router.get('/', getQuestions);
router.get('/:id/metadata', getQuestionMetadata);
router.post('/:id/restore-default', restoreDefaultQuestion);
router.get('/:id', getQuestion);
router.post('/', createQuestion);
router.delete('/:id', deleteQuestion);
router.put('/:id', updateQuestion);

module.exports = router;