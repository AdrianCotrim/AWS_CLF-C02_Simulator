'use strict';

const express = require('express');
const cors = require('cors');
const questionsRouter = require('./routes/questions');
const userDataRouter = require('./routes/userData');
const historyRouter = require('./routes/history');
const backupRouter = require('./routes/backup');
const progressRouter = require('./routes/progress');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

app.get('/health', (req, res) => {
  res.status(200).json({
    service: 'aws-clf-c02-questions-api',
    ready: true
  });
});

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || localOrigin.test(origin));
  }
}));
app.use('/api/backup', express.json({ limit: '25mb' }), backupRouter);
app.use('/api/progress', express.json({ limit: '25mb' }), progressRouter);
app.use('/api/questions', express.json({ limit: '25mb' }), questionsRouter);
app.use(express.json({ limit: '32kb' }));
app.use('/api/user-data', userDataRouter);
app.use('/api/history', historyRouter);
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint não encontrado.' } });
});
app.use(errorHandler);

module.exports = app;