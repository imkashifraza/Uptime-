const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const { Redis } = require('@upstash/redis');

const app = express();

// ─── HARDCODED CONFIG ────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL   = 'https://becoming-escargot-70961.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'gQAAAAAAARUxAAIncDJlOWVmOTk5NjZjZTQ0YjdjYTQxNWZjZDFhZjBhODdjOHAyNzA5NjE';
const GMAIL_USER               = 'technicalsolutinon@gmail.com';
const GMAIL_APP_PASSWORD       = 'lxpawjiawkzmqcde';
const CRON_SECRET              = 'razamonitor-cron-2024';
// ─────────────────────────────────────────────────────────────────────────────

const redis = new Redis({
  url:   UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/ping', (_req, res) => {
  res.json({ alive: true, time: new Date().toISOString() });
});

// ─── GET ALL MONITORS ────────────────────────────────────────────────────────
app.get('/api/monitors', async (_req, res) => {
  try {
    const ids = await redis.smembers('monitor_ids');
    if (!ids || ids.length === 0) return res.json([]);
    const monitors = await Promise.all(
      ids.map(async (id) => {
        const m = await redis.get(`monitor:${id}`);
        return m ? (typeof m === 'string' ? JSON.parse(m) : m) : null;
      })
    );
    res.json(monitors.filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADD MONITOR ─────────────────────────────────────────────────────────────
app.post('/api/monitors', async (req, res) => {
  try {
    const { name, url, type = 'HTTP', interval = 5, alertEmail = '' } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    if (!url.startsWith('http://') && !url.startsWith('https://'))
      return res.status(400).json({ error: 'URL must start with http:// or https://' });

    const id = Date.now().toString();
    const monitor = {
      id, name, url, type, interval, alertEmail,
      status: 'checking',
      uptime: 100,
      lastResponse: 0,
      lastChecked: null,
      lastStatusCode: null,
      paused: false,
      history: [],
      checks: 0,
    };
    await redis.set(`monitor:${id}`, JSON.stringify(monitor));
    await redis.sadd('monitor_ids', id);
    res.json(monitor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE MONITOR ──────────────────────────────────────────────────────────
app.delete('/api/monitors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await redis.del(`monitor:${id}`);
    await redis.srem('monitor_ids', id);
    const incidentIds = await redis.smembers('incident_ids');
    for (const iid of (incidentIds || [])) {
      const inc = await redis.get(`incident:${iid}`);
      const parsed = inc ? (typeof inc === 'string' ? JSON.parse(inc) : inc) : null;
      if (parsed && parsed.monitorId === id) {
        await redis.del(`incident:${iid}`);
        await redis.srem('incident_ids', iid);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TOGGLE PAUSE ────────────────────────────────────────────────────────────
app.post('/api/monitors/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const raw = await redis.get(`monitor:${id}`);
    if (!raw) return res.status(404).json({ error: 'Monitor not found' });
    const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw;
    monitor.paused = !monitor.paused;
    monitor.status = monitor.paused ? 'paused' : 'checking';
    await redis.set(`monitor:${id}`, JSON.stringify(monitor));
    res.json(monitor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REAL HTTP CHECK ─────────────────────────────────────────────────────────
async function checkMonitor(monitor) {
  const start = Date.now();
  let status = 'down';
  let responseTime = 0;
  let statusCode = null;
  let errorMsg = null;

  try {
    const res = await fetch(monitor.url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'RazaMonitor/2.0' },
    });
    responseTime = Date.now() - start;
    statusCode = res.status;
    status = res.status < 400 ? 'up' : 'down';
  } catch (err) {
    responseTime = 0;
    errorMsg = err.message;
    status = 'down';
  }

  const prevStatus = monitor.status;
  const historyEntry = { status, response: responseTime, time: Date.now(), statusCode };
  const history = [...(monitor.history || []), historyEntry].slice(-30);
  const upCount = history.filter((h) => h.status === 'up').length;
  const uptime = history.length > 0 ? parseFloat(((upCount / history.length) * 100).toFixed(2)) : 100;

  const updated = {
    ...monitor,
    status,
    uptime,
    lastResponse: responseTime,
    lastChecked: Date.now(),
    lastStatusCode: statusCode,
    history,
    checks: (monitor.checks || 0) + 1,
  };

  await redis.set(`monitor:${monitor.id}`, JSON.stringify(updated));

  // Incident handling
  if (prevStatus !== 'down' && status === 'down') {
    const incId = `inc_${Date.now()}`;
    const incident = {
      id: incId,
      monitorId: monitor.id,
      monitorName: monitor.name,
      monitorUrl: monitor.url,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      status: 'ongoing',
      error: errorMsg,
      statusCode,
    };
    await redis.set(`incident:${incId}`, JSON.stringify(incident));
    await redis.sadd('incident_ids', incId);
    if (monitor.alertEmail) {
      sendEmail(monitor.alertEmail, `[RazaMonitor] ${monitor.name} is DOWN`, `
        <h2 style="color:#ef4444">🔴 Monitor is DOWN</h2>
        <p><b>Name:</b> ${monitor.name}</p>
        <p><b>URL:</b> ${monitor.url}</p>
        <p><b>Time:</b> ${new Date().toLocaleString()}</p>
        <p><b>Status Code:</b> ${statusCode || 'N/A'}</p>
        <p><b>Error:</b> ${errorMsg || 'Unknown'}</p>
        <hr/>
        <small>RazaMonitor — Real Monitoring</small>
      `);
    }
  }

  if (prevStatus === 'down' && status === 'up') {
    const incidentIds = await redis.smembers('incident_ids');
    for (const iid of (incidentIds || [])) {
      const raw = await redis.get(`incident:${iid}`);
      const inc = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (inc && inc.monitorId === monitor.id && inc.status === 'ongoing') {
        const downMs = Date.now() - inc.startTime;
        const mins = Math.floor(downMs / 60000);
        const secs = Math.floor((downMs % 60000) / 1000);
        inc.endTime = Date.now();
        inc.duration = `${mins}m ${secs}s`;
        inc.status = 'resolved';
        await redis.set(`incident:${iid}`, JSON.stringify(inc));
      }
    }
    if (monitor.alertEmail) {
      sendEmail(monitor.alertEmail, `[RazaMonitor] ${monitor.name} is back UP`, `
        <h2 style="color:#00ff88">🟢 Monitor is back UP</h2>
        <p><b>Name:</b> ${monitor.name}</p>
        <p><b>URL:</b> ${monitor.url}</p>
        <p><b>Time:</b> ${new Date().toLocaleString()}</p>
        <p><b>Response Time:</b> ${responseTime}ms</p>
        <hr/>
        <small>RazaMonitor — Real Monitoring</small>
      `);
    }
  }

  return { status, responseTime, statusCode, uptime, error: errorMsg };
}

function sendEmail(to, subject, html) {
  mailer.sendMail({ from: GMAIL_USER, to, subject, html }).catch(console.error);
}

app.get('/api/monitors/:id/check', async (req, res) => {
  try {
    const { id } = req.params;
    const raw = await redis.get(`monitor:${id}`);
    if (!raw) return res.status(404).json({ error: 'Monitor not found' });
    const monitor = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (monitor.paused) return res.json({ status: 'paused', message: 'Monitor is paused' });
    const result = await checkMonitor(monitor);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CRON — CHECK ALL ─────────────────────────────────────────────────────────
app.get('/api/cron/check-all', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const ids = await redis.smembers('monitor_ids');
    if (!ids || ids.length === 0) return res.json({ checked: 0 });
    const results = [];
    for (const id of ids) {
      const raw = await redis.get(`monitor:${id}`);
      const monitor = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (monitor && !monitor.paused) {
        const r = await checkMonitor(monitor);
        results.push({ id, ...r });
      }
    }
    res.json({ checked: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── INCIDENTS ───────────────────────────────────────────────────────────────
app.get('/api/incidents', async (_req, res) => {
  try {
    const ids = await redis.smembers('incident_ids');
    if (!ids || ids.length === 0) return res.json([]);
    const incidents = await Promise.all(
      ids.map(async (id) => {
        const i = await redis.get(`incident:${id}`);
        return i ? (typeof i === 'string' ? JSON.parse(i) : i) : null;
      })
    );
    res.json(incidents.filter(Boolean).sort((a, b) => b.startTime - a.startTime));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/incidents', async (_req, res) => {
  try {
    const ids = await redis.smembers('incident_ids');
    for (const id of (ids || [])) {
      await redis.del(`incident:${id}`);
      await redis.srem('incident_ids', id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATS ───────────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const ids = await redis.smembers('monitor_ids');
    if (!ids || ids.length === 0) return res.json({ total: 0, up: 0, down: 0, paused: 0, avgUptime: 0 });
    const monitors = await Promise.all(
      ids.map(async (id) => {
        const m = await redis.get(`monitor:${id}`);
        return m ? (typeof m === 'string' ? JSON.parse(m) : m) : null;
      })
    );
    const valid = monitors.filter(Boolean);
    const up      = valid.filter((m) => m.status === 'up').length;
    const down    = valid.filter((m) => m.status === 'down').length;
    const paused  = valid.filter((m) => m.paused).length;
    const avgUptime = valid.length > 0
      ? parseFloat((valid.reduce((s, m) => s + (m.uptime || 0), 0) / valid.length).toFixed(2))
      : 0;
    res.json({ total: valid.length, up, down, paused, avgUptime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATUS PAGE ─────────────────────────────────────────────────────────────
app.get('/api/status', async (_req, res) => {
  try {
    const ids = await redis.smembers('monitor_ids');
    const monitors = await Promise.all(
      (ids || []).map(async (id) => {
        const m = await redis.get(`monitor:${id}`);
        return m ? (typeof m === 'string' ? JSON.parse(m) : m) : null;
      })
    );
    const valid = monitors.filter(Boolean);
    const allUp = valid.every((m) => m.status === 'up' || m.paused);
    res.json({
      overall: allUp ? 'operational' : 'degraded',
      monitors: valid.map((m) => ({
        name: m.name, url: m.url, status: m.status, uptime: m.uptime, lastChecked: m.lastChecked,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FALLBACK ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RazaMonitor running on port ${PORT}`));

module.exports = app;
