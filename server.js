require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;

// Daraja Config from .env
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const SHORTCODE = process.env.SHORTCODE || '9528434';
const TILL_NUMBER = process.env.TILL_NUMBER || '3056305';
const PASSKEY = process.env.PASSKEY;
const CALLBACK_URL = process.env.CALLBACK_URL;

// ========== ADMIN GAME CONTROL ==========
let gameOpen = false; // Game starts CLOSED - Admin must OPEN
let gameStarted = false;
let paidPlayers = []; // Every successful payment = 1 entry, even same phone
let pendingSTK = {}; // phone -> timestamp of last STK, to stop duplicate STK bug

app.get('/game-state', (req, res) => {
  res.json({ gameOpen, gameStarted, playersCount: paidPlayers.length, paidPlayers });
});

app.post('/admin/open', (req, res) => {
  gameOpen = true;
  gameStarted = false;
  console.log('GAME OPENED by Admin - Payments ALLOWED');
  res.json({ success: true, gameOpen, gameStarted });
});

app.post('/admin/close', (req, res) => {
  gameOpen = false;
  console.log('GAME CLOSED by Admin - Payments BLOCKED');
  res.json({ success: true, gameOpen, gameStarted });
});

app.post('/admin/start', (req, res) => {
  gameStarted = true;
  gameOpen = false; // Stop new payments once questions start
  console.log('GAME STARTED - No more payments, questions live');
  res.json({ success: true, gameOpen, gameStarted });
});

app.post('/admin/reset', (req, res) => {
  gameOpen = false;
  gameStarted = false;
  paidPlayers = [];
  pendingSTK = {};
  console.log('GAME RESET by Admin');
  res.json({ success: true, gameOpen, gameStarted });
});

// Get Daraja Access Token
async function getToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

// STK Push Endpoint - called from index.html
app.post('/pay', async (req, res) => {
  // 1. BLOCK IF GAME CLOSED - THIS FIXES YOUR BUG
  if (!gameOpen) {
    return res.status(403).json({ success: false, message: 'Game is CLOSED by Admin. Wait for Admin to OPEN the game.' });
  }
  if (gameStarted) {
    return res.status(403).json({ success: false, message: 'Game already STARTED. No more payments.' });
  }

  try {
    const { phone, amount } = req.body;
    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.slice(1);
    if (!/^254[17]\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone. Use 0712345678' });
    }

    // 2. BLOCK DUPLICATE STK - FIXES "STK NOT POPPING 2ND TIME"
    // If same phone requested STK in last 90 seconds, block it.
    // Safaricom blocks 2nd STK if 1st is still pending.
    const now = Date.now();
    const lastRequest = pendingSTK[cleanPhone];
    if (lastRequest && (now - lastRequest < 90000)) {
      const waitSec = Math.ceil((90000 - (now - lastRequest)) / 1000);
      return res.status(429).json({ success: false, message: `STK already sent! Check your phone. Cancel it or wait ${waitSec} seconds before trying again.` });
    }
    pendingSTK[cleanPhone] = now;

    const payAmount = Math.round(Number(amount) || 20);
    const token = await getToken();

    // Correct EAT timestamp YYYYMMDDHHMMSS
    const d = new Date(Date.now() + 3 * 60 * 60 * 1000); // EAT = UTC+3
    const timestamp = d.getUTCFullYear().toString() +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      String(d.getUTCDate()).padStart(2, '0') +
      String(d.getUTCHours()).padStart(2, '0') +
      String(d.getUTCMinutes()).padStart(2, '0') +
      String(d.getUTCSeconds()).padStart(2, '0');

    const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: payAmount,
      PartyA: cleanPhone,
      PartyB: TILL_NUMBER,
      PhoneNumber: cleanPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'AGENT Spot The Fake',
      TransactionDesc: 'Tournament Entry KSh ' + payAmount
    };

    console.log('STK Push to:', cleanPhone, 'Amount:', payAmount);
    const response = await axios.post('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Daraja Response:', response.data);

    // If Daraja rejected it, clear pending so user can retry immediately
    if (response.data.ResponseCode !== '0' && response.data.ResponseCode !== 0) {
      delete pendingSTK[cleanPhone];
    }

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('STK Error:', err.response?.data || err.message);
    // On error, allow retry - clear pending for this phone
    try {
      let p = String(req.body.phone || '').replace(/\D/g, '');
      if (p.startsWith('0')) p = '254' + p.slice(1);
      delete pendingSTK[p];
    } catch (e) {}
    res.status(500).json({ success: false, message: 'STK failed', error: err.response?.data || err.message });
  }
});

// Callback from Safaricom
app.post('/callback', (req, res) => {
  console.log('=== CALLBACK RECEIVED ===');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const body = req.body.Body?.stkCallback;
    if (body) {
      const resultCode = body.ResultCode;
      const metadata = body.CallbackMetadata?.Item || [];
      const getVal = (name) => {
        const item = metadata.find(i => i.Name === name);
        return item ? item.Value : null;
      };
      const phone = getVal('PhoneNumber');
      const amount = getVal('Amount');
      const receipt = getVal('MpesaReceiptNumber');

      // Clear pending - user finished (paid or cancelled)
      if (phone) delete pendingSTK[String(phone)];

      if (resultCode === 0) {
        console.log(`PAYMENT SUCCESS: ${phone} paid ${amount} Receipt: ${receipt}`);
        // FIXED: Always push - same phone paying 3 times = 3 entries
        // Old code had: if (!paidPlayers.find(...)) - that blocked 2nd/3rd payment
        if (phone) {
          paidPlayers.push({
            phone: String(phone),
            amount: Number(amount) || 20,
            receipt: receipt || '',
            time: new Date().toISOString()
          });
          console.log(`Total entries now: ${paidPlayers.length} - Total collected: KSh ${paidPlayers.reduce((s,p)=>s+(Number(p.amount)||20),0)}`);
        }
      } else {
        console.log(`PAYMENT FAILED/CANCELLED: ${phone} ResultCode: ${resultCode} Desc: ${body.ResultDesc}`);
      }
    }
  } catch (e) {
    console.log('Callback parse error:', e.message);
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/', (req, res) => res.send('AGENT Spot The Fake - Till Server Running'));

// Check if phone has PAID - called by index.html while waiting
app.get('/check-payment/:phone', (req, res) => {
  let p = String(req.params.phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  const found = paidPlayers.find(x => x.phone === p);
  if (found) return res.json({ paid: true, ...found });
  res.json({ paid: false });
});

// List all paid players - for Admin panel
// FIXED: Total = SUM of all amounts, not count * 20
app.get('/players', (req, res) => {
  const total = paidPlayers.reduce((sum, p) => sum + (Number(p.amount) || 20), 0);
  res.json({
    count: paidPlayers.length,
    total: total,
    prizePool: Math.floor(total * 0.4),
    players: paidPlayers
  });
});

app.listen(PORT, () => console.log(`Till Payment Server running on port ${PORT}`));