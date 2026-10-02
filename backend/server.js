'use strict';

const app = require('./src/app');

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Questions API listening at http://localhost:${port}`);
});