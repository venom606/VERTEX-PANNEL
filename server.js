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

app.post('/api/link', async (req, res) => {
    try {
        const { phone, method, creds } = req.body;
        const id = 's_' + (sid++);
        const auth = makeAuth(creds ? deser(creds) : null);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version, auth: auth.state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            shouldSyncHistoryMessage: () => false,
        });

        const sess = { id, phone: phone || '', sock, qr: null, code: null, status: 'connecting', creds: null, error: null };
        sessions.set(id, sess);

        sock.ev.on('creds.update', () => { sess.creds = ser(auth.state.creds); });

        let codeSent = false;
        sock.ev.on('connection.update', (up) => {
            if (up.qr && !codeSent) {
                codeSent = true;
                sess.qr = up.qr;
                sess.status = 'waiting';
                if (method === 'code' && phone) {
                    let clean = phone.replace(/\D/g, '');
                    if (clean.startsWith('0')) clean = clean.substring(1);
                    sock.requestPairingCode(clean).then(c => { sess.code = c; }).catch(e => { sess.status = 'error'; sess.error = e.message; });
                }
            }
            if (up.connection === 'open') sess.status = 'linked';
            if (up.connection === 'close') {
                const c = up.lastDisconnect?.error?.output?.statusCode;
                sess.status = 'error';
                sess.error = c === DisconnectReason.loggedOut ? 'Logged out' : 'Closed (' + c + ')';
            }
        });

        await new Promise(r => setTimeout(r, 2500));
        res.json({ id: sess.id, qr: sess.qr, code: sess.code, status: sess.status, creds: sess.creds });
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
    if (s) { try { s.sock.end(); } catch(e) {} sessions.delete(req.params.id); }
    res.json({ ok: true });
});

app.listen(PORT, () => console.log('Panel: http://localhost:' + PORT));
