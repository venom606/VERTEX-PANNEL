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

const sessions = new Map();
let sid = 0;
const debugLog = [];

function log(msg) {
    const t = new Date().toISOString();
    debugLog.push({ time: t, msg });
    if (debugLog.length > 150) debugLog.shift();
    console.log('[' + t + '] ' + msg);
}

async function makeQRImage(data) {
    try {
        return await QRCode.toDataURL(data, { width: 250, margin: 1, color: { dark: '#ffffff', light: '#12121a' } });
    } catch (e) { log('QR image error: ' + e.message); return null; }
}

app.get('/ping', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString(), sessions: sessions.size });
});

app.get('/api/debug', (req, res) => {
    res.json({
        node: process.version,
        baileys: require('@whiskeysockets/baileys/package.json').version,
        platform: process.platform,
        sessions: sessions.size,
        logs: debugLog
    });
});

app.post('/api/test-connect', async (req, res) => {
    log('=== TEST CONNECT START ===');
    try {
        const { version } = await fetchLatestBaileysVersion();
        log('Baileys version: ' + JSON.stringify(version));

        const dir = path.join(__dirname, 'data', 'test_auth');
        fs.mkdirSync(dir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dir);

        log('Auth state created with useMultiFileAuthState');
        log('Keys store type: ' + typeof state.keys);

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome', 'Ubuntu', '20.0.0'],
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: false,
        });

        sock.ev.on('creds.update', saveCreds);
        log('Socket created with makeCacheableSignalKeyStore');

        let responded = false;
        const finish = (data) => {
            if (!responded) {
                responded = true;
                log('=== TEST CONNECT END ===');
                try { sock.end(); } catch(e) {}
                res.json(data);
            }
        };

        sock.ev.on('connection.update', async (up) => {
            log('Event: conn=' + up.connection + ' qr=' + !!up.qr);
            if (up.qr) {
                log('QR received! Length: ' + up.qr.length);
                const img = await makeQRImage(up.qr);
                finish({ success: true, qr: up.qr, qrImage: img });
            }
            if (up.connection === 'open') {
                log('OPEN! This means it works!');
                finish({ success: true, status: 'open' });
            }
            if (up.connection === 'close') {
                const c = up.lastDisconnect?.error?.output?.statusCode;
                const msg = up.lastDisconnect?.error?.message || '';
                log('CLOSED: code=' + c + ' msg=' + msg);
                finish({ success: false, code: c, message: msg });
            }
        });

        setTimeout(() => { finish({ success: false, code: 'timeout' }); }, 30000);
    } catch (e) {
        log('FATAL: ' + e.message + '\n' + e.stack);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method } = req.body;
        const id = 's_' + (sid++);
        log('Link request: ' + id + ' method=' + method + ' phone=' + (phone || 'none'));

        // Use REAL auth state with disk persistence
        const dir = path.join(__dirname, 'data', id);
        fs.mkdirSync(dir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        log(id + ' using useMultiFileAuthState + makeCacheableSignalKeyStore');

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome', 'Ubuntu', '20.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: false,
        });

        const sess = { id, phone: phone || '', sock, qrImage: null, code: null, status: 'connecting', error: null, done: false };
        sessions.set(id, sess);

        // REAL saveCreds — saves to disk properly
        sock.ev.on('creds.update', saveCreds);

        // Pairing code
        if (method === 'code' && phone && !state.creds.registered) {
            setTimeout(async () => {
                try {
                    const clean = String(phone).replace(/\D/g, '').replace(/^0+/, '');
                    const code = await sock.requestPairingCode(clean);
                    sess.code = code.match(/.{1,4}/g)?.join('-') || code;
                    sess.status = 'waiting';
                    log(id + ' Code: ' + sess.code);
                } catch (e) {
                    sess.status = 'error';
                    sess.error = 'Code failed: ' + e.message;
                    log(id + ' Code error: ' + e.message);
                }
            }, 3000);
        }

        sock.ev.on('connection.update', async (up) => {
            const { connection, lastDisconnect, qr } = up;
            log(id + ' event: conn=' + connection + ' qr=' + !!qr);

            if (qr && !sess.done) {
                sess.qrImage = await makeQRImage(qr);
                if (sess.status !== 'waiting') sess.status = 'waiting';
                log(id + ' QR image generated: ' + !!sess.qrImage);
            }

            if (connection === 'open') {
                sess.status = 'linked';
                sess.done = true;
                log(id + ' LINKED as ' + (sock.user?.id || 'unknown'));
            }

            if (connection === 'close') {
                if (sess.done) return;
                sess.done = true;
                const c = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                log(id + ' CLOSED: code=' + c + ' msg=' + msg);

                if (c === DisconnectReason.loggedOut) {
                    sess.status = 'error';
                    sess.error = 'Logged out';
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
                } else if (c === 515 || c === 428 || c === 408) {
                    sess.status = 'error';
                    sess.error = 'Connection dropped (' + c + '). Try QR or retry.';
                } else {
                    sess.status = 'error';
                    sess.error = 'Closed (' + c + ') ' + msg;
                }
            }
        });

        await new Promise(r => setTimeout(r, method === 'code' ? 4500 : 3000));
        res.json({ id: sess.id, qrImage: sess.qrImage, code: sess.code, status: sess.status, error: sess.error });
    } catch (e) {
        log('Link error: ' + e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/retry', async (req, res) => {
    try {
        const old = sessions.get(req.body.id);
        if (!old) return res.status(404).json({ error: 'Not found' });
        try { old.sock.end(); } catch (e) {}
        sessions.delete(req.body.id);

        const id = 's_' + (sid++);
        const dir = path.join(__dirname, 'data', id);
        fs.mkdirSync(dir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Chrome', 'Ubuntu', '20.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: false,
        });

        const sess = { id, phone: old.phone, sock, qrImage: null, code: null, status: 'connecting', error: null, done: false };
        sessions.set(id, sess);

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (up) => {
            const { connection, lastDisconnect, qr } = up;
            log(id + ' retry: conn=' + connection + ' qr=' + !!qr);
            if (qr && !sess.qrImage && !sess.done) {
                sess.qrImage = await makeQRImage(qr);
                sess.status = 'waiting';
            }
            if (connection === 'open') { sess.status = 'linked'; sess.done = true; }
            if (connection === 'close') {
                if (sess.done) return;
                sess.done = true;
                const c = lastDisconnect?.error?.output?.statusCode;
                sess.status = 'error';
                sess.error = c === DisconnectReason.loggedOut ? 'Logged out' : 'Closed (' + c + ')';
            }
        });

        await new Promise(r => setTimeout(r, 3000));
        res.json({ id: sess.id, qrImage: sess.qrImage, code: null, status: sess.status, error: sess.error });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check', (req, res) => {
    const s = sessions.get(req.body.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ id: s.id, status: s.status, phone: s.phone, code: s.code, qrImage: s.qrImage, error: s.error });
});

app.post('/api/ban', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s) return res.status(404).json({ error: 'Not found' });
        if (s.status !== 'linked') return res.status(400).json({ error: 'Not linked' });
        let ok = 0, fail = 0;
        for (let i = 0; i < req.body.count; i++) {
            try {
                await s.sock.reportViolation(req.body.target, { reportType: 'other', reason: req.body.type === 'group' ? 'Inappropriate content' : 'Spam and scam' });
                ok++;
            } catch (e) { fail++; }
            await new Promise(r => setTimeout(r, 2500));
        }
        res.json({ sent: ok, failed: fail });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/group', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s || s.status !== 'linked') return res.status(400).json({ error: 'Not linked' });
        const code = req.body.link.replace(/\/$/, '').split('/').pop();
        const info = await s.sock.groupGetInviteInfo(code);
        res.json({ id: info.id, name: info.subject, members: info.participants?.length || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/session/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (s) {
        try { s.sock.end(); } catch (e) {}
        sessions.delete(req.params.id);
    }
    res.json({ ok: true });
});

app.listen(PORT, () => log('Server started on port ' + PORT));
