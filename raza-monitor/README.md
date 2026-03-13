# RazaMonitor v2.0

Real HTTP uptime monitoring. Like UptimeRobot — but yours.

## Features
- Real HTTP checks (not fake/random)
- Upstash Redis database
- Gmail email alerts
- Auto-check every 5 minutes via Vercel Cron
- Public status page
- Incident tracking

## Deploy to Vercel

1. Push this folder to GitHub
2. Go to vercel.com → New Project → Import repo
3. Framework Preset: **Other**
4. Build Command: `npm install`
5. Output Directory: `public`
6. Deploy!

## Credentials (already hardcoded in server.js)
- Upstash Redis: configured
- Gmail SMTP: configured
- Cron Secret: `razamonitor-cron-2024`

## Local Dev
```bash
npm install
npm run dev
```
App runs at http://localhost:3000
