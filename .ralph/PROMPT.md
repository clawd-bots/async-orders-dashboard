# Task: Add Upsell + Overdue Logic to Async Orders Dashboard

## Context
This is the Shopify async orders fulfillment dashboard at `clawd-bots/async-orders-dashboard`. It shows unfulfilled orders, splits them by approved/not-approved, and sends daily email reports with CSV attachments.

## Requirements

### 1. New Metafields to Fetch
Add these Shopify metafields to the GraphQL queries in ALL THREE API files (orders.js, cron.js, send-email.js):

```graphql
upsellMetafield: metafield(namespace: "custom", key: "upsell") {
  value
}
upsellPaidMetafield: metafield(namespace: "custom", key: "upsell_paid") {
  value
  updatedAt
}
```

### 2. Fulfillment List Inclusion Logic
**CRITICAL CHANGE:** An order should ONLY appear on the fulfillment list (approved section) when ALL of these are true:
- `approved_to_ship` = true
- `upsell` = true  
- `upsell_paid` = true

If `upsell` is false/null OR `upsell_paid` is false/null, the order should NOT appear in the fulfillment-ready list even if it's approved to ship. These orders should appear in a new "Awaiting Upsell Payment" section instead.

If `upsell` is false/null (no upsell needed), treat the order normally — just approved_to_ship is enough.

**Logic:**
```
if (upsell === true) {
  // Upsell order — needs upsell_paid to be true
  fulfillmentReady = approved_to_ship && upsell_paid
} else {
  // Normal order — just needs approval
  fulfillmentReady = approved_to_ship
}
```

### 3. Overdue Timer
Add an "overdue" flag based on when the upsell was paid:

**For upsell orders (upsell = true):**
- The "due date" starts from the `upsell_paid` metafield's `updatedAt` timestamp
- If the order hasn't been fulfilled by the NEXT fulfillment cutoff after `upsell_paid.updatedAt`, mark it as **OVERDUE**
- Fulfillment cutoffs are: **7:00 AM PHT** and **12:00 PM PHT** daily

**For normal orders (no upsell):**
- Keep existing behavior — overdue is based on `approved_to_ship.updatedAt`
- Same cutoff times apply

**Overdue calculation:**
```javascript
function isOverdue(order) {
  // Determine the "start" timestamp
  let startTime;
  if (order.upsell === true) {
    if (!order.upsell_paid) return false; // Not paid yet, can't be overdue
    startTime = new Date(order.upsell_paid_at); // updatedAt of upsell_paid metafield
  } else {
    startTime = new Date(order.approved_at);
  }
  
  // Find the next cutoff after startTime
  const now = new Date();
  // Cutoffs are 7 AM and 12 PM PHT (UTC+8) 
  // = 23:00 UTC (prev day) and 04:00 UTC
  
  // If current time is past the next cutoff after startTime, it's overdue
  // Simple: find all cutoffs between startTime and now. If there's at least one, it's overdue.
  const cutoffs = getCutoffsBetween(startTime, now); // 7AM and 12PM PHT
  return cutoffs.length > 0;
}
```

### 4. Dashboard UI Changes (App.jsx)
- Add an **"OVERDUE"** badge/tag (red) on overdue orders
- Show the upsell status on each order card:
  - "Upsell: Paid ✅" or "Upsell: Awaiting Payment ⏳"
- Add a new section/tab for "Awaiting Upsell Payment" orders
- Show the upsell paid date where relevant
- Add overdue count to the summary stats at top

### 5. Email Report Changes (cron.js + send-email.js)
- Add "OVERDUE" section at the TOP of the email (before approved orders)
- Include upsell payment status in order details
- CSV should include new columns: "Upsell", "Upsell Paid", "Upsell Paid Date", "Overdue"
- Email subject should mention overdue count if > 0: `🚨 X OVERDUE | 📦 Y ready to ship, Z pending`

### 6. Files to Modify
1. `api/orders.js` — Add metafields to GraphQL, add upsell/overdue processing
2. `api/cron.js` — Same GraphQL changes, add overdue section to email
3. `api/send-email.js` — Same GraphQL changes, add overdue to CSV + email body
4. `src/App.jsx` — Add overdue badges, upsell status, awaiting payment section

### Important
- Read each file carefully before editing — they have similar but NOT identical code
- The GraphQL queries in all 3 API files need the same new metafields
- Don't break existing functionality — approved/not-approved split still works the same for non-upsell orders
- Test that the overdue calculation handles timezone correctly (PHT = UTC+8)
- Preserve all existing metafields and filtering logic

## Completion
When done:
```bash
git add -A && git commit -m "feat: add upsell payment gating + overdue timer for fulfillment list

- Orders with upsell=true only appear on fulfillment list when upsell_paid=true
- Overdue timer based on upsell_paid date (not approval date) for upsell orders
- Cutoff times: 7AM and 12PM PHT
- New 'Awaiting Upsell Payment' section in dashboard
- OVERDUE badges on dashboard
- Email reports updated with overdue section + upsell columns in CSV" && git push
openclaw system event --text "Done: Async orders dashboard updated with upsell gating + overdue timer" --mode now
```
