const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const config = require('./config/env');
const routes = require('./routes');
const { sequelize } = require('./models');
const { runSeeds } = require('./utils/seed');

const allowedOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://psiloup.com.br',
  'https://www.psiloup.com.br',
];

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api', routes);

const STATIC_DIR = path.join(__dirname, '../public_html');
if (fs.existsSync(STATIC_DIR) && config.env !== 'production') {
  app.use(express.static(STATIC_DIR));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

async function start() {
  await sequelize.sync({ alter: true });
  await runSeeds();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Servidor iniciado em http://localhost:${config.port}`);
  });
}

module.exports = {
  app,
  start,
};

