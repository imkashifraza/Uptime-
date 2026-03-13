import { Router, type IRouter } from 'express';
import { redis } from '../lib/redis';
import { sendEmail, GMAIL_USER } from '../lib/mailer';

const router: IRouter = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────
function parse(raw: unknown) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function allMonitors() {
  const ids: string[] = (await redis.smembers('monitor_ids')) as string[];
  if (!ids?.length) return [];
  const monitors = await Promise.all(ids.map(id => redis.get(`monitor:${id}`).then(parse)));
  return monitors.filter(Boolean);
}

async function checkMonitor(monitor: any) {
  const start = Date.now();
  let status = 'down', responseTime = 0, statusCode: number | null = null, errorMsg: string | null = null;

  try {
    const res = await fetch(monitor.url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'RazaMonitor/2.0' },
    });
    responseTime = Date.now() - start;
    statusCode = res.status;
    status = res.status < 400 ? 'up' : 'down';
  } catch (err: any) {
    errorMsg = err.message;
  }

  const prevStatus = monitor.status;
  const entry = { status, response: responseTime, time: Date.now(), statusCode };
  const history = [...(monitor.history || []), entry].slice(-30);
  const upCount = history.filter((h: any) => h.status === 'up').length;
  const uptime = parseFloat(((upCount / history.length) * 100).toFixed(2));

  const updated = { ...monitor, status, uptime, lastResponse: responseTime, lastChecked: Date.now(), lastStatusCode: statusCode, history, checks: (monitor.checks || 0) + 1 };
  await redis.set(`monitor:${monitor.id}`, JSON.stringify(updated));

  // ─ incident down ─
  if (prevStatus !== 'down' && status === 'down') {
    const incId = `inc_${Date.now()}`;
    await redis.set(`incident:${incId}`, JSON.stringify({ id: incId, monitorId: monitor.id, monitorName: monitor.name, monitorUrl: monitor.url, startTime: Date.now(), endTime: null, duration: null, status: 'ongoing', error: errorMsg, statusCode }));
    await redis.sadd('incident_ids', incId);
    if (monitor.alertEmail) {
      sendEmail(monitor.alertEmail, `[RazaMonitor] ${monitor.name} is DOWN`,
        `<h2 style="color:#ef4444">🔴 Monitor is DOWN</h2><p><b>Name:</b> ${monitor.name}</p><p><b>URL:</b> ${monitor.url}</p><p><b>Time:</b> ${new Date().toLocaleString()}</p><p><b>Status Code:</b> ${statusCode ?? 'N/A'}</p><p><b>Error:</b> ${errorMsg ?? 'Unknown'}</p><hr/><small>RazaMonitor</small>`);
    }
  }

  // ─ incident up ─
  if (prevStatus === 'down' && status === 'up') {
    const incIds: string[] = (await redis.smembers('incident_ids')) as string[];
    for (const iid of incIds ?? []) {
      const inc: any = parse(await redis.get(`incident:${iid}`));
      if (inc?.monitorId === monitor.id && inc?.status === 'ongoing') {
        const ms = Date.now() - inc.startTime;
        inc.endTime = Date.now();
        inc.duration = `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
        inc.status = 'resolved';
        await redis.set(`incident:${iid}`, JSON.stringify(inc));
      }
    }
    if (monitor.alertEmail) {
      sendEmail(monitor.alertEmail, `[RazaMonitor] ${monitor.name} is back UP`,
        `<h2 style="color:#00ff88">🟢 Monitor is back UP</h2><p><b>Name:</b> ${monitor.name}</p><p><b>URL:</b> ${monitor.url}</p><p><b>Time:</b> ${new Date().toLocaleString()}</p><p><b>Response:</b> ${responseTime}ms</p><hr/><small>RazaMonitor</small>`);
    }
  }

  return { status, responseTime, statusCode, uptime, error: errorMsg };
}

// ─── routes ───────────────────────────────────────────────────────────────────
router.get('/monitors', async (_req, res) => {
  try { res.json(await allMonitors()); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/monitors', async (req, res) => {
  try {
    const { name, url, type = 'HTTP', interval = 5, alertEmail = '' } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const id = Date.now().toString();
    const monitor = { id, name, url, type, interval, alertEmail, status: 'checking', uptime: 100, lastResponse: 0, lastChecked: null, lastStatusCode: null, paused: false, history: [], checks: 0 };
    await redis.set(`monitor:${id}`, JSON.stringify(monitor));
    await redis.sadd('monitor_ids', id);
    checkMonitor(monitor).catch(() => {});
    res.json(monitor);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/monitors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await redis.del(`monitor:${id}`);
    await redis.srem('monitor_ids', id);
    const incIds: string[] = (await redis.smembers('incident_ids')) as string[];
    for (const iid of incIds ?? []) {
      const inc: any = parse(await redis.get(`incident:${iid}`));
      if (inc?.monitorId === id) { await redis.del(`incident:${iid}`); await redis.srem('incident_ids', iid); }
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/monitors/:id/pause', async (req, res) => {
  try {
    const raw: any = parse(await redis.get(`monitor:${req.params.id}`));
    if (!raw) return res.status(404).json({ error: 'Not found' });
    raw.paused = !raw.paused;
    raw.status = raw.paused ? 'paused' : 'checking';
    await redis.set(`monitor:${req.params.id}`, JSON.stringify(raw));
    res.json(raw);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/monitors/:id/check', async (req, res) => {
  try {
    const monitor: any = parse(await redis.get(`monitor:${req.params.id}`));
    if (!monitor) return res.status(404).json({ error: 'Not found' });
    if (monitor.paused) return res.json({ status: 'paused', message: 'Monitor is paused' });
    res.json(await checkMonitor(monitor));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/cron/check-all', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer razamonitor-cron-2024') return res.status(401).json({ error: 'Unauthorized' });
    const monitors = await allMonitors();
    const results = [];
    for (const m of monitors) {
      if (!m.paused) results.push({ id: m.id, ...(await checkMonitor(m)) });
    }
    res.json({ checked: results.length, results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/incidents', async (_req, res) => {
  try {
    const ids: string[] = (await redis.smembers('incident_ids')) as string[];
    if (!ids?.length) return res.json([]);
    const incidents = await Promise.all(ids.map(id => redis.get(`incident:${id}`).then(parse)));
    res.json(incidents.filter(Boolean).sort((a: any, b: any) => b.startTime - a.startTime));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete('/incidents', async (_req, res) => {
  try {
    const ids: string[] = (await redis.smembers('incident_ids')) as string[];
    for (const id of ids ?? []) { await redis.del(`incident:${id}`); await redis.srem('incident_ids', id); }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', async (_req, res) => {
  try {
    const monitors: any[] = await allMonitors();
    if (!monitors.length) return res.json({ total: 0, up: 0, down: 0, paused: 0, avgUptime: 0 });
    res.json({
      total: monitors.length,
      up: monitors.filter(m => m.status === 'up').length,
      down: monitors.filter(m => m.status === 'down').length,
      paused: monitors.filter(m => m.paused).length,
      avgUptime: parseFloat((monitors.reduce((s, m) => s + (m.uptime || 0), 0) / monitors.length).toFixed(2)),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/status', async (_req, res) => {
  try {
    const monitors: any[] = await allMonitors();
    res.json({
      overall: monitors.every(m => m.status === 'up' || m.paused) ? 'operational' : 'degraded',
      monitors: monitors.map(m => ({ name: m.name, url: m.url, status: m.status, uptime: m.uptime, lastChecked: m.lastChecked })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/ping', (_req, res) => res.json({ alive: true, time: new Date().toISOString() }));

export default router;
