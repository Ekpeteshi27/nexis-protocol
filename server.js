const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// PostgreSQL connection pool using Render's environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Nexis Protocol API is live!', 
    tge_phase: 'Accumulation & Mining',
    version: '1.0.0' 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
