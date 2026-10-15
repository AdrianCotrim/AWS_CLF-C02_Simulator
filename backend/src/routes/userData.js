'use strict';

const express = require('express');
const {
  getUserData,
  saveUserData,
  addToErrorBank,
  removeFromErrorBank,
  setPreferences
} = require('../controllers/userDataController');

const router = express.Router();

router.get('/', getUserData);
router.put('/', saveUserData);
router.post('/error-bank', addToErrorBank);
router.delete('/error-bank/:id', removeFromErrorBank);
router.patch('/preferences', setPreferences);

module.exports = router;
