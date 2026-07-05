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
const reportsRunning = {};

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

function isSockAlive(sess) {
    return sess && sess.sock && sess.sock.user && sess.status === 'linked';
}

async function sendReport(sock, targetJid, reason, retries) {
    retries = retries || 1;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await Promise.race([
                sock.query({
                    tag: 'iq',
                    attrs: { to: targetJid, type: 'set', xmlns: 'com.whatsapp' },
                    content: [{ tag: 'report', attrs: { type: reason || 'other' } }]
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('IQ timeout')), 12000))
            ]);
            return result;
        } catch (e) {
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw e;
            }
        }
    }
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
            log(id + ' QR generated');
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
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                sessions.delete(id);
            } else {
                sess.status = 'connecting';
                sess.error = null;
                const waitTime = code === 409 ? 8000 : 3000;
                log(id + ' Reconnect in ' + (waitTime / 1000) + 's...');
                setTimeout(() => {
                    if (reportsRunning[id]) return;
                    if (sessions.has(id) && sessions.get(id).status !== 'linked') {
                        createSession(id, phone, method).catch(e => log(id + ' Reconnect err: ' + e.message));
                    }
                }, waitTime);
            }
        }
    });
    return sock;
}

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/sessions', (req, res) => {
    const list = [];
    for (const [id, s] of sessions) {
        list.push({
            id: s.id, phone: s.phone, status: s.status, code: s.code,
            qrImage: s.qrImage, error: s.error,
            reports: s.reports, banStatus: s.banStatus,
            banMessageStatus: s.banMessageStatus
        });
    }
    res.json(list);
});

app.get('/api/debug', (req, res) => {
    const authDirs = [];
    try {
        for (const d of fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_'))) {
            const cf = path.join(DATA_DIR, d, 'creds.json');
            const info = { dir: d, hasCreds: false, registered: false };
            if (fs.existsSync(cf)) {
                info.hasCreds = true;
                try { info.registered = JSON.parse(fs.readFileSync(cf, 'utf8')).registered; } catch (e) {}
            }
            authDirs.push(info);
        }
    } catch (e) {}
    res.json({
        node: process.version,
        baileys: require('@whiskeysockets/baileys/package.json').version,
        platform: process.platform, sessions: sessions.size,
        authDirs, logs: debugLog.slice(-50)
    });
});

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method } = req.body || {};
        const id = getNextId();
        log('Link: ' + id + ' method=' + (method || 'qr') + ' phone=' + (phone || 'none'));
        const sess = {
            id, phone: phone || '', sock: null, qrImage: null, code: null,
            status: 'connecting', error: null, reports: null,
            banStatus: null, banMessageStatus: null
        };
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
        id: s.id, status: s.status, phone: s.phone, code: s.code,
        qrImage: s.qrImage, error: s.error,
        reports: s.reports, banStatus: s.banStatus,
        banMessageStatus: s.banMessageStatus
    });
});

app.post('/api/ban', async (req, res) => {
    const sid = req.body.id;
    try {
        const s = sessions.get(sid);
        if (!s) return res.status(400).json({ error: 'Session not found' });
        if (s.status !== 'linked') return res.status(400).json({ error: 'Not linked yet' });

        const target = req.body.target;
        const type = req.body.type;
        const count = req.body.count;

        reportsRunning[sid] = true;
        res.json({ started: true, id: s.id });

        await new Promise(r => setTimeout(r, 1500));

        log(sid + ' Starting ' + count + ' reports to ' + target);
        s.reports = [];
        s.banStatus = 'sending';
        s.banMessageStatus = null;

        for (let i = 0; i < count; i++) {
            s.reports.push({ i: i + 1, status: 'sending' });

            try {
                await sendReport(s.sock, target, type === 'group' ? 'inappropriate' : 'spam', 1);
                s.reports[i].status = 'sent';
                log(sid + ' [' + (i + 1) + '/' + count + '] SENT');
            } catch (e) {
                s.reports[i].status = 'failed';
                s.reports[i].error = e.message;
                log(sid + ' [' + (i + 1) + '/' + count + '] FAIL: ' + e.message);
            }

            if (i < count - 1) {
                const delay = 2000 + Math.floor(Math.random() * 2000);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        const sent = s.reports.filter(r => r.status === 'sent').length;
        const failed = s.reports.filter(r => r.status !== 'sent').length;

        s.banMessageStatus = 'sending';
        log(sid + ' Done. Sent=' + sent + ' Failed=' + failed);

        try {
            const ownerJid = s.sock.user?.id;
            if (ownerJid) {
                const targetNum = target.replace('@s.whatsapp.net', '').replace('@g.us', '');
                const rate = count > 0 ? Math.round((sent / count) * 100) : 0;
                const lines = [
                    '┏━━━━━━━━━━━━━━━━━━━┓',
                    '┃  VERTEX REPORT LOG  ┃',
                    '┗━━━━━━━━━━━━━━━━━━━┛',
                    '',
                    'Target: ' + targetNum,
                    'Type: ' + (type === 'group' ? 'Group Ban' : 'Number Ban'),
                    'Total: ' + count,
                    'Sent: ' + sent,
                    'Failed: ' + failed,
                    'Rate: ' + rate + '%',
                    'Time: ' + new Date().toISOString(),
                    '',
                    '- VERTEX v4.8.1'
                ];
                await s.sock.sendMessage(ownerJid, { text: lines.join('\n') });
                s.banMessageStatus = 'sent';
                log(sid + ' Summary SENT to ' + ownerJid);
            } else {
                s.banMessageStatus = 'failed';
                log(sid + ' Summary failed: no ownerJid');
            }
        } catch (e) {
            s.banMessageStatus = 'failed';
            log(sid + ' Summary FAILED: ' + e.message);
        }

        s.banStatus = 'complete';
        reportsRunning[sid] = false;
        log(sid + ' Ban complete');
    } catch (e) {
        const s = sessions.get(sid);
        if (s) {
            s.banStatus = 'error';
            s.banMessageStatus = 'failed';
            reportsRunning[sid] = false;
        }
        log('Ban error [' + sid + ']: ' + e.message);
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
    const rid = req.params.id;
    const s = sessions.get(rid);
    if (s) {
        reportsRunning[rid] = false;
        try { s.sock?.end(); } catch (e) {}
        try { fs.rmSync(path.join(DATA_DIR, 'auth_' + rid), { recursive: true, force: true }); } catch (e) {}
        delete reportsRunning[rid];
        sessions.delete(rid);
        log('Deleted ' + rid);
    }
    res.json({ ok: true });
});

process.on('SIGTERM', () => {
    log('SIGTERM, closing...');
    for (const [id, s] of sessions) { reportsRunning[id] = false; try { s.sock?.end(); } catch (e) {} }
    process.exit(0);
});

process.on('SIGINT', () => {
    log('SIGINT, closing...');
    for (const [id, s] of sessions) { reportsRunning[id] = false; try { s.sock?.end(); } catch (e) {} }
    process.exit(0);
});

app.listen(PORT, () => {
    log('Server started on port ' + PORT);
    const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_s_'));
    if (dirs.length > 0) {
        log('Found ' + dirs.length + ' session(s), auto-reconnecting...');
        for (const d of dirs) {
            const id = d.replace('auth_', '');
            if (fs.existsSync(path.join(DATA_DIR, d, 'creds.json'))) {
                sessions.set(id, {
                    id, phone: '', sock: null, qrImage: null, code: null,
                    status: 'connecting', error: null, reports: null,
                    banStatus: null, banMessageStatus: null
                });
                createSession(id, null, 'qr').catch(e => log(id + ' auto err: ' + e.message));
            }
        }
    }
});
