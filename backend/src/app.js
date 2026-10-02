'use strict';

const express = require('express');
const cors = require('cors');
const questionsRouter = require('./routes/questions');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || localOrigin.test(origin));
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api/questions', questionsRouter);
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint não encontrado.' } });
});
app.use(errorHandler);

module.exports = app;