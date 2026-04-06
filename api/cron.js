// Cron endpoint for daily fulfillment report
// Triggered by Vercel Cron at 8 AM PHT (00:00 UTC)

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // Verify cron secret in production
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const agentmailKey = process.env.AGENTMAIL_API_KEY;

  if (!storeUrl || !accessToken || !agentmailKey) {
    return new Response(JSON.stringify({ error: 'Missing configuration' }), { 
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Use GraphQL to fetch orders with metafields (same as orders.js)
    const graphqlUrl = `https://${storeUrl}/admin/api/2024-01/graphql.json`;
    
    // Fetch ALL orders using cursor-based pagination
    let allOrders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const query = `
        {
          orders(first: 250, sortKey: CREATED_AT, reverse: true, query: "fulfillment_status:unfulfilled financial_status:paid"${cursor ? `, after: "${cursor}"` : ""}) {
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
                customer {
                  firstName
                  lastName
                  email
                  numberOfOrders
                }
                lineItems(first: 10) {
                  edges {
                    node {
                      title
                      quantity
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
                preferredDeliveryDateMetafield: metafield(namespace: "custom", key: "preferred_delivery_date") {
                  value
                }
                prescriptionStatusMetafield: metafield(namespace: "custom", key: "prescription_status") {
                  value
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

      if (!response.ok) {
        throw new Error(`Shopify API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.errors) {
        throw new Error(`GraphQL error: ${data.errors[0]?.message}`);
      }

      const pageOrders = data.data?.orders?.edges || [];
      allOrders = allOrders.concat(pageOrders);
      
      hasNextPage = data.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = data.data?.orders?.pageInfo?.endCursor || null;
    }

    // Filter out Keevtest discount codes and process orders
    const filteredOrders = allOrders
      .filter(edge => {
        // Exclude orders with Keevtest discount code
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
        
        // Three states: true (approved), false (explicitly not approved), null (empty/not set)
        let approvedToShip = null;
        if (val === 'true' || val === '1' || val === 'yes') {
          approvedToShip = true;
        } else if (val === 'false' || val === '0' || val === 'no') {
          approvedToShip = false;
        }
        
        // Parse preferred delivery metafield (True/False/Blank)
        const preferredDeliveryVal = node.preferredDeliveryMetafield?.value?.toLowerCase?.() || '';
        let preferredDelivery = null;
        if (preferredDeliveryVal === 'true' || preferredDeliveryVal === '1' || preferredDeliveryVal === 'yes') {
          preferredDelivery = true;
        } else if (preferredDeliveryVal === 'false' || preferredDeliveryVal === '0' || preferredDeliveryVal === 'no') {
          preferredDelivery = false;
        }
        
        return {
          id: node.id,
          name: node.name,
          created_at: node.createdAt,
          total_price: node.totalPriceSet?.shopMoney?.amount,
          currency: node.totalPriceSet?.shopMoney?.currencyCode,
          approved_to_ship: approvedToShip,
          approved_at: approvedToShip === true ? (metafield?.updatedAt || null) : null,
          preferred_delivery: preferredDelivery,
          preferred_delivery_date: node.preferredDeliveryDateMetafield?.value || null,
          prescription_status: node.prescriptionStatusMetafield?.value || null,
          customer: {
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            email: node.customer?.email,
            orders_count: parseInt(node.customer?.numberOfOrders || '0', 10),
          },
          customer_type: node.customer ? (parseInt(node.customer.numberOfOrders, 10) > 1 ? 'RETURNING' : 'NEW') : 'NEW',
          line_items: node.lineItems?.edges?.map(e => ({
            title: e.node.title,
            quantity: e.node.quantity
          })) || [],
          upsell: (() => {
            const v = node.upsellMetafield?.value?.toLowerCase?.() || '';
            if (v === 'true' || v === '1' || v === 'yes') return true;
            if (v === 'false' || v === '0' || v === 'no') return false;
            return null;
          })(),
          upsell_paid: (() => {
            const v = node.upsellPaidMetafield?.value?.toLowerCase?.() || '';
            if (v === 'true' || v === '1' || v === 'yes') return true;
            if (v === 'false' || v === '0' || v === 'no') return false;
            return null;
          })(),
          upsell_paid_at: (() => {
            const v = node.upsellPaidMetafield?.value?.toLowerCase?.() || '';
            return (v === 'true' || v === '1' || v === 'yes') ? (node.upsellPaidMetafield?.updatedAt || null) : null;
          })(),
        };
      });

    // Overdue helper
    const getNextCutoffAfter = (date) => {
      const d = new Date(date);
      const phtDate = new Date(d.getTime() + 8 * 3600000);
      const year = phtDate.getUTCFullYear();
      const month = phtDate.getUTCMonth();
      const day = phtDate.getUTCDate();
      const cutoff7am = new Date(Date.UTC(year, month, day, 7, 0, 0) - 8 * 3600000);
      const cutoff12pm = new Date(Date.UTC(year, month, day, 12, 0, 0) - 8 * 3600000);
      if (d < cutoff7am) return cutoff7am;
      if (d < cutoff12pm) return cutoff12pm;
      return new Date(Date.UTC(year, month, day + 1, 7, 0, 0) - 8 * 3600000);
    };

    const isOrderOverdue = (order) => {
      let startTime;
      if (order.upsell === true) {
        if (!order.upsell_paid) return false;
        startTime = new Date(order.upsell_paid_at);
      } else {
        if (!order.approved_at) return false;
        startTime = new Date(order.approved_at);
      }
      return new Date() > getNextCutoffAfter(startTime);
    };

    // Separate approved and not approved orders
    const approvedOrders = filteredOrders
      .filter(o => {
        if (o.approved_to_ship !== true) return false;
        if (o.upsell === true) return o.upsell_paid === true;
        return true;
      })
      .map(o => ({ ...o, overdue: isOrderOverdue(o) }));
    const awaitingUpsellOrders = filteredOrders
      .filter(o => o.approved_to_ship === true && o.upsell === true && o.upsell_paid !== true);
    const notApprovedOrders = filteredOrders.filter(o => o.approved_to_ship === false);
    
    // Sort by date (newest first)
    approvedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    notApprovedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Calculate summary for approved orders
    const approvedTotalValue = approvedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const approvedTotalItems = approvedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);
    
    // Calculate summary for not approved orders
    const notApprovedTotalValue = notApprovedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const notApprovedTotalItems = notApprovedOrders.reduce((sum, o) =>
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);
    const overdueOrders = approvedOrders.filter(o => o.overdue);
    const awaitingUpsellTotalValue = awaitingUpsellOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    const currency = (approvedOrders[0] || notApprovedOrders[0])?.currency || 'PHP';

    // Build email with PHT timezone
    const today = new Date().toLocaleDateString('en-PH', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Asia/Manila'
    });

    let emailBody = `Daily Fulfillment Report - ${today}\n`;
    emailBody += `${'='.repeat(50)}\n\n`;
    
    emailBody += `SUMMARY\n`;
    emailBody += `-`.repeat(30) + `\n`;
    if (overdueOrders.length > 0) {
      emailBody += `🚨 OVERDUE: ${overdueOrders.length} orders\n`;
    }
    emailBody += `Approved Orders: ${approvedOrders.length} (${currency} ${approvedTotalValue.toLocaleString()}, ${approvedTotalItems} items)\n`;
    if (awaitingUpsellOrders.length > 0) {
      emailBody += `Awaiting Upsell Payment: ${awaitingUpsellOrders.length} (${currency} ${awaitingUpsellTotalValue.toLocaleString()})\n`;
    }
    emailBody += `Not Approved Orders: ${notApprovedOrders.length} (${currency} ${notApprovedTotalValue.toLocaleString()}, ${notApprovedTotalItems} items)\n`;
    emailBody += `Total Pending: ${approvedOrders.length + awaitingUpsellOrders.length + notApprovedOrders.length} orders\n\n`;

    if (approvedOrders.length === 0 && awaitingUpsellOrders.length === 0 && notApprovedOrders.length === 0) {
      emailBody += `✅ All orders have been fulfilled! Great job!\n`;
    } else {
      // OVERDUE ORDERS SECTION
      if (overdueOrders.length > 0) {
        emailBody += `🚨 OVERDUE ORDERS (${overdueOrders.length})\n`;
        emailBody += `-`.repeat(30) + `\n\n`;
        overdueOrders.forEach((order, i) => {
          const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Guest';
          const orderDate = new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
          emailBody += `${i + 1}. ${order.name} [${order.customer?.orders_count > 1 ? "RETURNING" : "NEW"}] - ${customerName}\n`;
          emailBody += `   Date: ${orderDate}\n`;
          emailBody += `   Total: ${order.currency} ${parseFloat(order.total_price).toLocaleString()}\n`;
          if (order.upsell === true) {
            emailBody += `   Upsell: Paid ✅ (${new Date(order.upsell_paid_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })})\n`;
          }
          emailBody += `   Items:\n`;
          order.line_items?.forEach(item => {
            emailBody += `     - ${item.quantity}× ${item.title}\n`;
          });
          emailBody += `\n`;
        });
      }

      // AWAITING UPSELL PAYMENT SECTION
      if (awaitingUpsellOrders.length > 0) {
        emailBody += `💰 AWAITING UPSELL PAYMENT (${awaitingUpsellOrders.length})\n`;
        emailBody += `-`.repeat(30) + `\n\n`;
        awaitingUpsellOrders.forEach((order, i) => {
          const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Guest';
          const orderDate = new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
          emailBody += `${i + 1}. ${order.name} [${order.customer?.orders_count > 1 ? "RETURNING" : "NEW"}] - ${customerName}\n`;
          emailBody += `   Date: ${orderDate}\n`;
          emailBody += `   Total: ${order.currency} ${parseFloat(order.total_price).toLocaleString()}\n`;
          emailBody += `   Upsell: Awaiting Payment ⏳\n`;
          emailBody += `   Items:\n`;
          order.line_items?.forEach(item => {
            emailBody += `     - ${item.quantity}× ${item.title}\n`;
          });
          emailBody += `\n`;
        });
      }

      // APPROVED ORDERS SECTION
      if (approvedOrders.length > 0) {
        emailBody += `✅ APPROVED ORDERS (${approvedOrders.length})\n`;
        emailBody += `-`.repeat(30) + `\n\n`;

        approvedOrders.forEach((order, i) => {
          const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Guest';
          const orderDate = new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
          const daysAgo = Math.floor((new Date() - new Date(order.created_at)) / (1000 * 60 * 60 * 24));

          emailBody += `${i + 1}. ${order.name} [${order.customer_type || 'NEW'}] - ${customerName}\n`;
          emailBody += `   Date: ${orderDate} (${daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : daysAgo + ' days ago'})\n`;
          emailBody += `   Total: ${order.currency} ${parseFloat(order.total_price).toLocaleString()}\n`;
          
          // Add new metafields for approved orders
          if (order.preferred_delivery !== null) {
            emailBody += `   Preferred Delivery: ${order.preferred_delivery ? 'Yes' : 'No'}\n`;
          }
          if (order.preferred_delivery_date) {
            const deliveryDate = new Date(order.preferred_delivery_date).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
            emailBody += `   Delivery Date: ${deliveryDate}\n`;
          }
          if (order.upsell === true) {
            emailBody += `   Upsell: Paid ✅\n`;
          }

          emailBody += `   Items:\n`;
          order.line_items?.forEach(item => {
            emailBody += `     - ${item.quantity}× ${item.title}\n`;
          });
          
          emailBody += `\n`;
        });

        // Orders older than 3 days warning for approved
        const oldApprovedOrders = approvedOrders.filter(o => {
          const days = Math.floor((new Date() - new Date(o.created_at)) / (1000 * 60 * 60 * 24));
          return days >= 3;
        });

        if (oldApprovedOrders.length > 0) {
          emailBody += `⚠️ ATTENTION: ${oldApprovedOrders.length} approved order(s) are 3+ days old and need urgent attention!\n\n`;
        }
      }

      // NOT APPROVED ORDERS SECTION
      if (notApprovedOrders.length > 0) {
        emailBody += `⏳ NOT APPROVED ORDERS (${notApprovedOrders.length})\n`;
        emailBody += `-`.repeat(30) + `\n\n`;

        notApprovedOrders.forEach((order, i) => {
          const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Guest';
          const orderDate = new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' });
          const daysAgo = Math.floor((new Date() - new Date(order.created_at)) / (1000 * 60 * 60 * 24));

          emailBody += `${i + 1}. ${order.name} [${order.customer_type || 'NEW'}] - ${customerName}\n`;
          emailBody += `   Date: ${orderDate} (${daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : daysAgo + ' days ago'})\n`;
          emailBody += `   Total: ${order.currency} ${parseFloat(order.total_price).toLocaleString()}\n`;
          
          // Add prescription status for not approved orders
          if (order.prescription_status) {
            emailBody += `   Prescription Status: ${order.prescription_status}\n`;
          }
          
          emailBody += `   Items:\n`;
          order.line_items?.forEach(item => {
            emailBody += `     - ${item.quantity}× ${item.title}\n`;
          });
          
          emailBody += `\n`;
        });
      }
    }

    emailBody += `\n---\nGenerated automatically at 8:00 AM PHT\nView dashboard: https://shopify-async-orders.vercel.app\n`;

    // Send via AgentMail with CC recipients
    const totalPendingOrders = approvedOrders.length + awaitingUpsellOrders.length + notApprovedOrders.length;
    const emailRes = await fetch('https://api.agentmail.io/v0/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${agentmailKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'edwin@mail.andyou.ph',
        to: 'wesley@andyou.ph',
        cc: ['andrea@andyou.ph', 'bryan_bumanglag@andyou.ph'],
        subject: overdueOrders.length > 0
          ? `🚨 ${overdueOrders.length} OVERDUE | 📦 ${approvedOrders.length} ready to ship, ${notApprovedOrders.length + awaitingUpsellOrders.length} pending - ${today}`
          : `📦 Daily Fulfillment Report: ${approvedOrders.length} approved, ${notApprovedOrders.length} not approved - ${today}`,
        text: emailBody
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      throw new Error(`Email send failed: ${err}`);
    }

    return new Response(JSON.stringify({ 
      success: true,
      approvedOrderCount: approvedOrders.length,
      notApprovedOrderCount: notApprovedOrders.length,
      overdueCount: overdueOrders.length,
      awaitingUpsellCount: awaitingUpsellOrders.length,
      totalOrderCount: totalPendingOrders,
      sentAt: new Date().toISOString()
    }), {
      status: 200,
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
