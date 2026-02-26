// Fetch MTD fulfilled order metrics for dashboard graphs
export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!storeUrl || !accessToken) {
    return res.status(400).json({ error: 'Shopify API not configured' });
  }

  try {
    const graphqlUrl = `https://${storeUrl}/admin/api/2024-01/graphql.json`;
    
    // Get first day of current month in PHT
    const now = new Date();
    const phtOffset = 8 * 60 * 60 * 1000;
    const phtNow = new Date(now.getTime() + phtOffset);
    const monthStart = new Date(Date.UTC(phtNow.getUTCFullYear(), phtNow.getUTCMonth(), 1) - phtOffset);
    const monthStartISO = monthStart.toISOString();

    let allOrders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const query = `
        {
          orders(first: 250, sortKey: CREATED_AT, reverse: true, query: "fulfillment_status:fulfilled created_at:>=${monthStartISO}"${cursor ? `, after: "${cursor}"` : ""}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                name
                createdAt
                tags
                fulfillments { createdAt }
                metafield(namespace: "custom", key: "approved_to_ship") {
                  value
                  updatedAt
                }
                discountCodes
              }
            }
          }
        }
      `;

      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
      const data = await response.json();
      if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');

      const edges = data.data?.orders?.edges || [];
      allOrders = allOrders.concat(edges);
      hasNextPage = data.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = data.data?.orders?.pageInfo?.endCursor || null;
    }

    // Filter out Keevtest
    const orders = allOrders
      .filter(e => {
        const dc = e.node.discountCodes || [];
        return !dc.some(c => c?.toLowerCase?.().includes('keevtest'));
      })
      .map(e => {
        const n = e.node;
        const fulfillment = n.fulfillments?.[0];
        const mf = n.metafield;
        const atsVal = mf?.value?.toLowerCase?.() || '';
        const isApproved = atsVal === 'true' || atsVal === '1' || atsVal === 'yes';
        
        return {
          name: n.name,
          created_at: n.createdAt,
          fulfilled_at: fulfillment?.createdAt || null,
          approved_at: isApproved ? (mf?.updatedAt || null) : null,
          is_provincial: (n.tags || []).some(t => t.toLowerCase() === 'provincial'),
        };
      });

    // Group fulfilled orders by day (PHT)
    const fulfilledPerDay = {};
    const provincialPerDay = {};
    const metroPerDay = {};
    const shipTimePerDay = {}; // approval-to-fulfillment hours per day

    for (const o of orders) {
      if (!o.fulfilled_at) continue;
      
      // Convert to PHT date string
      const fulDate = new Date(o.fulfilled_at);
      const phtDate = new Date(fulDate.getTime() + phtOffset);
      const dayKey = phtDate.toISOString().split('T')[0];
      
      // Count fulfilled per day (total + split)
      fulfilledPerDay[dayKey] = (fulfilledPerDay[dayKey] || 0) + 1;
      if (o.is_provincial) {
        provincialPerDay[dayKey] = (provincialPerDay[dayKey] || 0) + 1;
      } else {
        metroPerDay[dayKey] = (metroPerDay[dayKey] || 0) + 1;
      }
      
      // Calculate approval-to-fulfillment time (only if we have both timestamps)
      if (o.approved_at && o.fulfilled_at) {
        const approvedTime = new Date(o.approved_at);
        const fulfilledTime = new Date(o.fulfilled_at);
        // Only count if approval was BEFORE fulfillment (data integrity)
        if (approvedTime < fulfilledTime) {
          const hours = (fulfilledTime - approvedTime) / (1000 * 60 * 60);
          if (!shipTimePerDay[dayKey]) shipTimePerDay[dayKey] = [];
          shipTimePerDay[dayKey].push(hours);
        }
      }
    }

    // Build daily arrays for graphs
    // Generate all dates from month start to today
    const days = [];
    const startDate = new Date(Date.UTC(phtNow.getUTCFullYear(), phtNow.getUTCMonth(), 1));
    const endDate = new Date(Date.UTC(phtNow.getUTCFullYear(), phtNow.getUTCMonth(), phtNow.getUTCDate()));
    
    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().split('T')[0];
      const dayOfWeek = new Date(d.getTime() + phtOffset).getUTCDay(); // 0=Sun
      
      const shipTimes = shipTimePerDay[key] || [];
      const avgShipTime = shipTimes.length > 0 
        ? shipTimes.reduce((a, b) => a + b, 0) / shipTimes.length 
        : null;
      
      days.push({
        date: key,
        dayOfWeek,
        provincial: provincialPerDay[key] || 0,
        metro: metroPerDay[key] || 0,
        isSunday: dayOfWeek === 0,
        fulfilled: fulfilledPerDay[key] || 0,
        avgShipTimeHours: avgShipTime ? parseFloat(avgShipTime.toFixed(1)) : null,
        shipTimeSamples: shipTimes.length,
      });
    }

    res.json({
      days,
      totalFulfilled: orders.filter(o => o.fulfilled_at).length,
      monthStart: monthStartISO,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Metrics error:', error);
    res.status(500).json({ error: error.message });
  }
}
