// Send email with async orders to Wesley
// Uses AgentMail API (edwin@mail.andyou.ph)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const agentmailApiKey = process.env.AGENTMAIL_API_KEY;
  
  if (!storeUrl || !accessToken) {
    return res.status(400).json({ 
      error: 'Shopify API not configured' 
    });
  }

  if (!agentmailApiKey) {
    return res.status(400).json({ 
      error: 'AgentMail API key not configured' 
    });
  }

  try {
    // Fetch async orders (today's orders or last 24h)
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
      return res.status(500).json({ error: 'Failed to fetch Shopify orders' });
    }

    const data = await shopifyRes.json();
    
    // Filter for "async" tag
    const asyncOrders = (data.orders || []).filter(order => {
      const tags = (order.tags || '').toLowerCase().split(',').map(t => t.trim());
      return tags.includes('async');
    });

    if (asyncOrders.length === 0) {
      return res.json({ 
        message: 'No async orders in the last 24 hours. No email sent.',
        orderCount: 0 
      });
    }

    // Build HTML table
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
        <h2 style="color: #AF6E4C;">Async Orders Report</h2>
        <p>Here are the orders tagged "async" from the last 24 hours:</p>
        
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
          Total: ${asyncOrders.length} order(s)<br>
          Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
        </p>
        
        <p style="margin-top: 20px;">
          <a href="https://shopify-async-orders.vercel.app" style="color: #AF6E4C;">View Dashboard →</a>
        </p>
      </div>
    `;

    const textBody = `Async Orders Report\n\n` +
      asyncOrders.map(o => 
        `${o.name}: ${(o.line_items || []).map(i => `${i.quantity}× ${i.title}`).join(', ')}`
      ).join('\n') +
      `\n\nTotal: ${asyncOrders.length} order(s)`;

    // Send via AgentMail API
    const emailRes = await fetch('https://api.agentmail.to/v0/inboxes/edwin@mail.andyou.ph/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentmailApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: [{ email: 'wesley@andyou.ph' }],
        subject: `[Async Orders] ${asyncOrders.length} order(s) - ${new Date().toLocaleDateString('en-PH')}`,
        body_text: textBody,
        body_html: htmlBody
      })
    });

    if (!emailRes.ok) {
      const error = await emailRes.text();
      console.error('AgentMail error:', error);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    res.json({ 
      message: `Email sent with ${asyncOrders.length} async order(s)`,
      orderCount: asyncOrders.length 
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}
