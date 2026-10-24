const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

// Initialize or load database file
function readDB() {
    if (!fs.existsSync(DATA_FILE)) {
        const initialData = {
            users: [],
            mining_sessions: [],
            announcements: []
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return { users: [], mining_sessions: [], announcements: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateRefCode() {
    return 'NX' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Register / Login Route with Referral Support
app.post('/api/user/register', (req, res) => {
    const { email, referredBy } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const db = readDB();
    let user = db.users.find(u => u.email === email);

    if (!user) {
        let refCode = generateRefCode();
        while (db.users.some(u => u.referral_code === refCode)) {
            refCode = generateRefCode();
        }

        const isAdmin = email === 'admin@nexis.com' ? 1 : 0;

        if (referredBy && referredBy !== refCode) {
            const referrer = db.users.find(u => u.referral_code === referredBy);
            if (referrer) {
                referrer.balance += 10;
            }
        }

        user = {
            id: db.users.length + 1,
            email,
            balance: 0,
            referral_code: refCode,
            referred_by: referredBy || null,
            is_admin: isAdmin
        };
        db.users.push(user);
        writeDB(db);
    }

    const activeSession = db.mining_sessions.find(s => s.user_id === user.id && s.status === 'active');
    const total_mined = db.users.reduce((sum, u) => sum + u.balance, 0) + 61;
    const announcements = db.announcements ? [...db.announcements].reverse().slice(0, 5) : [];

    res.json({
        user,
        activeSession,
        currentRate: '2.0',
        stats: { total_mined, max_supply: 10000000000 },
        announcements
    });
});

// Start Mining Session
app.post('/api/mine/start', (req, res) => {
    const { userId } = req.body;
    const db = readDB();
    const active = db.mining_sessions.find(s => s.user_id === userId && s.status === 'active');
    if (active) return res.status(400).json({ error: 'Active session already exists' });

    const session = {
        id: db.mining_sessions.length + 1,
        user_id: userId,
        start_time: new Date().toISOString(),
        ads_watched: 0,
        status: 'active'
    };
    db.mining_sessions.push(session);
    writeDB(db);

    res.json({ message: 'Mining session started successfully' });
});

// Claim Tokens
app.post('/api/mine/claim', (req, res) => {
    const { userId } = req.body;
    const db = readDB();
    const session = db.mining_sessions.find(s => s.user_id === userId && s.status === 'active');
    if (!session) return res.status(400).json({ error: 'No active session found' });

    const startTime = new Date(session.start_time).getTime();
    const hoursElapsed = (Date.now() - startTime) / (1000 * 60 * 60);

    if (hoursElapsed < 12) {
        return res.status(400).json({ error: '12-hour session is not yet complete.' });
    }

    const earned = 12 * 2.0;
    const user = db.users.find(u => u.id === userId);
    if (user) user.balance += earned;
    session.status = 'completed';
    writeDB(db);

    res.json({ message: `Successfully claimed ${earned} $NEXIS!` });
});

// Watch Ad Endpoint (Monetag Direct Link Rewards)
app.post('/api/mine/watch-ad', (req, res) => {
    const { userId } = req.body;
    const db = readDB();
    const session = db.mining_sessions.find(s => s.user_id === userId && s.status === 'active');
    if (!session) return res.status(400).json({ error: 'Start an active mining session first to watch ads.' });

    if (session.ads_watched >= 2) {
        return res.status(400).json({ error: 'Maximum ads watched for this session (2/2).' });
    }

    session.ads_watched += 1;
    const user = db.users.find(u => u.id === userId);
    if (user) user.balance += 5;
    writeDB(db);

    res.json({
        message: 'Ad watched successfully! +5 $NEXIS added.',
        newBalance: user ? user.balance : 0,
        adsWatched: session.ads_watched
    });
});

// Admin Announcement Route
app.post('/api/admin/announcement', (req, res) => {
    const { adminKey, title, content } = req.body;
    if (adminKey !== 'NEXIS_ADMIN_2026') return res.status(403).json({ error: 'Unauthorized' });

    const db = readDB();
    db.announcements.push({
        id: db.announcements.length + 1,
        title,
        content,
        created_at: new Date().toISOString()
    });
    writeDB(db);

    res.json({ message: 'Announcement posted successfully' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
