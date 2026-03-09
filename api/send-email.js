// Send daily fulfillment report email with CSV attachments
export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const agentmailKey = process.env.AGENTMAIL_API_KEY;

  if (!storeUrl || !accessToken) {
    return res.status(400).json({ error: 'Shopify API not configured' });
  }

  if (!agentmailKey) {
    return res.status(400).json({ error: 'AgentMail API not configured' });
  }

  try {
    // Use GraphQL to fetch orders
    const graphqlUrl = `https://${storeUrl}/admin/api/2024-01/graphql.json`;
    
    const query = `
      {
        orders(first: 250, sortKey: CREATED_AT, reverse: true, query: "fulfillment_status:unfulfilled financial_status:paid") {
          edges {
            node {
              id
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                firstName
                lastName
                email
              }
              lineItems(first: 10) {
                edges {
                  node {
                    title
                    variantTitle
                    quantity
                    sku
                    fulfillableQuantity
                  }
                }
              }
              metafield(namespace: "custom", key: "approved_to_ship") {
                value
                updatedAt
              }
              preferredDeliveryMetafield: metafield(namespace: "custom", key: "preferred_delivery") {
                value
              }
              preferredDeliveryDateMetafield: metafield(namespace: "custom", key: "preferred_delivery_data") {
                value
              }
              prescriptionStatusMetafield: metafield(namespace: "custom", key: "prescription_status") {
                value
              }
              consultationStatusMetafield: metafield(namespace: "custom", key: "consultation_status") {
                value
                updatedAt
              }
              orderStatusMetafield: metafield(namespace: "custom", key: "order_status") {
                value
              }
              discountCodes
            }
          }
        }
      }
    `;

    const shopifyRes = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    if (!shopifyRes.ok) {
      throw new Error(`Shopify API error: ${shopifyRes.status}`);
    }

    const data = await shopifyRes.json();
    
    if (data.errors) {
      throw new Error(data.errors[0]?.message || 'GraphQL error');
    }

    // Process all orders, exclude Keevtest
    const allOrders = data.data?.orders?.edges || [];
    const filteredOrders = allOrders
      .filter(edge => {
        const discountCodes = edge.node.discountCodes || [];
        const hasKeevtest = discountCodes.some(code => 
          code?.toLowerCase?.().includes('keevtest')
        );
        if (hasKeevtest) return false;
        
        // Exclude orders with Order Status = "Manually Refunded"
        const orderStatus = edge.node.orderStatusMetafield?.value?.toLowerCase?.() || '';
        if (orderStatus.includes('manually refunded')) return false;
        
        return true;
      })
      .map(edge => {
        const node = edge.node;
        const metafield = node.metafield;
        const val = metafield?.value?.toLowerCase?.() || '';
        let approvedToShip = null;
        if (val === 'true' || val === '1' || val === 'yes') approvedToShip = true;
        else if (val === 'false' || val === '0' || val === 'no') approvedToShip = false;
        const approvedAt = approvedToShip === true ? (metafield?.updatedAt || null) : null;
        
        const pdVal = node.preferredDeliveryMetafield?.value?.toLowerCase?.() || '';
        let preferredDelivery = null;
        if (pdVal === 'true' || pdVal === '1' || pdVal === 'yes') preferredDelivery = true;
        else if (pdVal === 'false' || pdVal === '0' || pdVal === 'no') preferredDelivery = false;

        return {
          name: node.name,
          created_at: node.createdAt,
          total_price: node.totalPriceSet?.shopMoney?.amount,
          currency: node.totalPriceSet?.shopMoney?.currencyCode,
          approved_to_ship: approvedToShip,
          approved_at: approvedAt,
          preferred_delivery: preferredDelivery,
          preferred_delivery_date: node.preferredDeliveryDateMetafield?.value || null,
          prescription_status: node.prescriptionStatusMetafield?.value || null,
          consultation_status: (() => {
            try {
              const raw = node.consultationStatusMetafield?.value;
              if (!raw) return null;
              const parsed = JSON.parse(raw);
              return Array.isArray(parsed) ? parsed[0] : parsed;
            } catch { return node.consultationStatusMetafield?.value || null; }
          })(),
          consultation_status_updated_at: node.consultationStatusMetafield?.updatedAt || null,
          customer: {
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            email: node.customer?.email
          },
          line_items: (node.lineItems?.edges?.map(e => ({
            title: e.node.variantTitle && e.node.variantTitle !== 'Default Title' ? `${e.node.title} — ${e.node.variantTitle}` : e.node.title,
            quantity: e.node.fulfillableQuantity ?? e.node.quantity,
            sku: e.node.sku || '',
            fulfillable_quantity: e.node.fulfillableQuantity ?? e.node.quantity
          })) || []).filter(li => li.fulfillable_quantity > 0)
        };
      });

    // Split into approved and not approved (explicitly false only, exclude blanks)
    const approvedOrders = filteredOrders.filter(o => o.approved_to_ship === true);
    const notApprovedOrders = filteredOrders.filter(o => {
      if (o.approved_to_ship !== false) return false;
      const ps = o.prescription_status || '';
      if (ps.toLowerCase().includes('on hold') || ps.toLowerCase().includes('on_hold')) return false;
      return true;
    });

    // Generate CSV content
    const generateCSV = (orders) => {
      const headers = ['Order Number', 'Date', 'Customer', 'Email', 'Product', 'SKU', 'Qty', 'Preferred Delivery', 'Delivery Date', 'Approved On', 'Total', 'Shipped'];
      const rows = orders.flatMap(o => 
        (o.line_items?.length > 0 ? o.line_items : [{ title: '', sku: '', quantity: 0 }]).flatMap(item =>
          Array.from({ length: Math.max(item.quantity || 1, 1) }, () => [
            o.name,
            new Date(o.created_at).toLocaleDateString('en-PH'),
            `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim() || 'Guest',
            o.customer?.email || '',
            item.title || '',
            item.sku || '',
            1,
            o.preferred_delivery === true ? 'Yes' : o.preferred_delivery === false ? 'No' : '',
            o.preferred_delivery_date || '',
            o.approved_at ? new Date(o.approved_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '',
            `${o.currency} ${parseFloat(o.total_price || 0).toLocaleString()}`,
            'No'
          ])
        )
      );
      
      return [headers, ...rows]
        .map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(','))
        .join('\n');
    };

    const approvedCSV = generateCSV(approvedOrders);
    const notApprovedCSV = generateCSV(notApprovedOrders);

    // Date for filenames
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const todayFormatted = new Date().toLocaleDateString('en-PH', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });

    // Calculate totals for approved
    const approvedValue = approvedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const approvedItems = approvedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);

    // Calculate totals for not approved  
    const notApprovedValue = notApprovedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const notApprovedItems = notApprovedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);

    // Count old orders (3+ days) that DON'T have a scheduled delivery date
    const oldApprovedOrders = approvedOrders.filter(o => {
      const days = Math.floor((new Date() - new Date(o.created_at)) / (1000 * 60 * 60 * 24));
      return days >= 3 && !o.preferred_delivery_date;
    });

    // Build friendly email message
    let emailBody = `Hi team! 👋\n\n`;
    emailBody += `Here's your daily fulfillment update for ${todayFormatted}.\n\n`;
    
    emailBody += `📦 **Ready to Ship (Approved)**\n`;
    emailBody += `   ${approvedOrders.length} orders · PHP ${approvedValue.toLocaleString()} · ${approvedItems} items\n\n`;
    
    emailBody += `⏳ **Pending Approval**\n`;
    emailBody += `   ${notApprovedOrders.length} orders · PHP ${notApprovedValue.toLocaleString()} · ${notApprovedItems} items\n\n`;

    if (oldApprovedOrders.length > 0) {
      emailBody += `⚠️ Heads up: ${oldApprovedOrders.length} approved order(s) are 3+ days old and need attention!\n\n`;
    }

    if (approvedOrders.length === 0) {
      emailBody += `Great news — all approved orders have been fulfilled! 🎉\n\n`;
    }

    emailBody += `I've attached two CSV files with the full details:\n`;
    emailBody += `• ATS_${dateStr}.csv — Approved orders ready to ship\n`;
    emailBody += `• NOT_APPROVED_${dateStr}.csv — Orders pending approval\n\n`;
    
    emailBody += `Let me know if you need anything else!\n\n`;
    emailBody += `— Edwin 🎩`;

    // Send via AgentMail - using inboxes/messages endpoint for attachment support
    let emailRes;
    try {
      emailRes = await fetch('https://api.agentmail.to/v0/inboxes/edwin@mail.andyou.ph/messages/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${agentmailKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: ['andrea@andyou.ph', 'karell@andyou.ph', 'bryan_bumanglag@andyou.ph'],
          cc: ['wesley@andyou.ph'],
          subject: `📦 Daily Fulfillment Report — ${approvedOrders.length} ready to ship, ${notApprovedOrders.length} pending`,
          text: emailBody,
          attachments: [
            {
              filename: `ATS_${dateStr}.csv`,
              content: btoa(unescape(encodeURIComponent(approvedCSV))),
              content_type: 'text/csv'
            },
            {
              filename: `NOT_APPROVED_${dateStr}.csv`,
              content: btoa(unescape(encodeURIComponent(notApprovedCSV))),
              content_type: 'text/csv'
            }
          ]
        })
      });
    } catch (fetchErr) {
      console.error('Fetch error:', fetchErr);
      throw new Error(`Email API fetch failed: ${fetchErr.message}`);
    }

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('Email API error response:', err);
      throw new Error(`Email send failed (${emailRes.status}): ${err}`);
    }

    res.json({ 
      success: true, 
      message: `Email sent with 2 CSV attachments! ${approvedOrders.length} approved, ${notApprovedOrders.length} pending.`,
      approved: approvedOrders.length,
      notApproved: notApprovedOrders.length
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}
