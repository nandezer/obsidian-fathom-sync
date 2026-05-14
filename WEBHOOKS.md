# Webhook intake (v2.0)

The polling sync built into v1 only sees meetings you recorded yourself. To also pick up **meetings shared with you** — by teammates, by clients, by external people who send you a Fathom share link — the plugin can subscribe to Fathom's webhook stream.

Setup time: **~5 minutes**, mostly typing your way through a Cloudflare form.

---

## How it works

```
Fathom ──POSTs webhook──► Your Cloudflare Worker ──serves /pending──► Plugin polls ──► Vault note
```

You run a small (~200 LOC) Cloudflare Worker. It:
- receives webhook POSTs from Fathom
- verifies the HMAC-SHA256 signature
- stashes the payload in KV (free tier)
- exposes a bearer-auth `GET /pending` for the plugin to poll

Cloudflare Workers' free tier covers 100,000 requests/day. For typical use (a few meetings a day) you'll use < 100 requests/day.

---

## Setup

### Step 1 — Deploy the Worker

Click the **Deploy to Cloudflare** button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nandezer/obsidian-fathom-sync/tree/main/worker)

Cloudflare will:
1. Ask you to sign up (free, no credit card) or sign in.
2. Ask permission to read this repo from GitHub.
3. Fork the repo into your own GitHub account (e.g. `your-username/obsidian-fathom-sync`).
4. Drop you on a **Create a Worker** form. That's expected — "create a worker" is Cloudflare's label for *any* Worker deployment, including ones forked from an existing repo.

**Fields on the "Create a Worker" form:**

| Field | Set it to |
|-------|-----------|
| Git account | Your GitHub account |
| Create a private repo | **Unchecked** (Cloudflare needs to read it on every redeploy) |
| Project name | `obsidian-fathom-sync-worker` (or any unique name; if you have a previous fork, you'll get "A repository with that name already exists" until you change it) |
| Select KV namespace | **Create new** |
| Name KV namespace | `fathom-sync-deliveries` |
| Build command | leave blank |
| Deploy command | leave the default (usually `npx wrangler deploy`) |
| Build for non-production branches | off |
| Advanced settings | skip |

**Important: do NOT enter `PLUGIN_BEARER_TOKEN` or `FATHOM_WEBHOOK_SECRET` here even if Cloudflare prompts for them on this form.** We set them as Cloudflare **Secrets** in Step 2 — putting them as plain vars at deploy time would leave them visible in the dashboard and committed to your fork.

If Cloudflare insists on a value (some flows require non-empty), type literal placeholders:
- `PLUGIN_BEARER_TOKEN` → `temporary-will-replace`
- `FATHOM_WEBHOOK_SECRET` → `temporary-will-replace`

Click **Create and deploy**. Wait 30–60 seconds.

When done, Cloudflare shows the Worker URL. It looks like `https://obsidian-fathom-sync-worker.<your-subdomain>.workers.dev`. **Copy it.**

The Worker is now live but will respond `503 worker_not_configured` to any request other than `/health` until you finish Step 2. That's deliberate — the Worker fails closed if either secret is missing.

### Step 2 — Set the two secrets

In Cloudflare dashboard → your Worker → **Settings** tab → look for **Environment secrets** (or "Manage environment secrets"). This is the **encrypted** store. Do not confuse it with:
- **Environment variables** (plain text, visible in the dashboard — wrong place for secrets)
- **GitHub repo environment secrets** (Cloudflare's UI sometimes nests them this way; these are for GitHub Actions, not your running Worker)

If you ever see protection rules / deployment branches / tags prompts, you've ended up in the GitHub-side store. Back out and find the section that just says "Add secret" with no GitHub-Actions context.

Add **two** environment secrets:

#### Secret 1: `PLUGIN_BEARER_TOKEN`

The shared bearer the plugin presents in `Authorization: Bearer …` when polling.

**Generate the value in a terminal you do NOT share with an AI assistant** (so the secret never lands in a chat transcript). Open a fresh PowerShell, bash, or zsh window and run:

```powershell
# PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

```bash
# bash / zsh
openssl rand -hex 32
```

Copy the 64-character hex string from your terminal directly into Cloudflare's secret field. **Save it in your password manager at the same time** — you'll need to type the identical value into the plugin in Step 3, and Cloudflare will mask it after save so you can't read it back.

Type: **Secret** (not Variable / Plain text).

#### Secret 2: `FATHOM_WEBHOOK_SECRET`

For now, set it to the literal string:

```
placeholder-set-after-connect
```

The *real* value comes from Fathom in Step 4; you'll edit this secret to overwrite the placeholder then.

Type: **Secret**.

After both are saved, Cloudflare auto-redeploys the Worker (~10 s). Once that finishes, `/pending` should respond with 401 (instead of 503) if you hit it without a bearer — that's how you know both secrets are loaded.

### Step 3 — Tell the plugin about your Worker

In Obsidian → Settings → Fathom Sync. Scroll to **Webhook intake**:

1. **Source** → `HTTP (Cloudflare Worker)`. New fields will appear immediately.
2. **Worker URL** → paste the URL from Step 1 (the `workers.dev` one).
3. **Bearer token** → paste the same hex string you put into `PLUGIN_BEARER_TOKEN` in Step 2.
4. Click **Test queue** (button labelled "Test"). You should see a toast:
   > Fathom Sync: Worker OK (0 pending deliveries).

If Test fails, re-check the URL (no trailing slash) and that the bearer matches Cloudflare exactly. Don't proceed to Step 4 until Test passes — Connect creates a real Fathom-side webhook and partial failures leave orphans.

### Step 4 — Click Connect

**Connect** is the button right after Test queue. Clicking it:
1. Calls Fathom's `POST /webhooks` with your API token, registering a webhook that POSTs every new meeting (yours + team + external shares) to your Worker.
2. Fathom returns a **signing secret** (`whsec_…`) — the HMAC key your Worker will use to verify deliveries.
3. The plugin **silently copies the signing secret to your clipboard**. It is never rendered in the UI.
4. A 20-second toast confirms with only the last 6 characters of the secret, e.g.:
   > Fathom Sync: webhook registered (id ABCD1234…). Signing secret ending in …xY7q9P copied to clipboard. Paste it into your Worker's FATHOM_WEBHOOK_SECRET variable.

**Critical**: your clipboard now holds the only copy of the secret Fathom will ever give you. Do not copy anything else. Go straight to Step 5.

### Step 5 — Paste the signing secret into Cloudflare

Cloudflare dashboard → your Worker → **Settings → Environment secrets**. Find the `FATHOM_WEBHOOK_SECRET` entry (currently `placeholder-set-after-connect`).

1. Click **Edit** (or pencil / three-dot menu → "Replace value").
2. Paste from clipboard. The value starts with `whsec_`.
3. Save. Cloudflare redeploys the Worker.

Done. The Worker now verifies real Fathom signatures.

### Step 6 — Verify end-to-end

Easiest test: re-share an existing Fathom share link to your own email, OR record any 2-minute Fathom meeting yourself.

Wait ~30 seconds (Fathom processes the recording and fires the webhook), then click the sync ribbon in Obsidian (refresh-cw icon, left edge). Watch the developer console (`Ctrl+Shift+I` → Console, filter `[Fathom Sync]`). You should see:

```
[Fathom Sync] Draining queue http:https://obsidian-fathom-sync-worker.<sub>.workers.dev…
[Fathom Sync] Queue http:…: 1 pending deliveries.
[Fathom Sync] Queue drain complete. Summaries: 1, …
```

A new note appears in your summaries folder. From now on, **periodic sync handles this automatically** — every N minutes (default 60, configurable down to 5 in plugin settings), the plugin drains anything that's accumulated in your Worker.

---

## What gets synced

When the plugin registers the webhook it sets all four `triggered_for` categories:

| Category | What it covers |
|---|---|
| `my_recordings` | Meetings you recorded yourself |
| `my_shared_with_team_recordings` | Your meetings that you shared with your team |
| `shared_team_recordings` | Teammates' meetings shared with you |
| **`shared_external_recordings`** | **Meetings from outside your team that someone shared with you** — the case v2 was built for |

Each delivery includes the full summary, transcript, action items, and meeting metadata inline. No follow-up API calls needed — the plugin writes the note straight from the payload.

---

## Troubleshooting

**Test queue says `Worker test failed — 401 unauthorized`**
The bearer token in the plugin doesn't match `PLUGIN_BEARER_TOKEN` in Cloudflare. Re-check both, save the plugin setting, hit Test again. If Cloudflare's secret was overwritten by Save without confirmation, re-set it from your password manager.

**Test queue says `Worker not ready — 503 worker_not_configured`**
One or both Cloudflare secrets are missing. Set both `PLUGIN_BEARER_TOKEN` and `FATHOM_WEBHOOK_SECRET` via **Environment secrets** (not plain variables). Wait for Cloudflare's auto-redeploy.

**Connect says `webhook registration failed — invalid API token`**
Your Fathom API token is wrong or expired. Open [fathom.video/customize](https://fathom.video/customize#api-access-header) → API Access → regenerate.

**Webhook arrives but plugin reports `0 pending deliveries`**
The Worker is rejecting Fathom's signatures. The signing secret in Cloudflare doesn't match what Fathom is sending. Check Cloudflare Worker logs (Settings → Logs → tail) — if you see "Rejected webhook: signature mismatch", re-paste from Step 4. If you've lost the secret, run Re-register in the plugin to make Fathom issue a new one.

**Meeting was on Fathom 1+ hour ago and still hasn't synced**
- Check Cloudflare Worker logs — did the webhook arrive at all?
- Check Obsidian console — did the periodic drain run?
- If the webhook didn't arrive, the Fathom-side webhook registration may have been deleted. Run **Re-register** in plugin settings.

**Re-register failed and now I have an extra webhook on Fathom's side**
Older plugin versions could crash mid-Connect and leave the webhook registered on Fathom but invisible to the plugin (orphan). Fathom does not expose `GET /webhooks` to list them, but the plugin's Connect-failure log line includes the orphan ID. Copy that ID into the **Purge orphan webhook** field at the bottom of the Webhook intake section and click Delete. Newer versions roll back automatically on partial failure.

---

## Rotating the bearer token

If you suspect the bearer token leaked:
1. Generate a new random string in a private terminal (see Step 2's commands).
2. Cloudflare → Worker → Settings → Environment secrets → edit `PLUGIN_BEARER_TOKEN`.
3. Plugin settings → Bearer token → paste new value → Test.

The webhook signing secret doesn't need rotating — Fathom controls it and it's scoped to one webhook only. To rotate anyway, click Re-register in plugin settings: it deletes the old webhook, creates a new one, and shows you a fresh secret to paste into Cloudflare.

---

## Removing webhook intake

1. Plugin settings → **Source** → `Disabled (polling only)`.
2. Plugin settings → click **Re-register** then immediately change Source to Disabled — this leaves the Fathom-side webhook orphaned but at least the plugin stops trying to drain.
3. To clean up the orphan on Fathom: use **Purge orphan webhook** with the ID from your plugin's `data.json` (`registeredWebhookId` field), or:
   ```bash
   curl -X DELETE https://api.fathom.ai/external/v1/webhooks/<id> \
     -H "X-Api-Key: <your-token>"
   ```
4. Optionally delete the Worker from Cloudflare to free the `*.workers.dev` subdomain.
