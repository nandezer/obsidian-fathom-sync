# Webhook intake (v2.0)

The polling sync built into v1 only sees meetings you recorded yourself. To also pick up **meetings shared with you** — by teammates, by clients, by external people who send you a Fathom share link — the plugin can subscribe to Fathom's webhook stream.

This page is the setup walkthrough. Estimated time: **~5 minutes, mostly waiting for Cloudflare**.

---

## How it works

```
Fathom ──POSTs webhook──► Your Cloudflare Worker ──serves /pending──► Plugin polls ──► Vault note
```

You run a small (~150 LOC) Cloudflare Worker. It:
- receives webhook POSTs from Fathom
- verifies the signature
- stashes the payload in KV (free tier)
- exposes a bearer-auth `GET /pending` for the plugin to poll

Cloudflare Workers' free tier covers 100,000 requests/day. For typical use (a few meetings a day) you'll use < 100 requests/day.

---

## Setup

### 1. Deploy the Worker

Click the **Deploy to Cloudflare** button below. Cloudflare will fork the Worker repo into your GitHub account and walk you through a 3-screen deploy in your Cloudflare dashboard.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nandezer/obsidian-fathom-sync/tree/main/worker)

When prompted by Cloudflare, set two variables:
- `PLUGIN_BEARER_TOKEN` — generate a random string (e.g. `openssl rand -hex 32`). The plugin will paste this in the `Authorization: Bearer …` header.
- `FATHOM_WEBHOOK_SECRET` — leave blank or set to a placeholder for now; you'll fill it in at step 3.

At the end of deploy you'll get a URL like `https://obsidian-fathom-sync.<your-subdomain>.workers.dev`. Copy it.

### 2. Connect the plugin

In Obsidian:
1. Open Fathom Sync settings.
2. **Webhook intake → Source** → `HTTP (Cloudflare Worker)`.
3. Paste the Worker URL into **Worker URL**.
4. Paste the bearer token you generated into **Bearer token**.
5. Click **Test** — should toast `Worker OK (0 pending deliveries)`.
6. Click **Connect** — the plugin will register a webhook with Fathom pointing at your Worker.

A long-lived toast will appear with a **signing secret**:
```
Fathom Sync: webhook registered (abc12345…).
Signing secret: whsec_xxxxxxxxxxxxxxxxxx — paste this into your Worker's
FATHOM_WEBHOOK_SECRET variable.
```

**Copy that secret immediately — Fathom only returns it once.**

### 3. Tell the Worker the signing secret

Cloudflare dashboard → your Worker → **Settings → Variables and Secrets**:
- Edit `FATHOM_WEBHOOK_SECRET`
- Paste the `whsec_…` value from step 2
- Save & deploy

Done.

---

## Verifying it works

1. In Fathom, record any new meeting (or ask a teammate to share one with you).
2. Wait for Fathom to finish processing (usually 1–2 minutes after the call ends).
3. The next plugin sync (manual ribbon click or periodic tick) will pull the delivery and write the note.

You can also watch the Worker logs in real time: Cloudflare dashboard → Worker → Logs.

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

**"Worker test failed: 401 unauthorized"**
The bearer token in the plugin doesn't match the one in the Worker. Re-check both, save the plugin setting, hit Test again.

**Webhook arrives but plugin reports "0 pending deliveries"**
The Worker is rejecting the signature. Check Worker logs — most likely `FATHOM_WEBHOOK_SECRET` doesn't match the secret Fathom returned in step 2. Re-paste it in Cloudflare.

**Plugin says "webhook registration failed: invalid API token"**
Your Fathom API token is wrong or expired. Open Fathom → Customize → API Access and regenerate.

**Meeting was on Fathom 1+ hour ago and still hasn't synced**
- Check Cloudflare Worker logs — did the webhook arrive?
- Check Obsidian console (Ctrl+Shift+I, filter `[Fathom Sync]`) — did the drain run?
- If the webhook didn't arrive, double-check the webhook URL in the plugin → Re-register button.

---

## Rotating the bearer token

If you suspect the bearer token leaked:
1. Generate a new random string.
2. Cloudflare → Worker → Variables → update `PLUGIN_BEARER_TOKEN`.
3. Plugin settings → Bearer token → paste new value → save.

The webhook signing secret doesn't need rotating — Fathom controls it and it's already scoped to one webhook.

---

## Removing webhook intake

1. Plugin settings → **Source** → `Disabled (polling only)`.
2. To also remove the Fathom-side webhook, re-enable HTTP source briefly and click **Re-register**, then disable again. Or call Fathom's API directly:
   ```bash
   curl -X DELETE https://api.fathom.ai/external/v1/webhooks/<id> \
     -H "X-Api-Key: <your-token>"
   ```
3. Optionally delete the Worker from Cloudflare to free the subdomain.
