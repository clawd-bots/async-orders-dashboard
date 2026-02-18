# Shopify Async Orders Dashboard

Daily email of Shopify orders tagged "async" to wesley@andyou.ph

## Features
- 📊 Dashboard to view async orders
- 📧 Manual email trigger
- ⬇️ CSV download
- ⏰ Daily automated email at 8:00 AM PHT

## Setup

### 1. Deploy to Vercel
```bash
vercel --prod
```

### 2. Configure Environment Variables in Vercel Dashboard

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_URL` | Your store URL (e.g., `andyou-ph.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Admin API access token |
| `AGENTMAIL_API_KEY` | AgentMail API key for sending emails |
| `CRON_SECRET` | (Optional) Secret for cron endpoint auth |

### 3. Create Shopify Private App
1. Go to Shopify Admin → Settings → Apps → Develop apps
2. Create a new app
3. Configure Admin API scopes: `read_orders`
4. Install and copy the access token

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Check if API is configured |
| `/api/orders` | GET | Fetch async orders (last 30 days) |
| `/api/send-email` | POST | Send email manually |
| `/api/cron` | GET | Daily cron job (8 AM PHT) |

## Cron Schedule
- Runs daily at 00:00 UTC (8:00 AM PHT)
- Sends email only if there are async orders from the last 24 hours
