const express = require('express');
const path = require('path');
const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const pino = require('pino');

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
    if (debugLog.length > 100) debugLog.shift();
    console.log('[' + t + '] ' + msg);
}

function makeAuth(creds) {
    const c = creds || initAuthCreds();
    const k = {};
    return {
        state: { creds: c, keys: {
            get: (key) => k[key], set: (key, val) => { k[key] = val; },
            remove: (key) => { delete k[key]; }, clear: () => { for (const x in k) delete k[x]; },
        }},
        saveCreds: async () => {}
    };
}

function ser(c) { return JSON.stringify(c, BufferJSON.replacer); }
function deser(s) { return JSON.parse(s, BufferJSON.reviver); }

app.get('/ping', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString(), sessions: sessions.size });
});

app.get('/debug', (req, res) => {
    res.json({
        node: process.version,
        baileys: require('@whiskeysockets/baileys/package.json').version,
        platform: process.platform,
        env: Object.keys(process.env).filter(k => k.includes('PORT') || k.includes('RAILWAY') || k.includes('NODE')).reduce((o, k) => { o[k] = process.env[k].substring(0, 50); return o; }, {}),
        sessions: sessions.size,
        logs: debugLog
    });
});

app.post('/api/test-connect', async (req, res) => {
    log('=== TEST CONNECT START ===');
    try {
        log('Fetching Baileys version...');
        const { version } = await fetchLatestBaileysVersion();
        log('Baileys version: ' + JSON.stringify(version));

        const auth = makeAuth(null);
        log('Auth state created');

        log('Creating socket...');
        const sock = makeWASocket({
            version,
            auth: auth.state,
            printQRInTerminal: false,
            logger: pino({ level: 'debug', stream: { write: (m) => log('BAILEYS: ' + m) } }),
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 30000,
            keepAliveIntervalMs: 10000,
        });

        log('Socket created, waiting for events...');

        let responded = false;
        const finish = (data) => {
            if (!responded) {
                responded = true;
                log('=== TEST CONNECT END ===');
                try { sock.end(); } catch(e) {}
                res.json(data);
            }
        };

        let qrCount = 0;
        sock.ev.on('connection.update', (up) => {
            log('Event: ' + JSON.stringify({
                connection: up.connection,
                hasQR: !!up.qr,
                lastDisconnect: up.lastDisconnect?.error?.output?.statusCode || null
            }));

            if (up.qr) {
                qrCount++;
                log('QR received! Length: ' + up.qr.length);
                finish({ success: true, qr: up.qr, qrLength: up.qr.length });
            }

            if (up.connection === 'open') {
                log('Connection OPEN');
                finish({ success: true, status: 'open' });
            }

            if (up.connection === 'close') {
                const c = up.lastDisconnect?.error?.output?.statusCode;
                const msg = up.lastDisconnect?.error?.message || 'unknown';
                log('Connection CLOSED: code=' + c + ' msg=' + msg);
                finish({ success: false, code: c, message: msg });
            }
        });

        sock.ev.on('creds.update', () => { log('Creds update'); });

        setTimeout(() => {
            finish({ success: false, code: 'timeout', message: 'No QR or connection in 30s' });
        }, 30000);

    } catch (e) {
        log('FATAL: ' + e.message);
        log('Stack: ' + e.stack);
        res.status(500).json({ success: false, error: e.message, stack: e.stack });
    }
});

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method, creds } = req.body;
        const id = 's_' + (sid++);
        log('Link request: ' + id + ' method=' + method + ' phone=' + (phone || 'none'));

        const auth = makeAuth(creds ? deser(creds) : null);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version, auth: auth.state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 60000, keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 2000, maxMsgRetryCount: 5,
        });

        const sess = { id, phone: phone || '', sock, qr: null, code: null, status: 'connecting', creds: null, error: null, done: false };
        sessions.set(id, sess);

        sock.ev.on('creds.update', () => { sess.creds = ser(auth.state.creds); });

        let codeSent = false;
        sock.ev.on('connection.update', (up) => {
            const { connection, lastDisconnect, qr } = up;
            log(id + ' event: conn=' + connection + ' qr=' + !!qr);

            if (qr && !codeSent && !sess.done) {
                codeSent = true;
                sess.qr = qr;
                sess.status = 'waiting';
                log(id + ' QR received, length=' + qr.length);

                if (method === 'code' && phone) {
                    let clean = phone.replace(/\D/g, '');
                    if (clean.startsWith('0')) clean = clean.substring(1);
                    sock.requestPairingCode(clean).then(c => {
                        sess.code = c;
                        log(id + ' Code: ' + c);
                    }).catch(e => {
                        sess.status = 'error';
                        sess.error = 'Code failed: ' + e.message;
                        log(id + ' Code error: ' + e.message);
                    });
                }
            }

            if (connection === 'open') {
                sess.status = 'linked';
                sess.done = true;
                log(id + ' LINKED');
            }

            if (connection === 'close') {
                if (sess.done) return;
                sess.done = true;
                const c = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                log(id + ' CLOSED: code=' + c + ' msg=' + msg);
                if (c === DisconnectReason.loggedOut) { sess.status = 'error'; sess.error = 'Logged out'; }
                else if (c === 515 || c === 428 || c === 408) { sess.status = 'error'; sess.error = 'Connection dropped (' + c + '). Try QR or retry.'; }
                else { sess.status = 'error'; sess.error = 'Closed (' + c + ') ' + msg; }
            }
        });

        await new Promise(r => setTimeout(r, 3000));
        res.json({ id: sess.id, qr: sess.qr, code: sess.code, status: sess.status, creds: sess.creds, error: sess.error });
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
        const auth = makeAuth(null);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version, auth: auth.state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            shouldSyncHistoryMessage: () => false,
            connectTimeoutMs: 60000, keepAliveIntervalMs: 15000,
        });

        const sess = { id, phone: old.phone, sock, qr: null, code: null, status: 'connecting', creds: null, error: null, done: false };
        sessions.set(id, sess);

        sock.ev.on('creds.update', () => { sess.creds = ser(auth.state.creds); });
        sock.ev.on('connection.update', (up) => {
            const { connection, lastDisconnect, qr } = up;
            log(id + ' retry event: conn=' + connection + ' qr=' + !!qr);
            if (qr && !sess.qr && !sess.done) { sess.qr = qr; sess.status = 'waiting'; }
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
        res.json({ id: sess.id, qr: sess.qr, code: null, status: sess.status, error: sess.error });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check', (req, res) => {
    const s = sessions.get(req.body.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ id: s.id, status: s.status, phone: s.phone, code: s.code, creds: s.creds, error: s.error });
});

app.post('/api/ban', async (req, res) => {
    try {
        const s = sessions.get(req.body.id);
        if (!s) return res.status(404).json({ error: 'Not found' });
        if (s.status !== 'linked') return res.status(400).json({ error: 'Not linked' });
        let ok = 0, fail = 0;
        for (let i = 0; i < req.body.count; i++) {
            try {
                await s.sock.reportViolation(req.body.target, {
                    reportType: 'other',
                    reason: req.body.type === 'group' ? 'Inappropriate content' : 'Spam and scam'
                });
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
    if (s) { try { s.sock.end(); } catch (e) {} sessions.delete(req.params.id); }
    res.json({ ok: true });
});

app.listen(PORT, () => log('Server started on port ' + PORT));
