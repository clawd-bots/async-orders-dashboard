// Daily cron job - triggered by Vercel Cron
// Sends the async orders email every day at 8:00 AM PHT

export const config = {
  runtime: 'edge', // Optional: use edge for faster cold starts
};

export default async function handler(req) {
  // Verify this is a cron request (Vercel adds this header)
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow if no CRON_SECRET is set (for testing) or if it matches
    if (process.env.CRON_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const agentmailApiKey = process.env.AGENTMAIL_API_KEY;
  
  if (!storeUrl || !accessToken || !agentmailApiKey) {
    return new Response(JSON.stringify({ 
      error: 'Missing configuration',
      shopify: !!(storeUrl && accessToken),
      email: !!agentmailApiKey
    }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Fetch yesterday's async orders
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const url = `https://${storeUrl}/admin/api/2024-01/orders.json?status=any&created_at_min=${oneDayAgo.toISOString()}&limit=250`;
    
    const shopifyRes = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    if (!shopifyRes.ok) {
      throw new Error(`Shopify API error: ${shopifyRes.status}`);
    }

    const data = await shopifyRes.json();
    
    // Filter for "async" tag
    const asyncOrders = (data.orders || []).filter(order => {
      const tags = (order.tags || '').toLowerCase().split(',').map(t => t.trim());
      return tags.includes('async');
    });

    // Skip email if no orders
    if (asyncOrders.length === 0) {
      return new Response(JSON.stringify({ 
        message: 'No async orders today',
        orderCount: 0 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Build HTML email
    const tableRows = asyncOrders.map(order => {
      const items = (order.line_items || [])
        .map(i => `${i.quantity}× ${i.title}`)
        .join('<br>');
      return `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">${order.name}</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${items}</td>
        </tr>
      `;
    }).join('');

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #AF6E4C;">Daily Async Orders Report</h2>
        <p>Good morning! Here are yesterday's orders tagged "async":</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background: #f5f5f5;">
              <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Order #</th>
              <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Items</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
        
        <p style="color: #666; font-size: 14px;">
          Total: ${asyncOrders.length} order(s)
        </p>
        
        <p style="margin-top: 20px;">
          <a href="https://shopify-async-orders.vercel.app" style="color: #AF6E4C;">View Dashboard →</a>
        </p>
      </div>
    `;

    // Send via AgentMail
    const emailRes = await fetch('https://api.agentmail.to/v0/inboxes/edwin@mail.andyou.ph/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentmailApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [{ email: 'wesley@andyou.ph' }],
        subject: `[Async Orders] ${asyncOrders.length} order(s) - ${new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}`,
        body_html: htmlBody
      })
    });

    if (!emailRes.ok) {
      throw new Error(`Email failed: ${await emailRes.text()}`);
    }

    return new Response(JSON.stringify({ 
      success: true,
      message: `Email sent with ${asyncOrders.length} order(s)`,
      orderCount: asyncOrders.length 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Cron error:', error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
