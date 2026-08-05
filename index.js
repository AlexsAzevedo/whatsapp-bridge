const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'industrialize2024!';

// URL do webhook para onde enviar mensagens recebidas
const WEBHOOK_URL = process.env.WEBHOOK_GLOBAL_URL || '';
const WEBHOOK_ENABLED = process.env.WEBHOOK_GLOBAL_ENABLED === 'true';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const auth = (req, res, next) => {
  const key = req.headers['apikey'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

let sock = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected';
let authDir = path.join('/tmp', 'auth_info');

if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

// ─── Helper: enviar payload ao webhook configurado ────────────────────────────
function sendToWebhook(payload) {
  if (!WEBHOOK_ENABLED || !WEBHOOK_URL) return;
  try {
    const body = JSON.stringify(payload);
    const url = new URL(WEBHOOK_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };
    const req = lib.request(options, (res) => {
      console.log(`[Webhook] Enviado → ${res.statusCode}`);
    });
    req.on('error', (err) => console.error('[Webhook] Erro:', err.message));
    req.write(body);
    req.end();
  } catch (err) {
    console.error('[Webhook] Falha ao enviar:', err.message);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Industrialize', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'connecting';
      qrCodeBase64 = await qrcode.toDataURL(qr);
      console.log('[WhatsApp] QR Code gerado');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      connectionStatus = 'disconnected';
      qrCodeBase64 = null;
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      qrCodeBase64 = null;
      console.log('[WhatsApp] Conectado com sucesso!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Listener de mensagens recebidas ─────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Ignorar mensagens enviadas pelo próprio número
      if (msg.key?.fromMe) continue;
      // Ignorar grupos
      if (msg.key?.remoteJid?.endsWith('@g.us')) continue;

      console.log('[WhatsApp] Mensagem recebida de:', msg.key?.remoteJid);

      // Enviar ao webhook no formato compatível com o nosso handler
      sendToWebhook({
        event: 'MESSAGES_UPSERT',
        data: {
          key: {
            remoteJid: msg.key?.remoteJid,
            fromMe: false,
            id: msg.key?.id,
          },
          pushName: msg.pushName || '',
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
        },
      });
    }
  });
}

app.get('/', (req, res) => {
  res.json({ status: 200, message: "WhatsApp Bridge - I'm Alive!", version: '1.0.0' });
});

app.get('/instance/status', auth, (req, res) => {
  const user = sock?.user;
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'open',
    user: user ? { id: user.id, name: user.name } : null,
  });
});

app.get('/instance/qrcode', auth, (req, res) => {
  if (connectionStatus === 'open') {
    return res.json({ connected: true, message: 'Já conectado' });
  }
  if (!qrCodeBase64) {
    return res.json({ connected: false, qr: null, message: 'Aguardando QR Code...' });
  }
  res.json({ connected: false, qr: qrCodeBase64 });
});

app.delete('/instance/logout', auth, async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    }
    connectionStatus = 'disconnected';
    qrCodeBase64 = null;
    setTimeout(connectToWhatsApp, 1000);
    res.json({ success: true, message: 'Desconectado com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/message/sendText', auth, async (req, res) => {
  if (connectionStatus !== 'open') {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  const { number, text } = req.body;
  if (!number || !text) return res.status(400).json({ error: 'number e text são obrigatórios' });

  try {
    const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text });
    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/message/sendMedia', auth, async (req, res) => {
  if (connectionStatus !== 'open') {
    return res.status(400).json({ error: 'WhatsApp não conectado' });
  }
  const { number, mediaUrl, caption, fileName, mediaType } = req.body;
  if (!number || !mediaUrl) return res.status(400).json({ error: 'number e mediaUrl são obrigatórios' });

  try {
    const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    const type = mediaType || 'document';
    let message;
    if (type === 'image') {
      message = { image: { url: mediaUrl }, caption: caption || '' };
    } else {
      message = {
        document: { url: mediaUrl },
        mimetype: 'application/pdf',
        fileName: fileName || 'documento.pdf',
        caption: caption || '',
      };
    }
    const result = await sock.sendMessage(jid, message);
    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] WhatsApp Bridge rodando na porta ${PORT}`);
  console.log(`[Webhook] Global enabled: ${WEBHOOK_ENABLED}, URL: ${WEBHOOK_URL || '(não configurado)'}`);
  connectToWhatsApp();
});
