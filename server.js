const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const nodemailer = require('nodemailer');
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

const DB_FILE = path.join(DATA_DIR, 'db.json');
const sessions = new Map();
const debugLog = [];
const reportsRunning = {};

// ========================
// DEFAULT BAN PROMPTS (10 MAXIMUM POWER — with {number} placeholder)
// ========================
const DEFAULT_PROMPTS = [
  "URGENT: The account +{number} is actively distributing child sexual abuse material (CSAM), child pornography, and explicit content involving minors under 18. Immediate law enforcement referral and account termination required.",
  "CRITICAL REPORT: The number +{number} is sharing illegal pornographic material including underage content, revenge porn, and non-consensual intimate images. Account engaged in sexual exploitation of minors and unauthorized distribution of private media.",
  "BAN REQUEST: The account +{number} is a mass spam bot sending unsolicited adult content, phishing links, and malicious URLs to hundreds of users. Automated distribution of explicit pornography and fraudulent content across multiple WhatsApp groups.",
  "SEVERE VIOLATION: The number +{number} is illegally selling and charging for pornographic content, promoting prostitution, and distributing explicit material for profit. Human trafficking indicators detected through payment solicitations.",
  "HARASSMENT REPORT: The account +{number} is sending threatening messages, explicit media without consent, and sexually harassing content to multiple victims. Stalking behavior and non-consensual sharing of intimate images confirmed.",
  "MINOR SAFETY ALERT: The number +{number} is impersonating minors to solicit inappropriate content from underage users. Predatory behavior targeting children through fake profiles and grooming tactics. Immediate ban and investigation required.",
  "SPAM & ABUSE: The account +{number} is a bot network distributing pornographic content, malicious links, and scam offers across WhatsApp groups. Coordinated inauthentic behavior with automated explicit content flooding.",
  "REVENGE PORN: The number +{number} is systematically sharing non-consensual intimate images and videos of victims without permission. Doxxing and sexual harassment campaign targeting specific individuals for blackmail.",
  "TERRORISM & EXPLOITATION: The account +{number} is promoting illegal adult services, human trafficking recruitment, and sexual exploitation through WhatsApp Business. Financial transactions linked to criminal prostitution network.",
  "MULTI-VIOLATION: The number +{number} is involved in CSAM distribution + child grooming + revenge porn + spam bot + phishing + harassment. This account violates every major WhatsApp policy simultaneously. Permanent ban and data preservation for authorities."
];

// ========================
// WHATSAPP SUPPORT EMAILS (pre-loaded)
// ========================
const DEFAULT_WHATSAPP_EMAILS = [
  { id: 'wem_1', email: 'support@whatsapp.com', label: 'Main Support', active: true },
  { id: 'wem_2', email: 'abuse@whatsapp.com', label: 'Abuse Team', active: true },
  { id: 'wem_3', email: 'legal@whatsapp.com', label: 'Legal Team', active: true },
  { id: 'wem_4', email: 'security@whatsapp.com', label: 'Security', active: true },
  { id: 'wem_5', email: 'safety@whatsapp.com', label: 'Safety Team', active: true },
  { id: 'wem_6', email: 'lawenforcement@whatsapp.com', label: 'Law Enforcement', active: true },
  { id: 'wem_7', email: 'report@support.whatsapp.com', label: 'Report Support', active: true }
];

// ========================
// DATABASE / PERSISTENCE
// ========================
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) { log('DB load error: ' + e.message); }
  return { emails: [], numberLinks: [], whatsappEmails: DEFAULT_WHATSAPP_EMAILS, prompts: DEFAULT_PROMPTS, settings: {} };
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) { log('DB save error: ' + e.message); }
}

let db = loadDB();
if (!db.emails) db.emails = [];
if (!db.numberLinks) db.numberLinks = [];
if (!db.whatsappEmails || !db.whatsappEmails.length) db.whatsappEmails = DEFAULT_WHATSAPP_EMAILS;
if (!db.prompts || !db.prompts.length) db.prompts = DEFAULT_PROMPTS;
if (!db.settings) db.settings = {};

function log(msg) {
  const t = new Date().toISOString();
  debugLog.push({ time: t, msg });
  if (debugLog.length > 500) debugLog.shift();
  console.log('[' + t + '] ' + msg);
}

async function makeQRImage(data) {
  try {
    return await QRCode.toDataURL(data, { width: 250, margin: 1, color: { dark: '#ffffff', light: '#12121a' } });
  } catch (e) { return null; }
}

function getNextId() {
  const dirs = fs.readdirSync(DATA_DIR).filter(d => d.startsWith('auth_s_'));
  let max = -1;
  for (const d of dirs) {
    const n = parseInt(d.replace('auth_s_', ''));
    if (!isNaN(n) && n > max) max = n;
  }
  return 's_' + (max + 1);
}

function generateEmailId() { return 'em_' + Date.now() + '_' + Math.floor(Math.random() * 10000); }
function getEmailById(id) { return db.emails.find(e => e.id === id); }
function getEmailByAddress(address) { return db.emails.find(e => e.email.toLowerCase() === address.toLowerCase()); }

// ========================
// SMTP / EMAIL SENDING
// ========================
function getSMTPConfig(email) {
  const domain = email.split('@')[1].toLowerCase();
  if (domain.includes('yahoo')) return { host: 'smtp.mail.yahoo.com', port: 465, secure: true };
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) return { host: 'smtp-mail.outlook.com', port: 587, secure: false };
  if (domain.includes('icloud') || domain.includes('me.com')) return { host: 'smtp.mail.me.com', port: 587, secure: false };
  if (domain.includes('yandex')) return { host: 'smtp.yandex.com', port: 465, secure: true };
  if (domain.includes('zoho')) return { host: 'smtp.zoho.com', port: 587, secure: false };
  return { host: 'smtp.gmail.com', port: 465, secure: true };
}

async function sendEmailViaSMTP(fromEmail, fromPassword, toAddress, subject, htmlBody, textBody) {
  return new Promise(async (resolve) => {
    try {
      const cfg = getSMTPConfig(fromEmail);
      const transporter = nodemailer.createTransporter({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        auth: { user: fromEmail, pass: fromPassword },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000
      });

      const info = await transporter.sendMail({
        from: '"VERTEX Abuse Report" <' + fromEmail + '>',
        to: toAddress,
        subject: subject,
        text: textBody,
        html: htmlBody
      });

      transporter.close();
      resolve({ to: toAddress, ok: true, id: info.messageId });
    } catch (e) {
      resolve({ to: toAddress, ok: false, error: e.message });
    }
  });
}

function buildEmailBodies(targetNumber, promptText, fromEmail) {
  const now = new Date().toISOString();
  const subject = 'WhatsApp Abuse Report — +' + targetNumber;

  const textBody = [
    'WHATSAPP ABUSE REPORT',
    '=====================',
    '',
    'Reported Number: +' + targetNumber,
    'Report Content: ' + promptText,
    'Reporter Email: ' + fromEmail,
    'Timestamp: ' + now,
    '',
    'This is an automated abuse report submitted through the VERTEX reporting system.',
    'Please review and take immediate action against the reported WhatsApp account.',
    '',
    '— VERTEX Abuse Reporting System'
  ].join('\n');

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>WhatsApp Abuse Report</title></head>
<body style="background:#0a0a0a;color:#e5e5e5;font-family:Arial,sans-serif;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:#12121a;border:1px solid #252530;border-radius:12px;padding:24px;">
  <h2 style="color:#ef4444;margin-top:0;">WHATSAPP ABUSE REPORT</h2>
  <p style="color:#9ca3af;font-size:12px;">Submitted via VERTEX Panel</p>
  <hr style="border-color:#252530;margin:16px 0;">
  <table style="width:100%;color:#e5e5e5;font-size:14px;">
    <tr><td style="color:#9ca3af;padding:6px 0;width:140px;">Reported Number</td><td style="font-weight:bold;color:#f59e0b;">+${targetNumber}</td></tr>
    <tr><td style="color:#9ca3af;padding:6px 0;">Reporter</td><td>${fromEmail}</td></tr>
    <tr><td style="color:#9ca3af;padding:6px 0;">Timestamp</td><td>${now}</td></tr>
  </table>
  <hr style="border-color:#252530;margin:16px 0;">
  <h3 style="color:#f59e0b;font-size:13px;">REPORT CONTENT:</h3>
  <div style="background:#1a1a25;border:1px solid #252530;border-radius:8px;padding:12px;font-size:13px;line-height:1.6;color:#e5e5e5;">${escapeHtml(promptText)}</div>
  <hr style="border-color:#252530;margin:16px 0;">
  <p style="color:#9ca3af;font-size:12px;">This is an automated abuse report. Please review and take immediate action.</p>
  <p style="color:#6b7280;font-size:11px;">— VERTEX Abuse Reporting System</p>
</div></body></html>`;

  return { subject, textBody, htmlBody };
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ========================
// SESSION / BAILEYS
// ========================
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

// ========================
// ROUTES
// ========================

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id: s.id, phone: s.phone, status: s.status, code: s.code, qrImage: s.qrImage, error: s.error, reports: s.reports, banStatus: s.banStatus, banMessageStatus: s.banMessageStatus });
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
    platform: process.platform,
    sessions: sessions.size,
    emails: db.emails.length,
    numberLinks: db.numberLinks.length,
    whatsappEmails: db.whatsappEmails.filter(e => e.active).length + '/' + db.whatsappEmails.length,
    prompts: db.prompts.length,
    authDirs,
    logs: debugLog.slice(-50)
  });
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
  } catch (e) {
    log('Link error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/check', (req, res) => {
  const s = sessions.get(req.body.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ id: s.id, status: s.status, phone: s.phone, code: s.code, qrImage: s.qrImage, error: s.error, reports: s.reports, banStatus: s.banStatus, banMessageStatus: s.banMessageStatus });
});

// ---- MATRIX BAN: Every Email x Every Prompt x Every WA Address ----
app.post('/api/ban', async (req, res) => {
  const banId = req.body.id;
  try {
    const s = sessions.get(banId);
    if (!s) return res.status(400).json({ error: 'Session not found' });
    if (s.status !== 'linked' || !s.sock) return res.status(400).json({ error: 'Not linked' });

    const target = req.body.target;
    const type = req.body.type;
    const count = req.body.count || 5;
    const targetNumber = req.body.targetNumber || '';

    reportsRunning[banId] = true;
    res.json({ started: true, id: s.id });

    await new Promise(r => setTimeout(r, 1500));

    log(banId + ' Starting MATRIX BAN to ' + target + ' | targetNumber=' + targetNumber);
    s.reports = [];
    s.banStatus = 'sending';
    s.banMessageStatus = null;

    // ---- 1. Send WhatsApp report nodes (original behavior) ----
    for (let i = 0; i < count; i++) {
      s.reports.push({ i: i + 1, status: 'sending' });
      try {
        const reportType = type === 'group' ? 'inappropriate' : 'spam';
        await s.sock.sendNode({
          tag: 'iq',
          attrs: { to: 's.whatsapp.net', type: 'set', id: 'report-' + banId + '-' + Date.now() + '-' + i },
          content: [{ tag: 'report', attrs: { xmlns: 'urn:xmpp:whatsapp:report', jid: target, type: reportType } }]
        });
        await new Promise(r => setTimeout(r, 800));
        s.reports[i].status = 'sent';
        log(banId + ' [' + (i + 1) + '/' + count + '] Node SENT');
      } catch (e) {
        s.reports[i].status = 'failed';
        s.reports[i].error = e.message || 'Unknown';
        log(banId + ' [' + (i + 1) + '/' + count + '] Node FAIL: ' + (e.message || 'Unknown'));
      }
      if (i < count - 1) {
        const delay = 2500 + Math.floor(Math.random() * 2500);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const sent = s.reports.filter(r => r.status === 'sent').length;
    const failed = s.reports.filter(r => r.status !== 'sent').length;
    log(banId + ' Nodes done. Sent=' + sent + ' Failed=' + failed);

    // ---- 2. MATRIX EMAIL SENDING ----
    // For EACH user email: for EACH prompt: send to ALL active WA support emails
    const activeUserEmails = db.emails.filter(e => e.status === 'active');
    const activeWaEmails = db.whatsappEmails.filter(we => we.active).map(we => we.email);
    const allPrompts = db.prompts;
    let emailResults = [];

    if (activeUserEmails.length > 0 && activeWaEmails.length > 0 && allPrompts.length > 0 && targetNumber) {
      log(banId + ' Starting MATRIX EMAIL: ' + activeUserEmails.length + ' emails x ' + allPrompts.length + ' prompts x ' + activeWaEmails.length + ' addresses = ' + (activeUserEmails.length * allPrompts.length * activeWaEmails.length) + ' total emails');

      for (const userEmail of activeUserEmails) {
        if (!userEmail.appPassword) {
          log('Skip email ' + userEmail.email + ': no app password');
          continue;
        }
        for (const promptTemplate of allPrompts) {
          const promptText = promptTemplate.replace(/\{number\}/g, targetNumber);
          const { subject, textBody, htmlBody } = buildEmailBodies(targetNumber, promptText, userEmail.email);

          for (const waEmail of activeWaEmails) {
            const result = await sendEmailViaSMTP(userEmail.email, userEmail.appPassword, waEmail, subject, htmlBody, textBody);
            emailResults.push({ from: userEmail.email, to: waEmail, prompt: promptText.substring(0, 40), ...result });
            if (result.ok) {
              log('Email SENT: ' + userEmail.email + ' -> ' + waEmail + ' | prompt: ' + promptText.substring(0, 30) + '...');
            } else {
              log('Email FAIL: ' + userEmail.email + ' -> ' + waEmail + ' | ' + result.error);
            }
            // Small delay between emails to avoid rate limits
            await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 1000)));
          }
        }
      }

      log(banId + ' Matrix email complete. Total: ' + emailResults.length + ' | OK: ' + emailResults.filter(r => r.ok).length + ' | FAIL: ' + emailResults.filter(r => !r.ok).length);
    } else {
      log(banId + ' Skipping matrix email: emails=' + activeUserEmails.length + ' wa=' + activeWaEmails.length + ' prompts=' + allPrompts.length + ' number=' + targetNumber);
    }

    // ---- 3. WHATSAPP SUMMARY MESSAGE ----
    s.banMessageStatus = 'sending';
    try {
      const ownerJid = s.sock.user?.id;
      if (ownerJid) {
        const targetNum = target.replace('@s.whatsapp.net', '').replace('@g.us', '');
        const rate = count > 0 ? Math.round((sent / count) * 100) : 0;
        const emailOk = emailResults.filter(r => r.ok).length;
        const emailTotal = emailResults.length;
        const lines = [
          '┏━━━━━━━━━━━━━━━━━━━┓',
          '┃  VERTEX REPORT LOG  ┃',
          '┗━━━━━━━━━━━━━━━━━━━┛',
          '',
          'Target: ' + targetNum,
          'Type: ' + (type === 'group' ? 'Group Ban' : 'Number Ban'),
          'Nodes: ' + sent + '/' + count + ' (' + rate + '%)',
          '',
          'MATRIX EMAIL REPORTS:',
          'Total Emails Sent: ' + emailOk + '/' + emailTotal,
          'User Emails Used: ' + activeUserEmails.length,
          'Prompts Used: ' + allPrompts.length,
          'WA Addresses: ' + activeWaEmails.length,
          'Time: ' + new Date().toISOString(),
          '',
          '- VERTEX v4.8.3'
        ];
        await s.sock.sendMessage(ownerJid, { text: lines.join('\n') });
        s.banMessageStatus = 'sent';
        log(banId + ' Summary SENT to ' + ownerJid);
      } else {
        s.banMessageStatus = 'failed';
      }
    } catch (e) {
      s.banMessageStatus = 'failed';
      log(banId + ' Summary FAILED: ' + e.message);
    }

    s.banStatus = 'complete';
    reportsRunning[banId] = false;
    log(banId + ' Ban complete');
  } catch (e) {
    const s = sessions.get(banId);
    if (s) { s.banStatus = 'error'; s.banMessageStatus = 'failed'; }
    reportsRunning[banId] = false;
    log('Ban error [' + banId + ']: ' + e.message);
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

// ---- EMAIL MANAGEMENT (UNLIMITED) ----
app.get('/api/emails', (req, res) => { res.json(db.emails); });

app.post('/api/emails', (req, res) => {
  try {
    const { email, appPassword, notes } = req.body || {};
    if (!email || !appPassword) return res.status(400).json({ error: 'Email and appPassword required' });
    if (getEmailByAddress(email)) return res.status(400).json({ error: 'Email already exists' });

    const newEmail = {
      id: generateEmailId(),
      email: email.trim(),
      appPassword: appPassword.trim(),
      notes: notes || '',
      linkedNumbers: [],
      status: 'active',
      createdAt: new Date().toISOString()
    };
    db.emails.push(newEmail);
    saveDB();
    log('Email added: ' + email);
    res.json(newEmail);
  } catch (e) {
    log('Email add error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/emails/:id', (req, res) => {
  try {
    const email = getEmailById(req.params.id);
    if (!email) return res.status(404).json({ error: 'Email not found' });
    const { appPassword, notes, status } = req.body || {};
    if (appPassword !== undefined) email.appPassword = appPassword.trim();
    if (notes !== undefined) email.notes = notes;
    if (status !== undefined && ['active', 'inactive'].includes(status)) email.status = status;
    saveDB();
    log('Email updated: ' + email.email);
    res.json(email);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/emails/:id', (req, res) => {
  try {
    const idx = db.emails.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Email not found' });
    const email = db.emails[idx];
    db.numberLinks = db.numberLinks.filter(n => n.emailId !== email.id);
    db.emails.splice(idx, 1);
    saveDB();
    log('Email deleted: ' + email.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- NUMBER LINKING ----
app.get('/api/numbers', (req, res) => { res.json(db.numberLinks); });

app.post('/api/numbers', (req, res) => {
  try {
    const { number, emailId, label } = req.body || {};
    if (!number || !emailId) return res.status(400).json({ error: 'Number and emailId required' });
    const email = getEmailById(emailId);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const clean = String(number).replace(/\D/g, '').replace(/^0+/, '');
    if (!clean) return res.status(400).json({ error: 'Invalid number' });

    db.numberLinks = db.numberLinks.filter(n => n.number !== clean);

    const link = {
      id: 'nl_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
      number: clean,
      emailId: email.id,
      email: email.email,
      label: label || '',
      status: 'linked',
      createdAt: new Date().toISOString()
    };
    db.numberLinks.push(link);
    email.linkedNumbers = db.numberLinks.filter(n => n.emailId === email.id).map(n => n.number);
    saveDB();
    log('Number linked: ' + clean + ' -> ' + email.email);
    res.json(link);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/numbers/:id', (req, res) => {
  try {
    const idx = db.numberLinks.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Number link not found' });
    const link = db.numberLinks[idx];
    db.numberLinks.splice(idx, 1);
    const email = getEmailById(link.emailId);
    if (email) {
      email.linkedNumbers = db.numberLinks.filter(n => n.emailId === email.id).map(n => n.number);
    }
    saveDB();
    log('Number unlinked: ' + link.number);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- WHATSAPP SUPPORT EMAILS ----
app.get('/api/whatsapp-emails', (req, res) => { res.json(db.whatsappEmails); });

app.post('/api/whatsapp-emails', (req, res) => {
  try {
    const { email, label } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const newEntry = {
      id: 'wem_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
      email: email.trim(),
      label: label || 'Custom',
      active: true,
      createdAt: new Date().toISOString()
    };
    db.whatsappEmails.push(newEntry);
    saveDB();
    log('WhatsApp email added: ' + email);
    res.json(newEntry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/whatsapp-emails/:id', (req, res) => {
  try {
    const entry = db.whatsappEmails.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const { active, label } = req.body || {};
    if (active !== undefined) entry.active = !!active;
    if (label !== undefined) entry.label = label;
    saveDB();
    log('WhatsApp email updated: ' + entry.email + ' active=' + entry.active);
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/whatsapp-emails/:id', (req, res) => {
  try {
    const idx = db.whatsappEmails.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const entry = db.whatsappEmails[idx];
    db.whatsappEmails.splice(idx, 1);
    saveDB();
    log('WhatsApp email deleted: ' + entry.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- PROMPTS (UNLIMITED) ----
app.get('/api/prompts', (req, res) => {
  res.json({ prompts: db.prompts });
});

app.post('/api/prompts', (req, res) => {
  try {
    const { prompts } = req.body || {};
    if (Array.isArray(prompts)) {
      db.prompts = prompts.map(p => String(p).trim()).filter(p => p.length > 0);
      saveDB();
      log('Prompts updated: ' + db.prompts.length + ' prompts');
    }
    res.json({ prompts: db.prompts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prompts/reset', (req, res) => {
  db.prompts = DEFAULT_PROMPTS;
  saveDB();
  log('Prompts reset to defaults');
  res.json({ prompts: db.prompts });
});

// ---- SETTINGS ----
app.get('/api/settings', (req, res) => { res.json(db.settings); });
app.post('/api/settings', (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  saveDB();
  res.json(db.settings);
});

// ========================
// SHUTDOWN
// ========================
process.on('SIGTERM', () => {
  log('SIGTERM, closing...');
  saveDB();
  for (const [id, s] of sessions) { reportsRunning[id] = false; try { s.sock?.end(); } catch (e) {} }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT, closing...');
  saveDB();
  for (const [id, s] of sessions) { reportsRunning[id] = false; try { s.sock?.end(); } catch (e) {} }
  process.exit(0);
});

// ========================
// STARTUP
// ========================
app.listen(PORT, () => {
  log('Server started on port ' + PORT);
  log('DB loaded: ' + db.emails.length + ' emails, ' + db.numberLinks.length + ' links, ' + db.whatsappEmails.length + ' WA emails, ' + db.prompts.length + ' prompts');

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
