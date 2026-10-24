const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Calculate reward rate based on total supply mined
async function getOrUpdateRewardRate() {
  const statsRes = await pool.query('SELECT total_mined FROM protocol_stats WHERE id = 1');
  const totalMined = parseFloat(statsRes.rows[0].total_mined);

  let currentRate = 2.0; // Base rate: 2 $NEXIS / hr

  if (totalMined >= 20000000) {
    currentRate = 0.25; 
  } else if (totalMined >= 5000000) {
    currentRate = 0.5;  
  } else if (totalMined >= 1000000) {
    currentRate = 1.0;  
  }

  await pool.query('UPDATE protocol_stats SET current_reward_rate = $1 WHERE id = 1', [currentRate]);
  return currentRate;
}

// 1. User Register / Login
app.post('/api/user/register', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });

  try {
    let userRes = await pool.query('SELECT * FROM users WHERE wallet_address = $1', [walletAddress]);
    if (userRes.rows.length === 0) {
      userRes = await pool.query(
        'INSERT INTO users (wallet_address) VALUES ($1) RETURNING *',
        [walletAddress]
      );
      await pool.query('UPDATE protocol_stats SET total_users = total_users + 1 WHERE id = 1');
    }
    const currentRate = await getOrUpdateRewardRate();
    res.json({ user: userRes.rows[0], currentRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Start Mining Session
app.post('/api/mine/start', async (req, res) => {
  const { userId } = req.body;
  try {
    const activeSession = await pool.query(
      'SELECT * FROM mining_sessions WHERE user_id = $1 AND is_active = TRUE',
      [userId]
    );

    if (activeSession.rows.length > 0) {
      return res.status(400).json({ message: 'Mining session already active' });
    }

    const currentRate = await getOrUpdateRewardRate();
    const newSession = await pool.query(
      'INSERT INTO mining_sessions (user_id, reward_rate) VALUES ($1, $2) RETURNING *',
      [userId, currentRate]
    );

    res.json({ message: 'Mining started', session: newSession.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Claim Mined Tokens
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
    const hoursElapsed = (now - new Date(session.last_claimed_at)) / (1000 * 60 * 60);
    const earnedTokens = hoursElapsed * parseFloat(session.reward_rate);

    if (earnedTokens <= 0) {
      return res.json({ message: 'Nothing to claim yet', claimed: 0 });
    }

    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [earnedTokens, userId]);
    await pool.query('UPDATE protocol_stats SET total_mined = total_mined + $1 WHERE id = 1', [earnedTokens]);
    await pool.query('UPDATE mining_sessions SET last_claimed_at = CURRENT_TIMESTAMP WHERE id = $1', [session.id]);

    const nextRate = await getOrUpdateRewardRate();
    res.json({ message: 'Tokens claimed', claimed: earnedTokens.toFixed(4), nextRewardRate: nextRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexis Protocol running on port ${PORT}`));
              
