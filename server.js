const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS protocol_stats (
        id SERIAL PRIMARY KEY,
        total_mined NUMERIC(20, 8) DEFAULT 0,
        total_users INT DEFAULT 0,
        current_reward_rate NUMERIC(10, 4) DEFAULT 2.0000
      );
      
      INSERT INTO protocol_stats (id, total_mined, total_users, current_reward_rate)
      SELECT 1, 0, 0, 2.0000 
      WHERE NOT EXISTS (SELECT 1 FROM protocol_stats WHERE id = 1);

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        balance NUMERIC(20, 8) DEFAULT 0,
        email VARCHAR(255) UNIQUE,
        referral_code VARCHAR(50) UNIQUE,
        referred_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mining_sessions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reward_rate NUMERIC(10, 4) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    console.log('Database initialized with 12h sessions and referrals.');
  } catch (err) {
    console.error('DB Init Error:', err);
  }
}

initDb();

async function getOrUpdateRewardRate() {
  const statsRes = await pool.query('SELECT total_mined FROM protocol_stats WHERE id = 1');
  const totalMined = parseFloat(statsRes.rows[0].total_mined);
  let currentRate = 2.0;
  if (totalMined >= 20000000) currentRate = 0.25;
  else if (totalMined >= 5000000) currentRate = 0.5;
  else if (totalMined >= 1000000) currentRate = 1.0;

  await pool.query('UPDATE protocol_stats SET current_reward_rate = $1 WHERE id = 1', [currentRate]);
  return currentRate;
}

// Register / Login with Referral Support
app.post('/api/user/register', async (req, res) => {
  const { email, refCode } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    let userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;
    if (userRes.rows.length === 0) {
      const generatedRef = 'NEXIS-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      let referrerId = null;
      if (refCode) {
        const refRes = await pool.query('SELECT id FROM users WHERE referral_code = $1', [refCode]);
        if (refRes.rows.length > 0) referrerId = refRes.rows[0].id;
      }

      const insertRes = await pool.query(
        'INSERT INTO users (email, referral_code, referred_by) VALUES ($1, $2, $3) RETURNING *',
        [email, generatedRef, referrerId]
      );
      user = insertRes.rows[0];
      await pool.query('UPDATE protocol_stats SET total_users = total_users + 1 WHERE id = 1');
    } else {
      user = userRes.rows[0];
    }

    const currentRate = await getOrUpdateRewardRate();
    
    // Check active session status
    const sessionRes = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE ORDER BY start_time DESC LIMIT 1',
      [user.id]
    );

    let activeSession = null;
    if (sessionRes.rows.length > 0) {
      const sess = sessionRes.rows[0];
      const now = new Date();
      const elapsedHours = (now - new Date(sess.start_time)) / (1000 * 60 * 60);
      if (elapsedHours >= 12) {
        await pool.query('UPDATE mining_sessions SET is_active = FALSE WHERE id = $1', [sess.id]);
      } else {
        activeSession = sess;
      }
    }

    const statsRes = await pool.query('SELECT * FROM protocol_stats WHERE id = 1');
    res.json({ user, currentRate, activeSession, stats: statsRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start 12-Hour Mining Session
app.post('/api/mine/start', async (req, res) => {
  const { userId } = req.body;
  try {
    await pool.query(
      `UPDATE mining_sessions SET is_active = FALSE WHERE user_id = $1 AND is_active = TRUE AND (NOW() - start_time) > INTERVAL '12 hours'`,
      [userId]
    );

    const activeSession = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    if (activeSession.rows.length > 0) {
      return res.status(400).json({ message: 'Mining session already active! Wait for it to complete.' });
    }

    let baseRate = await getOrUpdateRewardRate();
    const userRes = await pool.query('SELECT referred_by FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length > 0 && userRes.rows[0].referred_by) {
      baseRate = parseFloat(baseRate) * 1.10; // +10% boost for referred users
    }

    const newSession = await pool.query(
      'INSERT INTO mining_sessions (user_id, reward_rate) VALUES ($1, $2) RETURNING *',
      [userId, baseRate]
    );

    res.json({ message: '12-Hour mining session started!', session: newSession.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim Rewards & Handle 12-Hour Expiration
app.post('/api/mine/claim', async (req, res) => {
  const { userId } = req.body;
  try {
    const sessionRes = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'No active mining session found' });
    }

    const session = sessionRes.rows[0];
    const now = new Date();
    const startTime = new Date(session.start_time);
    const lastClaimed = new Date(session.last_claimed_at);

    let hoursElapsed = (now - lastClaimed) / (1000 * 60 * 60);
    const totalSessionHours = (now - startTime) / (1000 * 60 * 60);

    let sessionEnded = false;
    if (totalSessionHours >= 12) {
      const remainingAllowedHours = 12 - ((lastClaimed - startTime) / (1000 * 60 * 60));
      hoursElapsed = remainingAllowedHours > 0 ? Math.min(hoursElapsed, remainingAllowedHours) : 0;
      sessionEnded = true;
    }

    const earnedTokens = hoursElapsed * parseFloat(session.reward_rate);

    if (earnedTokens > 0) {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [earnedTokens, userId]);
      await pool.query('UPDATE protocol_stats SET total_mined = total_mined + $1 WHERE id = 1', [earnedTokens]);
    }

    if (sessionEnded) {
      await pool.query('UPDATE mining_sessions SET is_active = FALSE, last_claimed_at = CURRENT_TIMESTAMP WHERE id = $1', [session.id]);
    } else {
      await pool.query('UPDATE mining_sessions SET last_claimed_at = CURRENT_TIMESTAMP WHERE id = $1', [session.id]);
    }

    const nextRate = await getOrUpdateRewardRate();
    const statsRes = await pool.query('SELECT * FROM protocol_stats WHERE id = 1');
    const userRes = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);

    res.json({
      message: sessionEnded ? 'Session completed! Tap Start Mining for a new 12h cycle.' : 'Rewards claimed successfully!',
      claimed: earnedTokens.toFixed(4),
      newBalance: userRes.rows[0].balance,
      sessionEnded,
      nextRewardRate: nextRate,
      stats: statsRes.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global Stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query('SELECT * FROM protocol_stats WHERE id = 1');
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const topUsers = await pool.query('SELECT email, balance FROM users ORDER BY balance DESC LIMIT 5');
    res.json(topUsers.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexis Protocol running on port ${PORT}`));
