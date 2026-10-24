const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('nexis.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Database Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        balance REAL DEFAULT 0,
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        is_admin INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mining_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        start_time TEXT,
        ads_watched INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        content TEXT,
        created_at TEXT
    );
`);

// Helper to generate unique referral code
function generateRefCode() {
    return 'NX' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Register / Login Route with Referral Support
app.post('/api/user/register', (req, res) => {
    const { email, referredBy } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
        let refCode = generateRefCode();
        while (db.prepare('SELECT * FROM users WHERE referral_code = ?').get(refCode)) {
            refCode = generateRefCode();
        }

        const isAdmin = email === 'admin@nexis.com' ? 1 : 0;
        let startingBalance = 0;

        // If user registered via a referral link, reward the referrer (+10 NEXIS)
        if (referredBy && referredBy !== refCode) {
            const referrer = db.prepare('SELECT * FROM users WHERE referral_code = ?').get(referredBy);
            if (referrer) {
                db.prepare('UPDATE users SET balance = balance + 10 WHERE id = ?').run(referrer.id);
            }
        }

        const info = db.prepare(
            'INSERT INTO users (email, balance, referral_code, referred_by, is_admin) VALUES (?, ?, ?, ?, ?)'
        ).run(email, startingBalance, refCode, referredBy || null, isAdmin);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }

    const activeSession = db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active'").get(user.id);
    const stats = db.prepare("SELECT SUM(balance) as total_mined FROM users").get() || { total_mined: 0 };
    const announcements = db.prepare("SELECT * FROM announcements ORDER BY id DESC LIMIT 5").all();

    res.json({
        user,
        activeSession,
        currentRate: '2.0',
        stats: { total_mined: stats.total_mined || 61, max_supply: 10000000000 },
        announcements
    });
});

// Start Mining Session
app.post('/api/mine/start', (req, res) => {
    const { userId } = req.body;
    const active = db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active'").get(userId);
    if (active) return res.status(400).json({ error: 'Active session already exists' });

    const startTime = new Date().toISOString();
    db.prepare('INSERT INTO mining_sessions (user_id, start_time, ads_watched, status) VALUES (?, ?, 0, ?)')
      .run(userId, startTime, 'active');

    res.json({ message: 'Mining session started successfully' });
});

// Claim Tokens
app.post('/api/mine/claim', (req, res) => {
    const { userId } = req.body;
    const session = db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active'").get(userId);
    if (!session) return res.status(400).json({ error: 'No active session found' });

    const startTime = new Date(session.start_time).getTime();
    const now = Date.now();
    const hoursElapsed = (now - startTime) / (1000 * 60 * 60);

    if (hoursElapsed < 12) {
        return res.status(400).json({ error: '12-hour session is not yet complete.' });
    }

    const earned = 12 * 2.0;
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(earned, userId);
    db.prepare("UPDATE mining_sessions SET status = 'completed' WHERE id = ?").run(session.id);

    res.json({ message: `Successfully claimed ${earned} $NEXIS!` });
});

// Watch Ad Endpoint (Monetag Direct Link Rewards)
app.post('/api/mine/watch-ad', (req, res) => {
    const { userId } = req.body;
    const session = db.prepare("SELECT * FROM mining_sessions WHERE user_id = ? AND status = 'active'").get(userId);
    if (!session) return res.status(400).json({ error: 'Start an active mining session first to watch ads.' });

    if (session.ads_watched >= 2) {
        return res.status(400).json({ error: 'Maximum ads watched for this session (2/2).' });
    }

    const newAdsWatched = session.ads_watched + 1;
    db.prepare('UPDATE mining_sessions SET ads_watched = ? WHERE id = ?').run(newAdsWatched, session.id);
    db.prepare('UPDATE users SET balance = balance + 5 WHERE id = ?').run(userId);

    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    res.json({
        message: 'Ad watched successfully! +5 $NEXIS added.',
        newBalance: updatedUser.balance,
        adsWatched: newAdsWatched
    });
});

// Admin Announcement Route
app.post('/api/admin/announcement', (req, res) => {
    const { adminKey, title, content } = req.body;
    if (adminKey !== 'NEXIS_ADMIN_2026') return res.status(403).json({ error: 'Unauthorized' });

    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO announcements (title, content, created_at) VALUES (?, ?, ?)').run(title, content, createdAt);

    res.json({ message: 'Announcement posted successfully' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
      
