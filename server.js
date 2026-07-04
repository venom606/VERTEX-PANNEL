const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket, fetchLatestBaileysVersion, DisconnectReason,
  useMultiFileAuthState, makeCacheableSignalKeyStore,
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
    for (const d of dirs) { const n = parseInt(d.replace('auth_s_', '')); if (!isNaN(n) && n > max) max = n; }
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
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['VERTEX Panel', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000, keepAliveIntervalMs: 15000, markOnlineOnConnect: false,
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
            } catch (e) { sess.status = 'error'; sess.error = 'Code failed: ' + e.message; log(id + ' ' + sess.error); }
        }, 3000);
    }

    sock.ev.on('connection.update', async (up) => {
        const { connection, lastDisconnect, qr } = up;
        if (qr) {
            sess.qrImage = await makeQRImage(qr);
            if (sess.status !== 'waiting') sess.status = 'waiting';
            log(id + ' QR (len=' + qr.length + ' img=' + !!sess.qrImage + ')');
        }
        if (connection === 'open') { sess.status = 'linked'; sess.error = null; log(id + ' OPEN as ' + (sock.user?.id || 'unknown')); }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || '';
            log(id + ' CLOSED code=' + code + ' msg=' + msg);
            if (code === DisconnectReason.loggedOut) {
                sess.status = 'error'; sess.error = 'Logged out from phone';
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                sessions.delete(id);
            } else {
                sess.status = 'connecting'; sess.error = null;
                log(id + ' Reconnect in 2.5s...');
                setTimeout(() => {
                    if (reportsRunning[id]) return;
                    if (sessions.has(id) && sessions.get(id).status !== 'linked') {
                        createSession(id, phone, method).catch(e => log(id + ' Reconnect err: ' + e.message));
                    }
                }, 2500);
            }
        }
    });
    return sock;
}

// Track which bans are currently running (don't reconnect during active ban)
const reportsRunning = {};

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/sessions', (req, res) => {
    const list = [];
    for (const [id, s] of sessions) {
        list.push({ id: s.id, phone: s.phone, status: s.status, code: s.code, qrImage: s.qrImage, error: s.error });
    }
    res.json(list);
});

app.get('/api/debug', (req, res) => {
    const authDirs = [];
    try {
        for (const d of fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_'))) {
            const cf = path.join(DATA_DIR, d, 'creds.json');
            const info = { dir: d, hasCreds: false, registered: false };
            if (fs.existsSync(cf)) { info.hasCreds = true; try { info.registered = JSON.parse(fs.readFileSync(cf, 'utf8')).registered; } catch (e) {} }
            authDirs.push(info);
        }
    } catch (e) {}
    res.json({ node: process.version, baileys: require('@whiskeysockets/bailes/package.json').version, platform: process.platform, sessions: sessions.size, authDirs, logs: debugLog.slice(-50) });
});

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method } = req.body || {};
        const id = getNextId();
        log('Link: ' + id + ' method=' + (method || 'qr') + ' phone=' + (phone || 'none'));
        const sess = { id, phone: phone || '', sock: null, qrImage: null, code: null, status: 'connecting', error: null, reports: null, banStatus: null, banMessageStatus: null };
        sessions.set(id, sess);
        await createSession(id, phone, method);
        await new Promise(r => setTimeout(r, method === 'code' ? 4500 : 3000));
        const s = sessions.get(id);
        res.json({ id: s.id, qrImage: s.qrImage, code: s.code, status: s.status, error: s.error });
    } catch (e) { log('Link error: ' + e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/check', (req, res) => {
    const s = sessions.get(req.body.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({
        id: s.id, status: s.status, phone: s.phone, code: s.code, qrImage: s.qrImage, error: s.error,
        reports: s.reports, banStatus: s.banStatus, banMessageStatus: s.banMessageStatus
    });
});

app.post('/api/ban', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s || s.status !== 'linked' || !s.sock) return res.status(400).json({ error: 'Not linked' });
        const target = req.body.target;
        const type = req.body.type;
        const count = req.body.count;

        reportsRunning[id] = true;
        res.json({ started: true, id: s.id });

        // Small delay so frontend sets up polling first
        await new Promise(r => setTimeout(r, 1500));

        s.reports = [];
        s.banStatus = 'sending';
        s.banMessageStatus = null;

        for (let i = 0; i < count; i++) {
            try {
                await s.sock.reportViolation(target, { reportType: 'other', reason: type === 'group' ? 'Inappropriate content' : 'Spam and scam' });
                s.reports.push({ i, status: 'sent' });
            } catch (e) {
                s.reports.push({ i, status: 'failed', error: e.message });
            }
            await new Promise(r => setTimeout(r, 2500));
        }

        const sent = s.reports.filter(r => r.status === 'sent').length;
        const failed = s.reports.filter(r => r.status === 'failed').length;

        try {
            const ownerJid = s.sock.user?.id;
            const targetNum = target.replace('@s.whatsapp.net', '').replace('@g.us', '');
            await s.sock.sendMessage(ownerJid, {
                text: 'VERTEX REPORT LOG\n\nTarget: ' + targetNum + '\nSent: ' + sent + '/' + count + '\nFailed: ' + failed + '\nStatus: Done\n- VERTEX'
            });
            s.banMessageStatus = 'sent';
            log(id + ' Message sent to ' + ownerJid);
        } catch (e) {
            s.banMessageStatus = 'failed: ' + e.message;
            log(id + ' Message failed: ' + e.message);
        }

        s.banStatus = 'complete';
        reportsRunning[id] = false;
        log(id + ' Done: sent=' + sent + ' fail=' + failed);
    } catch (e) {
        const s = sessions.get(req.body.id);
        if (s) { s.banStatus = 'error'; reportsRunning[req.body.id] = false; }
        log('Ban error: ' + e.message);
    }
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
        try { fs.rmSync(path.join(DATA_DIR, 'auth_' + req.params.id), { recursive: true, force: true }); } catch (e) {}
        sessions.delete(req.params.id);
        log('Deleted ' + req.params.id);
    }
    res.json({ ok: true });
});

app.listen(PORT, () => {
    log('Server started on port ' + PORT);
    const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_s_'));
    if (dirs.length > 0) {
        log('Found ' + dirs.length + ' session(s), auto-reconnecting...');
        for (const d of dirs) {
            const id = d.replace('auth_', '');
            if (fs.existsSync(path.join(DATA_DIR, d, 'creds.json'))) {
                sessions.set(id, { id, phone: '', sock: null, qrImage: null, code: null, status: 'connecting', error: null, reports: null, banStatus: null, banMessageStatus: null });
                createSession(id, null, 'qr').catch(e => log(id + ' auto err: ' + e.message));
            }
        }
    }
});
