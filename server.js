const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const sessions = new Map();
const debugLog = [];

function log(msg) {
    const t = new Date().toISOString();
    debugLog.push({ time: t, msg });
    if (debugLog.length > 200) debugLog.shift();
    console.log('[' + t + '] ' + msg);
}

async function makeQRImage(data) {
    try { return await QRCode.toDataURL(data, { width: 250, margin: 1, color: { dark: '#ffffff', light: '#12121a' } }); }
    catch (e) { return null; }
}

function getNextId() {
    const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_s_'));
    let max = -1;
    for (const d of dirs) {
        const num = parseInt(d.replace('auth_s_', ''));
        if (!isNaN(num) && num > max) max = num;
    }
    return 's_' + (max + 1);
}

async function createSession(id, phone, method) {
    const dir = path.join(DATA_DIR, 'auth_' + id);
    fs.mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();
    log(id + ' Starting. Baileys ' + JSON.stringify(version));

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['VERTEX Panel', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        markOnlineOnConnect: false,
    });

    const sess = sessions.get(id);
    if (!sess) return;
    sess.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    if (method === 'code' && phone && !state.creds.registered) {
        const clean = String(phone).replace(/\D/g, '').replace(/^0+/, '');
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(clean);
                sess.code = code.match(/.{1,4}/g)?.join('-') || code;
                sess.status = 'waiting';
                log(id + ' Code: ' + sess.code);
            } catch (e) {
                sess.status = 'error';
                sess.error = 'Code failed: ' + e.message;
                log(id + ' ' + sess.error);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect, qr } = up;

        if (qr) {
            sess.qrImage = await makeQRImage(qr);
            if (sess.status !== 'waiting') sess.status = 'waiting';
            log(id + ' QR (len=' + qr.length + ' img=' + !!sess.qrImage + ')');
        }

        if (connection === 'open') {
            sess.status = 'linked';
            sess.error = null;
            log(id + ' OPEN as ' + (sock.user?.id || 'unknown'));
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || '';
            log(id + ' CLOSED code=' + code + ' msg=' + msg);

            if (code === DisconnectReason.loggedOut) {
                sess.status = 'error';
                sess.error = 'Logged out from phone';
                log(id + ' Wiping auth...');
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                sessions.delete(id);
            } else {
                sess.status = 'connecting';
                sess.error = null;
                log(id + ' Reconnect in 2.5s...');
                setTimeout(() => {
                    if (sessions.has(id) && sessions.get(id).status !== 'linked') {
                        createSession(id, phone, method).catch(e => log(id + ' Reconnect err: ' + e.message));
                    }
                }, 2500);
            }
        }
    });

    return sock;
}

// Return all sessions to frontend
app.get('/api/sessions', (req, res) => {
    const list = [];
    for (const [id, s] of sessions) {
        list.push({ id: s.id, phone: s.phone, status: s.status, code: s.code, qrImage: s.qrImage, error: s.error });
    }
    res.json(list);
});

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/debug', (req, res) => {
    const authDirs = [];
    try {
        const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_'));
        for (const d of dirs) {
            const credFile = path.join(DATA_DIR, d, 'creds.json');
            const info = { dir: d, hasCreds: false, registered: false };
            if (fs.existsSync(credFile)) {
                info.hasCreds = true;
                try { const c = JSON.parse(fs.readFileSync(credFile, 'utf8')); info.registered = c.registered; } catch (e) {}
            }
            authDirs.push(info);
        }
    } catch (e) {}
    res.json({ node: process.version, baileys: require('@whiskeysockets/baileys/package.json').version, platform: process.platform, sessions: sessions.size, authDirs, logs: debugLog.slice(-50) });
});

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method } = req.body || {};
        const id = getNextId();
        log('Link: ' + id + ' method=' + (method || 'qr') + ' phone=' + (phone || 'none'));

        const sess = { id, phone: phone || '', sock: null, qrImage: null, code: null, status: 'connecting', error: null };
        sessions.set(id, sess);

        await createSession(id, phone, method);
        await new Promise(r => setTimeout(r, method === 'code' ? 4500 : 3000));

        const s = sessions.get(id);
        res.json({ id: s.id, qrImage: s.qrImage, code: s.code, status: s.status, error: s.error });
    } catch (e) {
        log('Link error: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/check', (req, res) => {
    const s = sessions.get(req.body.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ id: s.id, status: s.status, phone: s.phone, code: s.code, qrImage: s.qrImage, error: s.error });
});

app.post('/api/ban', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s || s.status !== 'linked' || !s.sock) return res.status(400).json({ error: 'Not linked' });
        let ok = 0, fail = 0;
        for (let i = 0; i < req.body.count; i++) {
            try { await s.sock.reportViolation(req.body.target, { reportType: 'other', reason: req.body.type === 'group' ? 'Inappropriate content' : 'Spam and scam' }); ok++; }
            catch (e) { fail++; }
            await new Promise(r => setTimeout(r, 2500));
        }
        log('Ban: sent=' + ok + ' fail=' + fail);
        res.json({ sent: ok, failed: fail });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/group', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s || s.status !== 'linked' || !s.sock) return res.status(400).json({ error: 'Not linked' });
        const code = req.body.link.replace(/\/$/, '').split('/').pop();
        const info = await s.sock.groupGetInviteInfo(code);
        res.json({ id: info.id, name: info.subject, members: info.participants?.length || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/session/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (s) {
        try { s.sock?.end(); } catch (e) {}
        const dir = path.join(DATA_DIR, 'auth_' + req.params.id);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
        sessions.delete(req.params.id);
        log('Deleted session ' + req.params.id);
    }
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// STARTUP: auto-reconnect all existing sessions (same as working tool)
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    log('Server started on port ' + PORT);

    const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_s_'));
    if (dirs.length > 0) {
        log('Found ' + dirs.length + ' existing session(s), auto-reconnecting...');
        for (const d of dirs) {
            const id = d.replace('auth_', '');
            const credFile = path.join(DATA_DIR, d, 'creds.json');
            if (fs.existsSync(credFile)) {
                const sess = { id, phone: '', sock: null, qrImage: null, code: null, status: 'connecting', error: null };
                sessions.set(id, sess);
                createSession(id, null, 'qr').catch(e => log(id + ' auto-reconnect err: ' + e.message));
            }
        }
    }
});
