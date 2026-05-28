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
    const graphqlUrl = `https://${storeUrl}/admin/api/2025-01/graphql.json`;

    // Paginate ALL orders (admin portal does this too)
    let allOrders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const query = `
        {
          orders(first: 250, sortKey: CREATED_AT, reverse: true, query: "fulfillment_status:unfulfilled financial_status:paid"${cursor ? `, after: "${cursor}"` : ''}) {
            pageInfo {
              hasNextPage
              endCursor
            }
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
                tags
                customer {
                  firstName
                  lastName
                  email
                  numberOfOrders
                }
                shippingAddress {
                  phone
                  address1
                  address2
                  city
                  province
                  zip
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
                upsellMetafield: metafield(namespace: "custom", key: "upsell") {
                  value
                }
                upsellPaidMetafield: metafield(namespace: "custom", key: "upsell_paid") {
                  value
                  updatedAt
                }
                refundRequiredMetafield: metafield(namespace: "custom", key: "refund_required") {
                  value
                }
                consultationDateMetafield: metafield(namespace: "custom", key: "consultation_date") {
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

      const pageOrders = data.data?.orders?.edges || [];
      allOrders = allOrders.concat(pageOrders);

      hasNextPage = data.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = data.data?.orders?.pageInfo?.endCursor || null;
    }

    const parseBool = (val) => {
      const v = (val || '').toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') return true;
      if (v === 'false' || v === '0' || v === 'no') return false;
      return null;
    };

    // Process all orders, exclude Keevtest and manually refunded
    const filteredOrders = allOrders
      .filter(edge => {
        const discountCodes = edge.node.discountCodes || [];
        const hasKeevtest = discountCodes.some(code =>
          code?.toLowerCase?.().includes('keevtest')
        );
        if (hasKeevtest) return false;

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
        const preferredDelivery = parseBool(pdVal);

        const upsellVal = node.upsellMetafield?.value?.toLowerCase?.() || '';
        const upsellPaidVal = node.upsellPaidMetafield?.value?.toLowerCase?.() || '';
        const upsellPaid = parseBool(upsellPaidVal);
        const upsellPaidIsTrue = upsellPaidVal === 'true' || upsellPaidVal === '1' || upsellPaidVal === 'yes';

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
          upsell: parseBool(upsellVal),
          upsell_paid: upsellPaid,
          upsell_paid_at: upsellPaidIsTrue ? (node.upsellPaidMetafield?.updatedAt || null) : null,
          refund_required: parseBool(node.refundRequiredMetafield?.value),
          consultation_date: node.consultationDateMetafield?.value || null,
          tags: node.tags || [],
          customer: {
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            email: node.customer?.email
          },
          customer_type: node.customer ? (parseInt(node.customer.numberOfOrders, 10) > 1 ? 'RETURNING' : 'NEW') : 'NEW',
          shipping_address: node.shippingAddress ? {
            phone: node.shippingAddress.phone || '',
            address1: node.shippingAddress.address1 || '',
            address2: node.shippingAddress.address2 || '',
            city: node.shippingAddress.city || '',
            province: node.shippingAddress.province || '',
            zip: node.shippingAddress.zip || '',
          } : null,
          is_provincial: (node.tags || []).some(t => t.toLowerCase() === 'provincial'),
          line_items: (node.lineItems?.edges?.map(e => ({
            title: e.node.variantTitle && e.node.variantTitle !== 'Default Title' ? `${e.node.title} — ${e.node.variantTitle}` : e.node.title,
            quantity: e.node.fulfillableQuantity ?? e.node.quantity,
            sku: e.node.sku || '',
            fulfillable_quantity: e.node.fulfillableQuantity ?? e.node.quantity
          })) || []).filter(li => li.fulfillable_quantity > 0)
        };
      });

    // Overdue logic — matches admin portal exactly
    const isOrderOverdue = (order) => {
      const cs = (order.consultation_status || '').toLowerCase();
      if (cs === 'scheduled' || cs.includes('"scheduled"')) return false;

      const now = new Date();
      const phtNow = new Date(now.getTime() + 8 * 3600000);
      const phtDay = phtNow.getUTCDay();

      if (order.preferred_delivery_date) {
        const yesterday = new Date(phtNow);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        return order.preferred_delivery_date < yesterdayStr;
      }

      let startTime;
      if (order.upsell === true || order.upsell_paid === true) {
        if (!order.upsell_paid) return false;
        startTime = new Date(order.upsell_paid_at);
      } else {
        if (!order.approved_at) return false;
        startTime = new Date(order.approved_at);
      }

      const prevBizDayOffset = phtDay === 1 ? 2 : 1;
      const year = phtNow.getUTCFullYear();
      const month = phtNow.getUTCMonth();
      const day = phtNow.getUTCDate();
      const todayCutoff = new Date(Date.UTC(year, month, day, 7, 30, 0) - 8 * 3600000);
      const yesterdayCutoff = new Date(todayCutoff.getTime() - prevBizDayOffset * 86400000);

      return startTime < yesterdayCutoff;
    };

    // Approved: approved AND (no upsell needed OR upsell is paid) — matches admin portal
    const approvedOrders = filteredOrders
      .filter(o => {
        if (o.approved_to_ship !== true) return false;
        if (o.upsell === true || o.upsell_paid === true) return o.upsell_paid === true;
        return true;
      })
      .map(o => ({ ...o, overdue: isOrderOverdue(o) }));

    // Awaiting upsell: approved AND (upsell flagged OR upsell_paid is false) AND not yet paid
    const awaitingUpsellOrders = filteredOrders
      .filter(o => o.approved_to_ship === true && (o.upsell === true || o.upsell_paid === false) && o.upsell_paid !== true);

    const refundRequiredOrders = filteredOrders
      .filter(o => o.refund_required === true);

    // Not approved: only explicitly false (not null/blank) — matches admin portal
    const notApprovedOrders = filteredOrders.filter(o => {
      if (o.approved_to_ship !== false) return false;
      const ps = o.prescription_status || '';
      if (ps.toLowerCase().includes('on hold') || ps.toLowerCase().includes('on_hold')) return false;
      return true;
    });

    // Generate CSV content
    const generateCSV = (orders) => {
      const headers = ['Order Number', 'Customer Type', 'Date', 'Customer', 'Phone', 'Product', 'SKU', 'Qty', 'Shipping Address', 'Province', 'City', 'Barangay', 'Delivery Date', 'Next Consult Date', 'Approved On', 'Overdue', 'Shipped'];
      const rows = orders.flatMap(o =>
        (o.line_items?.length > 0 ? o.line_items : [{ title: '', sku: '', quantity: 0 }]).flatMap(item =>
          Array.from({ length: Math.max(item.quantity || 1, 1) }, () => [
            o.name,
            o.customer_type || 'NEW',
            new Date(o.created_at).toLocaleDateString('en-PH'),
            `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim() || 'Guest',
            o.shipping_address?.phone || '',
            item.title || '',
            item.sku || '',
            1,
            o.shipping_address ? `${o.shipping_address.address1 || ''}${o.shipping_address.address2 ? ', ' + o.shipping_address.address2 : ''}` : '',
            o.shipping_address?.province || '',
            o.shipping_address?.city || '',
            o.shipping_address?.address2 || '',
            o.preferred_delivery_date || '',
            o.consultation_date || '',
            o.approved_at ? new Date(o.approved_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '',
            o.overdue ? 'Yes' : 'No',
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

    const overdueOrders = approvedOrders.filter(o => o.overdue);
    const awaitingUpsellValue = awaitingUpsellOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    // Count old orders (3+ days) that DON'T have a scheduled delivery date
    const oldApprovedOrders = approvedOrders.filter(o => {
      const days = Math.floor((new Date() - new Date(o.created_at)) / (1000 * 60 * 60 * 24));
      return days >= 3 && !o.preferred_delivery_date;
    });

    // Build friendly email message
    let emailBody = `Hi team! 👋\n\n`;
    emailBody += `Here's your daily fulfillment update for ${todayFormatted}.\n\n`;

    if (overdueOrders.length > 0) {
      emailBody += `🚨 **OVERDUE: ${overdueOrders.length} order(s) past their fulfillment cutoff!**\n\n`;
    }

    emailBody += `📦 **Ready to Ship (Approved)**\n`;
    emailBody += `   ${approvedOrders.length} orders · PHP ${approvedValue.toLocaleString()} · ${approvedItems} items\n\n`;

    emailBody += `⏳ **Pending Approval**\n`;
    emailBody += `   ${notApprovedOrders.length} orders · PHP ${notApprovedValue.toLocaleString()} · ${notApprovedItems} items\n\n`;

    if (awaitingUpsellOrders.length > 0) {
      emailBody += `💰 **Awaiting Upsell Payment**\n`;
      emailBody += `   ${awaitingUpsellOrders.length} orders · PHP ${awaitingUpsellValue.toLocaleString()}\n\n`;
    }

    if (refundRequiredOrders.length > 0) {
      emailBody += `🔄 **Refund Required**\n`;
      refundRequiredOrders.forEach(o => {
        const name = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim() || 'Guest';
        emailBody += `   • ${o.name} — ${name}\n`;
      });
      emailBody += `\n`;
    }

    const newCustomerCount = filteredOrders.filter(o => o.customer_type === 'NEW').length;
    const returningCustomerCount = filteredOrders.filter(o => o.customer_type === 'RETURNING').length;
    emailBody += `👤 **Customer Breakdown**\n`;
    emailBody += `   ${newCustomerCount} NEW · ${returningCustomerCount} RETURNING\n\n`;

    if (oldApprovedOrders.length > 0) {
      emailBody += `⚠️ Heads up: ${oldApprovedOrders.length} approved order(s) are 3+ days old and need attention!\n\n`;
    }

    if (approvedOrders.length === 0) {
      emailBody += `Great news — all approved orders have been fulfilled! 🎉\n\n`;
    }

    emailBody += `I've attached ${awaitingUpsellOrders.length > 0 ? 'three' : 'two'} CSV files with the full details:\n`;
    emailBody += `• ATS_${dateStr}.csv — Approved orders ready to ship\n`;
    emailBody += `• NOT_APPROVED_${dateStr}.csv — Orders pending approval\n`;
    if (awaitingUpsellOrders.length > 0) {
      emailBody += `• AWAITING_UPSELL_${dateStr}.csv — Orders awaiting upsell payment\n`;
    }
    emailBody += `\n`;

    emailBody += `Let me know if you need anything else!\n\n`;
    emailBody += `— Edwin 🎩`;

    // Send via AgentMail
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
          subject: overdueOrders.length > 0
            ? `🚨 ${overdueOrders.length} OVERDUE | 📦 ${approvedOrders.length} ready to ship, ${notApprovedOrders.length} pending`
            : `📦 Daily Fulfillment Report — ${approvedOrders.length} ready to ship, ${notApprovedOrders.length} pending`,
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
            },
            ...(awaitingUpsellOrders.length > 0 ? [{
              filename: `AWAITING_UPSELL_${dateStr}.csv`,
              content: btoa(unescape(encodeURIComponent(generateCSV(awaitingUpsellOrders)))),
              content_type: 'text/csv'
            }] : [])
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
      message: `Email sent with ${awaitingUpsellOrders.length > 0 ? 3 : 2} CSV attachments! ${approvedOrders.length} approved, ${notApprovedOrders.length} pending. Fetched ${allOrders.length} total orders.`,
      approved: approvedOrders.length,
      notApproved: notApprovedOrders.length,
      awaitingUpsell: awaitingUpsellOrders.length,
      overdueCount: overdueOrders.length,
      totalOrdersFetched: allOrders.length
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}
