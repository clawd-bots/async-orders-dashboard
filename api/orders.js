// Fetch Shopify orders tagged "async"
export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!storeUrl || !accessToken) {
    return res.status(400).json({ 
      error: 'Shopify API not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in Vercel.' 
    });
  }

  try {
    // Shopify Admin API - fetch orders with tag "async"
    // Get orders from the last 30 days by default
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const url = `https://${storeUrl}/admin/api/2024-01/orders.json?status=any&created_at_min=${thirtyDaysAgo.toISOString()}&limit=250`;
    
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Shopify API error:', error);
      return res.status(response.status).json({ 
        error: `Shopify API error: ${response.status}` 
      });
    }

    const data = await response.json();
    
    // Filter orders that have the "async" tag (case-insensitive)
    const asyncOrders = (data.orders || []).filter(order => {
      const tags = (order.tags || '').toLowerCase().split(',').map(t => t.trim());
      return tags.includes('async');
    });

    // Sort by created_at descending (newest first)
    asyncOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ 
      orders: asyncOrders,
      total: asyncOrders.length,
      fetchedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
}
