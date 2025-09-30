// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  PermissionsBitField
} = require('discord.js');

// -------------------- CONFIG --------------------
const DATA_DIR = path.resolve(__dirname, 'data');
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');
const SETUPS_FILE = path.join(DATA_DIR, 'setups.json');

const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const SERVER_SEED_PUBLIC = process.env.SERVER_SEED_PUBLIC || 'demo-server-seed-please-change';
const TRX_API_URL = process.env.TRX_API_URL || null;
const TRX_TARGET_INCREMENT = Number(process.env.TRX_TARGET_INCREMENT || 2);
const DEFAULT_WINNERS = Number(process.env.DEFAULT_WINNERS || 1);

// basic env check
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Please set DISCORD_TOKEN and CLIENT_ID in .env');
  process.exit(1);
}

// -------------------- HELPERS --------------------
async function getFetch() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  try {
    const m = await import('node-fetch');
    return m.default;
  } catch (e) {
    throw new Error('No fetch available. Use Node >=18 or install node-fetch.');
  }
}

// Ensure data dir and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GIVEAWAYS_FILE)) fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify({ giveaways: [] }, null, 2));
if (!fs.existsSync(SETUPS_FILE)) fs.writeFileSync(SETUPS_FILE, JSON.stringify({ setups: [] }, null, 2));

// In-memory caches
let giveawaysCache = JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, 'utf8')).giveaways;
let setupsCache = JSON.parse(fs.readFileSync(SETUPS_FILE, 'utf8')).setups;

// watch files (reload on external edits)
fs.watchFile(GIVEAWAYS_FILE, { interval: 1000 }, () => {
  try { giveawaysCache = JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, 'utf8')).giveaways; console.log('[watch] giveaways reloaded'); } catch (e) { console.warn('[watch] reload giveaways failed', e && e.message ? e.message : e); }
});
fs.watchFile(SETUPS_FILE, { interval: 1000 }, () => {
  try { setupsCache = JSON.parse(fs.readFileSync(SETUPS_FILE, 'utf8')).setups; console.log('[watch] setups reloaded'); } catch (e) { console.warn('[watch] reload setups failed', e && e.message ? e.message : e); }
});

function persistGiveaways() { fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify({ giveaways: giveawaysCache }, null, 2)); }
function persistSetups() { fs.writeFileSync(SETUPS_FILE, JSON.stringify({ setups: setupsCache }, null, 2)); }
function pushGiveaway(gw) { giveawaysCache.push(gw); persistGiveaways(); }
function updateGiveaway(gw) { giveawaysCache = giveawaysCache.map(g => g.id === gw.id ? gw : g); persistGiveaways(); }
function pushSetup(s) { setupsCache.push(s); persistSetups(); }
function deleteSetup(id) { setupsCache = setupsCache.filter(s => s.id !== id); persistSetups(); }

// tempReports for details button (ephemeral storage)
const tempReports = {};

// -------------------- PROVABLY-FAIR HELPERS (LOCAL) --------------------
// Build HMAC with message: userid:clientseed:entryIndex  (ORDER requested)
function hmacSha256Hex(key, msg) {
  return crypto.createHmac('sha256', String(key)).update(String(msg)).digest('hex');
}

// Convert first 13 hex chars (52 bits) -> float in [0,1)
function hexToFloat52(hex) {
  if (!hex) return 0;
  if (hex.length < 13) hex = hex.padEnd(13, '0');
  const first13 = hex.slice(0, 13);
  const intVal = BigInt('0x' + first13);
  const denom = Math.pow(2, 52);
  const floatVal = Number(intVal) / denom;
  return floatVal;
}

/**
 * Build entries for a user using message format: userid:clientseed:entryIndex
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string} userId
 * @param {number} count
 * @returns Array of { userId, index, hex, float }
 */
function buildEntriesForUser(serverSeed, clientSeed, userId, count) {
  const out = [];
  const safeCount = Math.max(1, Number(count || 1));
  for (let i = 0; i < safeCount; i++) {
    const message = `${userId}:${clientSeed}:${i}`;
    const hex = hmacSha256Hex(serverSeed, message);
    const float = hexToFloat52(hex);
    out.push({ userId: String(userId), index: i, hex, float });
  }
  return out;
}

// -------------------- CORE GIVEAWAY LOGIC --------------------
function computeTotals(gw) {
  const extrasMap = {};
  (gw.extras || []).forEach(e => { if (e.roleId) extrasMap[e.roleId] = Number(e.extra) || 0; });
  let participants = 0;
  let totalEntries = 0;
  for (const ent of gw.entries || []) {
    participants++;
    const memberRoles = Array.isArray(ent.roles) ? ent.roles : [];
    let maxExtra = 0;
    for (const r of memberRoles) {
      if (extrasMap[r] && extrasMap[r] > maxExtra) maxExtra = extrasMap[r];
    }
    const base = Number(gw.basedAmount || 1);
    totalEntries += Math.max(1, base + maxExtra);
  }
  return { participants, totalEntries };
}

function buildEmbedAndComponentsForGw(gw) {
  const totals = computeTotals(gw);
  const embed = new EmbedBuilder()
    .setTitle(gw.title)
    .setDescription(`Participants: **${totals.participants}** — Total entries: **${totals.totalEntries}**\nEnds: <t:${Math.floor(gw.endsAt / 1000)}:t>`)
    .setTimestamp(new Date(gw.endsAt))
    .setFooter({ text: `Giveaway ID: ${gw.id}` });

  const now = Date.now();
  const ended = now >= gw.endsAt || !!gw.rolled;
  const row = new ActionRowBuilder();
  if (!ended) {
    row.addComponents(new ButtonBuilder().setCustomId(`join_${gw.id}`).setLabel('Join').setStyle(ButtonStyle.Success));
  }
  if (ended) {
    row.addComponents(new ButtonBuilder().setCustomId(`verify_${gw.id}`).setLabel('Verify').setStyle(ButtonStyle.Secondary));
  }
  return { embed, components: [row] };
}

function computeReportForClientSeed(gw, clientSeed) {
  const extrasMap = {};
  (gw.extras || []).forEach(e => { if (e.roleId) extrasMap[e.roleId] = Number(e.extra) || 0; });

  const entryRows = [];
  const entrants = [];

  for (const ent of gw.entries || []) {
    const memberRoles = Array.isArray(ent.roles) ? ent.roles : [];
    let maxExtra = 0;
    for (const r of memberRoles) if (extrasMap[r] && extrasMap[r] > maxExtra) maxExtra = extrasMap[r];
    const base = Number(gw.basedAmount || 1);
    const totalEntries = Math.max(1, base + maxExtra);

    // Use local buildEntriesForUser (message format userid:clientseed:index)
    const rows = buildEntriesForUser(SERVER_SEED_PUBLIC, clientSeed, ent.userId, totalEntries);
    rows.forEach(rr => rr.username = ent.username);
    entryRows.push(...rows);
    entrants.push({ userId: ent.userId, username: ent.username, entriesCount: totalEntries, floats: rows.map(r => r.float) });
  }

  entryRows.sort((a, b) => b.float - a.float);

  const winners = [];
  const winnersSet = new Set();
  const needed = Number(gw.winnersCount || DEFAULT_WINNERS);

  for (const row of entryRows) {
    if (!winnersSet.has(row.userId)) {
      winnersSet.add(row.userId);
      winners.push({ userId: row.userId, username: row.username, float: row.float, hex: row.hex, entryIndex: row.index });
      if (winners.length >= needed) break;
    }
  }

  const report = {
    clientSeed,
    totalEntrants: gw.entries.length,
    totalEntryRows: entryRows.length,
    entrants,
    winners
  };
  return { report, entryRows, winners };
}

async function performRoll(gw) {
  if (!gw.clientSeed) throw new Error('clientSeed not set for roll');
  const clientSeed = gw.clientSeed;
  const { report, winners } = computeReportForClientSeed(gw, clientSeed);
  return { winners, clientSeed, report };
}

// -------------------- TRX FETCH (HEAD + 2 POLL LOGIC) --------------------
/**
 * Logic:
 * 1) GET /wallet/getnowblock -> read head number (try multiple fields)
 * 2) target = head + TRX_TARGET_INCREMENT
 * 3) Poll getnowblock until head >= target (maxAttempts/time limit)
 * 4) GET /wallet/getblockbynum { num: target } -> extract blockHash (blockID/block_id/blockHash/hash)
 * 5) Validate hex and return clean hex string as clientSeed
 */
async function fetchTrxClientSeed() {
  if (!TRX_API_URL) throw new Error('TRX_API_URL not configured');
  const fetchFn = await getFetch();

  // helper to fetch now block and get head number (if any)
  async function fetchNowBlock() {
    const url = TRX_API_URL.replace(/\/$/, '') + '/wallet/getnowblock';
    const resp = await fetchFn(url, { method: 'GET' });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>null);
      throw new Error(`Failed getnowblock (status ${resp.status}): ${txt}`);
    }
    const data = await resp.json();
    // try multiple paths for block number
    if (data && data.block_header && data.block_header.raw_data && typeof data.block_header.raw_data.number === 'number') {
      return { data, number: data.block_header.raw_data.number };
    }
    if (data && typeof data.number === 'number') {
      return { data, number: data.number };
    }
    // sometimes getnowblock returns blockID directly instead of number
    return { data, number: null };
  }

  // 1) get now block
  const nowInfo = await fetchNowBlock();
  const headNum = nowInfo.number;

  if (headNum === null) {
    // if we couldn't read a head number, attempt to extract direct blockID and use it (no poll)
    const direct = nowInfo.data && (nowInfo.data.blockID || nowInfo.data.block_id || nowInfo.data.blockHash || nowInfo.data.hash || null);
    if (direct) {
      const clean = String(direct).trim();
      if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('TRX now block hash appears invalid (non-hex)');
      return clean;
    }
    // unable to determine head number or direct block id -> fail
    throw new Error('Unable to determine TRX head block number from getnowblock response');
  }

  // 2) compute target
  const target = headNum + TRX_TARGET_INCREMENT;

  // 3) poll until head >= target
  const pollIntervalMs = 1500;
  const maxAttempts = 40; // ~60s
  let attempts = 0;
  let reached = false;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const info = await fetchNowBlock();
      const cur = info.number;
      if (cur !== null && cur >= target) { reached = true; break; }
    } catch (e) {
      // log and continue poll (we tolerate transient errors)
      console.warn(`fetchTrxClientSeed poll attempt ${attempts} failed:`, e && e.message ? e.message : e);
    }
    // wait
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  if (!reached) throw new Error(`TRX head did not reach target ${target} within timeout`);

  // 4) fetch target block by num
  const blockUrl = TRX_API_URL.replace(/\/$/, '') + '/wallet/getblockbynum';
  const r2 = await fetchFn(blockUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num: target })
  });
  if (!r2.ok) {
    const txt = await r2.text().catch(()=>null);
    throw new Error(`Failed to fetch target block (${target}) (status ${r2.status}): ${txt}`);
  }
  const blockData = await r2.json();
  const blockHash = blockData.blockID || blockData.block_id || blockData.blockHash || blockData.hash || null;
  if (!blockHash) throw new Error('TRX target block response missing block hash');
  const cleanHash = String(blockHash).trim();
  if (!/^[0-9a-fA-F]+$/.test(cleanHash)) throw new Error('TRX block hash appears invalid (non-hex)');
  return cleanHash;
}

// -------------------- UPDATE MESSAGE --------------------
async function updateGiveawayMessage(gw) {
  if (!gw.messageId) return;
  try {
    const channel = await client.channels.fetch(gw.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
    if (!msg) return;
    const { embed, components } = buildEmbedAndComponentsForGw(gw);
    await msg.edit({ embeds: [embed], components });
  } catch (e) {
    console.warn('updateGiveawayMessage error', e && e.message ? e.message : e);
  }
}

// -------------------- EXPRESS APP --------------------
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// guilds/channels/roles
app.get('/api/guilds', (req, res) => {
  if (!global.botClientReady) return res.status(503).json({ error: 'Bot not ready' });
  const gs = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
  res.json(gs);
});
app.get('/api/guilds/:id/channels', async (req, res) => {
  if (!global.botClientReady) return res.status(503).json({ error: 'Bot not ready' });
  const guild = client.guilds.cache.get(req.params.id);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });
  const channels = (await guild.channels.fetch()).filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name, type: c.type }));
  res.json(channels);
});
app.get('/api/guilds/:id/roles', async (req, res) => {
  if (!global.botClientReady) return res.status(503).json({ error: 'Bot not ready' });
  const guild = client.guilds.cache.get(req.params.id);
  if (!guild) return res.status(404).json({ error: 'Guild not found' });
  const rolesMap = await guild.roles.fetch();
  const roles = Array.from(rolesMap.values()).map(r => ({ id: r.id, name: r.name, position: r.position }));
  roles.sort((a, b) => b.position - a.position);
  res.json(roles);
});

// setups
app.get('/api/setups', (req, res) => res.json(setupsCache));
app.post('/api/setups', (req, res) => {
  const body = req.body;
  if (!body || !body.name || !body.guildId) return res.status(400).json({ error: 'Missing name or guildId' });
  const exists = setupsCache.find(s => s.name === body.name && s.guildId === body.guildId);
  if (exists) return res.status(409).json({ error: 'Setup with same name exists for this guild' });
  const newS = {
    id: Date.now().toString(),
    name: body.name,
    title: body.title || body.name,
    guildId: body.guildId,
    channelId: body.channelId || null,
    basedAmount: Number(body.basedAmount || 1),
    durationMinutes: Number(body.durationMinutes || 1),
    winnersCount: Number(body.winners || DEFAULT_WINNERS),
    extras: Array.isArray(body.extras) ? body.extras : [],
    createdAt: Date.now()
  };
  pushSetup(newS);
  res.json(newS);
});
app.delete('/api/setups/:id', (req, res) => {
  const s = setupsCache.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  deleteSetup(req.params.id);
  res.json({ ok: true });
});

// giveaways
app.get('/api/giveaways', (req, res) => res.json(giveawaysCache));
app.get('/api/giveaways/:id', (req, res) => {
  const gw = giveawaysCache.find(g => g.id === req.params.id);
  if (!gw) return res.status(404).json({ error: 'Not found' });
  res.json(gw);
});
app.post('/api/giveaways', async (req, res) => {
  const body = req.body;
  if (!body || !body.channelId || !body.durationMinutes) return res.status(400).json({ error: 'Missing fields' });
  const id = Date.now().toString();
  const gw = {
    id,
    title: body.title || `Giveaway ${id}`,
    channelId: body.channelId,
    basedAmount: Number(body.basedAmount || 1),
    extras: Array.isArray(body.extras) ? body.extras : [],
    durationMinutes: Number(body.durationMinutes),
    winnersCount: Number(body.winners || DEFAULT_WINNERS),
    createdAt: Date.now(),
    endsAt: Date.now() + Number(body.durationMinutes) * 60000,
    entries: [],
    rolled: false,
    winners: [],
    messageId: null,
    clientSeed: null,
    serverSeedPublic: SERVER_SEED_PUBLIC
  };
  pushGiveaway(gw);

  if (global.botClientReady) {
    try {
      const channel = await client.channels.fetch(gw.channelId).catch(() => null);
      if (channel && channel.isTextBased() && channel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages)) {
        const { embed, components } = buildEmbedAndComponentsForGw(gw);
        const msg = await channel.send({ embeds: [embed], components });
        gw.messageId = msg.id;
        updateGiveaway(gw);
      }
    } catch (e) { console.warn('post giveaway failed', e && e.message ? e.message : e); }
  }

  scheduleEnd(gw.id, gw.endsAt);
  res.json(gw);
});

// join
app.post('/api/giveaways/:id/join', async (req, res) => {
  const id = req.params.id;
  const { userId, username, roles = [] } = req.body;
  const gw = giveawaysCache.find(g => g.id === id);
  if (!gw) return res.status(404).json({ error: 'Not found' });

  const now = Date.now();
  if (now >= gw.endsAt) return res.status(400).json({ error: 'Giveaway already ended' });
  if (gw.rolled) return res.status(400).json({ error: 'Giveaway already rolled' });

  if (gw.entries.some(e => e.userId === userId)) return res.status(200).json({ ok: true, message: 'Already joined' });

  gw.entries.push({ userId, username, joinedAt: Date.now(), roles });
  updateGiveaway(gw);
  updateGiveawayMessage(gw).catch(() => {});
  res.json({ ok: true });
});

// roll (requires TRX clientSeed valid hex)
app.post('/api/giveaways/:id/roll', async (req, res) => {
  const gw = giveawaysCache.find(g => g.id === req.params.id);
  if (!gw) return res.status(404).json({ error: 'Not found' });
  if (gw.rolled) return res.status(400).json({ error: 'Already rolled' });
  if (!TRX_API_URL) return res.status(500).json({ error: 'TRX_API_URL not configured' });

  // Fetch TRX clientSeed and validate
  let clientSeed;
  try {
    clientSeed = await fetchTrxClientSeed();
  } catch (e) {
    console.error('TRX fetch failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: `Failed to fetch TRX block for clientSeed: ${e && e.message ? e.message : 'unknown'}` });
  }
  if (!clientSeed || typeof clientSeed !== 'string' || !/^[0-9a-fA-F]+$/.test(clientSeed)) {
    return res.status(500).json({ error: 'Invalid TRX clientSeed received; aborting roll' });
  }
  gw.clientSeed = clientSeed;

  try {
    const { winners, clientSeed: cs, report } = await performRoll(gw);
    gw.rolled = true;
    gw.winners = winners;
    gw.rollReport = report;
    updateGiveaway(gw);

    // update original message: ended + winners short + clientSeed
    try {
      const channel = await client.channels.fetch(gw.channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        const winnerText = winners.length ? winners.map((w, i) => `${i + 1}. <@${w.userId}>`).join('\n') : 'No winners';
        const embed = new EmbedBuilder()
          .setTitle(`${gw.title} — Ended`)
          .setDescription(`Winners:\n${winnerText}\n\nClientSeed: ${cs}\nEnded: <t:${Math.floor(gw.endsAt / 1000)}:t>`)
          .setTimestamp(new Date(gw.endsAt))
          .setFooter({ text: `Giveaway ID: ${gw.id}` });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`verify_${gw.id}`).setLabel('Verify').setStyle(ButtonStyle.Secondary)
        );
        const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [embed], components: [row] });
        await channel.send({ embeds: [new EmbedBuilder().setTitle(`Giveaway Ended: ${gw.title}`).setDescription(winnerText).setFooter({ text: `PF clientSeed: ${cs}` })] });
      }
    } catch (e) { console.warn('update original msg after roll failed', e && e.message ? e.message : e); }

    res.json({ ok: true, winners, clientSeed: cs, report });
  } catch (e) {
    console.error('performRoll failed', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Roll failed' });
  }
});

// verify (allowed only after end)
app.get('/api/giveaways/:id/verify', async (req, res) => {
  const gw = giveawaysCache.find(g => g.id === req.params.id);
  if (!gw) return res.status(404).json({ error: 'Not found' });

  const now = Date.now();
  if (now < gw.endsAt) return res.status(400).json({ error: 'Verify allowed only after giveaway end' });

  // Use stored clientSeed if rolled; otherwise fetch TRX to compute (but do not mark rolled)
  let clientSeed = gw.clientSeed || null;
  if (!clientSeed) {
    if (!TRX_API_URL) return res.status(500).json({ error: 'TRX_API_URL not configured' });
    try { clientSeed = await fetchTrxClientSeed(); } catch (e) { return res.status(500).json({ error: 'Failed to fetch TRX block' }); }
  }
  try {
    const { report } = computeReportForClientSeed(gw, clientSeed);
    res.json(report);
  } catch (e) {
    console.error('verify compute failed', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Failed to compute report' });
  }
});

// details endpoint (download full JSON)
app.get('/api/giveaways/:id/details', async (req, res) => {
  const gw = giveawaysCache.find(g => g.id === req.params.id);
  if (!gw) return res.status(404).json({ error: 'Not found' });
  const now = Date.now();
  if (now < gw.endsAt) return res.status(400).json({ error: 'Details allowed only after end' });

  let clientSeed = gw.clientSeed || null;
  if (!clientSeed) {
    if (!TRX_API_URL) return res.status(500).json({ error: 'TRX_API_URL not configured' });
    try { clientSeed = await fetchTrxClientSeed(); } catch (e) { return res.status(500).json({ error: 'Failed to fetch TRX block' }); }
  }

  try {
    const { report } = computeReportForClientSeed(gw, clientSeed);
    const json = JSON.stringify(report, null, 2);
    res.setHeader('Content-Disposition', `attachment; filename="giveaway_${gw.id}_report.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(json);
  } catch (e) {
    console.error('details compute failed', e && e.message ? e.message : e);
    res.status(500).json({ error: 'Failed to produce details' });
  }
});

// -------------------- SCHEDULING --------------------
function scheduleEnd(giveawayId, endsAt) {
  const ms = endsAt - Date.now();
  if (ms <= 0) setImmediate(() => endGiveaway(giveawayId));
  else setTimeout(() => endGiveaway(giveawayId), ms);
}

async function endGiveaway(giveawayId) {
  const gw = giveawaysCache.find(g => g.id === giveawayId);
  if (!gw || gw.rolled) return;

  if (!TRX_API_URL) {
    // mark ended logically (embed will hide join and show verify)
    updateGiveawayMessage(gw).catch(() => {});
    return;
  }

  // fetch TRX clientSeed strictly with polling logic
  let clientSeed;
  try {
    clientSeed = await fetchTrxClientSeed();
  } catch (e) {
    console.error('TRX fetch failed during endGiveaway:', e && e.message ? e.message : e);
    updateGiveawayMessage(gw).catch(() => {});
    return;
  }

  if (!clientSeed || !/^[0-9a-fA-F]+$/.test(clientSeed)) {
    console.error('Invalid TRX clientSeed during endGiveaway:', clientSeed);
    updateGiveawayMessage(gw).catch(() => {});
    return;
  }

  gw.clientSeed = clientSeed;

  try {
    const { winners, clientSeed: cs, report } = await performRoll(gw);
    gw.rolled = true;
    gw.winners = winners;
    gw.rollReport = report;
    updateGiveaway(gw);

    // update original message
    try {
      const channel = await client.channels.fetch(gw.channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        const winnerText = winners.length ? winners.map((w, i) => `${i + 1}. <@${w.userId}>`).join('\n') : 'No winners';
        const embed = new EmbedBuilder()
          .setTitle(`${gw.title} — Ended`)
          .setDescription(`Winners:\n${winnerText}\n\nClientSeed: ${cs}\nEnded: <t:${Math.floor(gw.endsAt / 1000)}:t>`)
          .setTimestamp(new Date(gw.endsAt))
          .setFooter({ text: `Giveaway ID: ${gw.id}` });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`verify_${gw.id}`).setLabel('Verify').setStyle(ButtonStyle.Secondary)
        );
        const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [embed], components: [row] });
        await channel.send({ embeds: [new EmbedBuilder().setTitle(`Giveaway Ended: ${gw.title}`).setDescription(winnerText).setFooter({ text: `PF clientSeed: ${cs}` })] });
      }
    } catch (e) { console.warn('post winners after endGiveaway failed', e && e.message ? e.message : e); }
  } catch (e) {
    console.error('endGiveaway roll error', e && e.stack ? e.stack : e);
    updateGiveawayMessage(gw).catch(() => {});
  }
}

// -------------------- DISCORD HANDLERS --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});
global.botClient = client;
global.botClientReady = false;

// helper parse flags
function parseFlags(text) {
  const out = {};
  if (!text) return out;
  const re = /[^\s"]+|"([^"]*)"/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[1] ? m[1] : m[0]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq !== -1) { out[t.slice(2, eq)] = t.slice(eq + 1); }
      else {
        const key = t.slice(2);
        const next = tokens[i + 1];
        if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = 'true';
      }
    } else if (t.startsWith('-')) {
      const key = t.slice(1);
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) { out[key] = next; i++; } else out[key] = 'true';
    } else {
      out._pos = out._pos || [];
      out._pos.push(t);
    }
  }
  return out;
}
function parseChannelMention(val) { if (!val) return null; const m = val.match(/^<#(\d+)>$/); if (m) return m[1]; return null; }

// on $start
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    const content = (message.content || '').trim();
    if (!content.startsWith('$')) return;
    const parts = content.split(/\s+/);
    const cmd = parts[0].slice(1).toLowerCase();
    if (cmd !== 'start') return;

    // require admin
    const member = message.member;
    if (!member || !member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      try { await message.delete().catch(() => {}); } catch (e) {}
      return message.author.send('Bạn cần quyền Administrator để sử dụng lệnh $start.').catch(() => {});
    }

    const restRaw = content.includes(' ') ? content.slice(content.indexOf(' ') + 1) : '';
    const args = parseFlags(restRaw);
    let setupName = null;
    if (args.setup) setupName = args.setup;
    else if (args._pos && args._pos.length) setupName = args._pos[0];
    if (!setupName) {
      try { await message.delete().catch(() => {}); } catch (e) {}
      return message.author.send('Bạn cần chỉ định setup đã lưu: `$start <setupName>`').catch(() => {});
    }

    const setup = setupsCache.find(s => s.name === setupName && s.guildId === message.guild.id);
    if (!setup) {
      try { await message.delete().catch(() => {}); } catch (e) {}
      return message.author.send(`Không tìm thấy setup "${setupName}" cho server này. Kiểm tra Web UI.`).catch(() => {});
    }

    // create gw
    const id = Date.now().toString();
    const gw = {
      id,
      title: setup.title || setup.name || `Giveaway ${id}`,
      channelId: setup.channelId || message.channel.id,
      basedAmount: Number(setup.basedAmount || 1),
      extras: Array.isArray(setup.extras) ? setup.extras : [],
      durationMinutes: Number(setup.durationMinutes || 1),
      winnersCount: Number(setup.winnersCount || DEFAULT_WINNERS),
      createdAt: Date.now(),
      endsAt: Date.now() + Number(setup.durationMinutes) * 60000,
      entries: [],
      rolled: false,
      winners: [],
      messageId: null,
      clientSeed: null,
      serverSeedPublic: SERVER_SEED_PUBLIC,
      createdBy: message.author.id
    };
    pushGiveaway(gw);

    // delete original $start message (best-effort)
    try { await message.delete().catch(() => {}); } catch (e) {}

    // post in configured channel
    try {
      const postChannel = await client.channels.fetch(gw.channelId).catch(() => null);
      if (postChannel && postChannel.isTextBased() && postChannel.permissionsFor(client.user).has(PermissionsBitField.Flags.SendMessages)) {
        const { embed, components } = buildEmbedAndComponentsForGw(gw);
        const msg = await postChannel.send({ embeds: [embed], components });
        gw.messageId = msg.id;
        updateGiveaway(gw);

        // DM creator privately
        const link = `https://discord.com/channels/${message.guild.id}/${gw.channelId}/${gw.messageId}`;
        try { await message.author.send({ content: `Giveaway created: ${gw.title}\nLink: ${link}` }); } catch (e) {}
      } else {
        try { await message.author.send({ content: `Failed to post giveaway to channel ${gw.channelId}. Check bot permissions.` }); } catch(e) {}
      }
    } catch (e) {
      console.error('post giveaway failed', e && e.message ? e.message : e);
      try { await message.author.send({ content: `Failed to post giveaway: ${e && e.message ? e.message : e}` }); } catch (e2) {}
    }

    scheduleEnd(gw.id, gw.endsAt);

  } catch (err) {
    console.error('message handler error', err && err.stack ? err.stack : err);
  }
});

// interactions: join, verify, details
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;
    if (!id) return;

    // JOIN
    if (id.startsWith('join_')) {
      const gwId = id.slice('join_'.length);
      const gw = giveawaysCache.find(g => g.id === gwId);
      if (!gw) return interaction.reply({ content: 'Giveaway không tồn tại.', ephemeral: true });
      const now = Date.now();
      if (now >= gw.endsAt) return interaction.reply({ content: 'Giveaway đã kết thúc — bạn không thể tham gia.', ephemeral: true });
      if (gw.rolled) return interaction.reply({ content: 'Giveaway đã kết thúc.', ephemeral: true });

      const roles = interaction.member && interaction.member.roles && interaction.member.roles.cache ? Array.from(interaction.member.roles.cache.keys()) : [];
      if (gw.entries.some(e => e.userId === interaction.user.id)) return interaction.reply({ content: 'Bạn đã tham gia rồi.', ephemeral: true });

      gw.entries.push({ userId: interaction.user.id, username: interaction.user.tag, joinedAt: Date.now(), roles });
      updateGiveaway(gw);
      updateGiveawayMessage(gw).catch(() => {});
      return interaction.reply({ content: 'Bạn đã tham gia giveaway! ✅', ephemeral: true });
    }

    // VERIFY (short embed + Details button)
    if (id.startsWith('verify_')) {
      const gwId = id.slice('verify_'.length);
      const gw = giveawaysCache.find(g => g.id === gwId);
      if (!gw) return interaction.reply({ content: 'Giveaway không tồn tại.', ephemeral: true });

      const now = Date.now();
      if (now < gw.endsAt) return interaction.reply({ content: 'Verify chỉ có thể thực hiện sau khi giveaway kết thúc.', ephemeral: true });

      let clientSeed = gw.clientSeed || null;
      let report, winners;
      try {
        if (gw.rolled && gw.rollReport && gw.clientSeed) {
          report = gw.rollReport;
          winners = gw.winners || [];
          clientSeed = gw.clientSeed;
        } else {
          if (!TRX_API_URL) return interaction.reply({ content: 'TRX_API_URL not configured (cannot compute verify).', ephemeral: true });
          clientSeed = await fetchTrxClientSeed();
          const computed = computeReportForClientSeed(gw, clientSeed);
          report = computed.report;
          winners = computed.winners;
        }
        // cache for details
        tempReports[gw.id] = report;
      } catch (e) {
        console.error('verify compute failed', e && e.message ? e.message : e);
        return interaction.reply({ content: 'Verify failed (server error).', ephemeral: true });
      }

      const summaryEmbed = new EmbedBuilder()
        .setTitle(`Verify — ${gw.title}`)
        .addFields(
          { name: 'ClientSeed', value: String(clientSeed).slice(0, 200), inline: false },
          { name: 'Entrants', value: `${report.totalEntrants}`, inline: true },
          { name: 'Total Entries', value: `${report.totalEntryRows}`, inline: true },
          { name: 'Winners', value: report.winners && report.winners.length ? report.winners.map((w, i) => `${i + 1}. ${w.username || w.userId}`).join('\n') : 'No winners', inline: false }
        )
        .setTimestamp(new Date(gw.endsAt))
        .setFooter({ text: `Giveaway ID: ${gw.id}` });

      const comp = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`details_${gw.id}`).setLabel('Details Result').setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({ embeds: [summaryEmbed], components: [comp], ephemeral: true });
    }

    // DETAILS
    if (id.startsWith('details_')) {
      const gwId = id.slice('details_'.length);
      const gw = giveawaysCache.find(g => g.id === gwId);
      if (!gw) return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
      let report = tempReports[gw.id];
      if (!report) {
        // compute fresh
        let clientSeed = gw.clientSeed || null;
        if (!clientSeed) {
          if (!TRX_API_URL) return interaction.reply({ content: 'No report available and TRX_API_URL not configured.', ephemeral: true });
          try { clientSeed = await fetchTrxClientSeed(); } catch (e) { return interaction.reply({ content: 'Failed to fetch TRX block for details.', ephemeral: true }); }
        }
        const computed = computeReportForClientSeed(gw, clientSeed);
        report = computed.report;
      }
      const json = JSON.stringify(report, null, 2);
      const buf = Buffer.from(json, 'utf8');
      return interaction.reply({ files: [{ attachment: buf, name: `giveaway_${gw.id}_report.json` }], ephemeral: true });
    }

  } catch (e) {
    console.error('interaction handler error', e && e.stack ? e.stack : e);
  }
});

// on ready
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  global.botClientReady = true;
  // schedule existing
  for (const gw of giveawaysCache) {
    if (!gw.rolled && gw.endsAt) scheduleEnd(gw.id, gw.endsAt);
  }
});

// login and start express
client.login(DISCORD_TOKEN).catch(err => { console.error('Failed to login:', err && err.message ? err.message : err); process.exit(1); });
app.listen(PORT, () => console.log(`Web UI running at http://localhost:${PORT}`));
