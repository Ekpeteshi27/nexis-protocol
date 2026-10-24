const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// Database Setup with Announcements & Admin Support
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS protocol_stats (
        id SERIAL PRIMARY KEY,
        total_mined NUMERIC(20, 8) DEFAULT 0,
        total_users INT DEFAULT 0,
        current_reward_rate NUMERIC(10, 4) DEFAULT 2.0000,
        max_supply NUMERIC(20, 8) DEFAULT 10000000000
      );
      
      INSERT INTO protocol_stats (id, total_mined, total_users, current_reward_rate, max_supply)
      SELECT 1, 0, 0, 2.0000, 10000000000
      WHERE NOT EXISTS (SELECT 1 FROM protocol_stats WHERE id = 1);

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        balance NUMERIC(20, 8) DEFAULT 0,
        email VARCHAR(255) UNIQUE NOT NULL,
        referral_code VARCHAR(50) UNIQUE,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS mining_sessions (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reward_rate NUMERIC(10, 4) NOT NULL,
        ads_watched INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);
    console.log('Database initialized with Admin & Announcements feed.');
  } catch (err) {
    console.error('DB Init Error:', err);
  }
}

initDb();

// Halving Rate Logic (10 Billion Cap)
async function getOrUpdateRewardRate() {
  const statsRes = await pool.query('SELECT total_mined FROM protocol_stats WHERE id = 1');
  const totalMined = parseFloat(statsRes.rows[0].total_mined);

  let currentRate = 2.0;

  if (totalMined >= 5000000000) currentRate = 0.25;
  else if (totalMined >= 2500000000) currentRate = 0.5;
  else if (totalMined >= 1000000000) currentRate = 1.0;

  await pool.query('UPDATE protocol_stats SET current_reward_rate = $1 WHERE id = 1', [currentRate]);
  return currentRate;
}

// User Register / Login
app.post('/api/user/register', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    let userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;
    if (userRes.rows.length === 0) {
      const generatedRef = 'NEXIS-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const insertRes = await pool.query(
        'INSERT INTO users (email, referral_code) VALUES ($1, $2) RETURNING *',
        [email, generatedRef]
      );
      user = insertRes.rows[0];
      await pool.query('UPDATE protocol_stats SET total_users = total_users + 1 WHERE id = 1');
    } else {
      user = userRes.rows[0];
    }

    const currentRate = await getOrUpdateRewardRate();
    
    // Fetch latest active session
    const sessionRes = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE ORDER BY start_time DESC LIMIT 1',
      [user.id]
    );

    let activeSession = null;
    if (sessionRes.rows.length > 0) {
      const sess = sessionRes.rows[0];
      const elapsedHours = (new Date() - new Date(sess.start_time)) / (1000 * 60 * 60);
      if (elapsedHours >= 12) {
        await pool.query('UPDATE mining_sessions SET is_active = FALSE WHERE id = $1', [sess.id]);
      } else {
        activeSession = sess;
      }
    }

    const statsRes = await pool.query('SELECT * FROM protocol_stats WHERE id = 1');
    const announcements = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');

    res.json({ user, currentRate, activeSession, stats: statsRes.rows[0], announcements: announcements.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start 12-Hour Session
app.post('/api/mine/start', async (req, res) => {
  const { userId } = req.body;
  try {
    const activeSession = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    if (activeSession.rows.length > 0) {
      return res.status(400).json({ message: 'Mining session already active!' });
    }

    const currentRate = await getOrUpdateRewardRate();
    const newSession = await pool.query(
      'INSERT INTO mining_sessions (user_id, reward_rate) VALUES ($1, $2) RETURNING *',
      [userId, currentRate]
    );

    res.json({ message: '12-Hour mining session started!', session: newSession.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Watch Ad Bonus
app.post('/api/mine/watch-ad', async (req, res) => {
  const { userId } = req.body;
  try {
    const sessionRes = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    if (sessionRes.rows.length === 0) {
      return res.status(400).json({ error: 'Start a mining session first to watch bonus ads!' });
    }

    const session = sessionRes.rows[0];
    if (session.ads_watched >= 2) {
      return res.status(400).json({ error: 'Maximum 2 bonus ads reached for this session.' });
    }

    const bonusAmount = 5.0000;
    const newAdCount = session.ads_watched + 1;

    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [bonusAmount, userId]);
    await pool.query('UPDATE protocol_stats SET total_mined = total_mined + $1 WHERE id = 1', [bonusAmount]);
    await pool.query('UPDATE mining_sessions SET ads_watched = $1 WHERE id = $2', [newAdCount, session.id]);

    const userRes = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);

    res.json({
      message: `Bonus +${bonusAmount} $NEXIS awarded!`,
      adsWatched: newAdCount,
      newBalance: userRes.rows[0].balance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim Rewards
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
      await pool.query('UPDATE mining_sessions SET is_active = FALSE WHERE id = $1', [session.id]);
    } else {
      await pool.query('UPDATE mining_sessions SET last_claimed_at = CURRENT_TIMESTAMP WHERE id = $1', [session.id]);
    }

    const statsRes = await pool.query('SELECT * FROM protocol_stats WHERE id = 1');
    const userRes = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);

    res.json({
      message: sessionEnded ? '12-Hour Session Completed! Restart to continue.' : 'Tokens claimed!',
      claimed: earnedTokens.toFixed(4),
      newBalance: userRes.rows[0].balance,
      sessionEnded,
      stats: statsRes.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API: Post Announcement
app.post('/api/admin/announcement', async (req, res) => {
  const { adminKey, title, content } = req.body;
  
  // Simple Admin Secret Passkey
  if (adminKey !== 'NEXIS_ADMIN_2026') {
    return res.status(403).json({ error: 'Unauthorized: Invalid Admin Secret Passkey' });
  }

  try {
    const newAnn = await pool.query(
      'INSERT INTO announcements (title, content) VALUES ($1, $2) RETURNING *',
      [title, content]
    );
    res.json({ message: 'Announcement published successfully!', announcement: newAnn.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN API: Fetch All Registered Users
app.post('/api/admin/users', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== 'NEXIS_ADMIN_2026') return res.status(403).json({ error: 'Unauthorized' });

  try {
    const usersRes = await pool.query('SELECT id, email, balance, created_at FROM users ORDER BY id DESC LIMIT 50');
    res.json(usersRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexis Protocol running on port ${PORT}`));
                                   
