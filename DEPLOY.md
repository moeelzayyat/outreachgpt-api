# OutreachGPT API — Deploy with Coolify

## Architecture

```
Chrome Extension → POST /generate → Your Coolify Server → OpenAI API
```

Users never need an API key. Your server proxies all AI calls.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express server with prompt engine, rate limiting, access codes |
| `Dockerfile` | Container config for Coolify |
| `package.json` | Dependencies (express, cors) |

## Step 1: Push to GitHub

Create a repo (or use a subdirectory of your existing repo):

```bash
cd c:\Projects\bypass\outreachgpt\backend
git init
git add .
git commit -m "OutreachGPT API backend"
git remote add origin https://github.com/YOUR_USERNAME/outreachgpt-api.git
git push -u origin main
```

Or if you want to keep it in your existing `bypass` repo, just push the whole thing.

## Step 2: Create Service in Coolify

1. Open your Coolify dashboard
2. **Add New Resource** → **Application**
3. Select your GitHub repo
4. Set **Build Pack** to **Dockerfile**
5. Set **Port** to `3000`

## Step 3: Set Environment Variables

In Coolify's environment variables section, add:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-...` (your OpenAI key) |
| `BETA_CODES` | `beta001,beta002,beta003` (comma-separated, or leave empty for open access) |
| `PORT` | `3000` |

## Step 4: Deploy

Click **Deploy** in Coolify. It will build the Docker image and start the server.

## Step 5: Verify

Once deployed, check the health endpoint:

```
curl https://YOUR_COOLIFY_DOMAIN/health
```

Should return:
```json
{"status":"ok","timestamp":"2026-03-24T..."}
```

## Step 6: Update Extension

1. Open `extension/background.js`
2. Change `API_BASE` to your Coolify URL (e.g. `https://api.outreachgpt.com`)
3. Set `USE_LOCAL_MODE = false`
4. Open `extension/popup.js`
5. Change `API_BASE` to the same URL
6. Reload the extension

## Costs

| Usage | OpenAI Cost |
|---|---|
| 10 users × 10 emails/day | ~$9/month |
| 50 users × 10 emails/day | ~$45/month |
| 200 users × 10 emails/day | ~$180/month |

Server cost depends on your Coolify hosting (typically $5-20/month for a small VPS).
