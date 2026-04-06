// Fetch Shopify orders: Approved to ship but not fulfilled
export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!storeUrl || !accessToken) {
    return res.status(400).json({ 
      error: 'Shopify API not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in Vercel.' 
    });
  }

  try {
    // Use GraphQL to fetch orders with metafields
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
                  provinceCode
                  zip
                  country
                }
                lineItems(first: 10) {
                  edges {
                    node {
                      title
                      variantTitle
                      quantity
                      sku
                      fulfillableQuantity
                      product {
                        productType
                      }
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
                upsellMetafield: metafield(namespace: "custom", key: "upsell") {
                  value
                }
                upsellPaidMetafield: metafield(namespace: "custom", key: "upsell_paid") {
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

      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Shopify GraphQL error:', error);
        return res.status(response.status).json({ 
          error: `Shopify API error: ${response.status}` 
        });
      }

      const data = await response.json();
      
      if (data.errors) {
        console.error('GraphQL errors:', data.errors);
        return res.status(400).json({ error: data.errors[0]?.message || 'GraphQL error' });
      }

      const pageOrders = data.data?.orders?.edges || [];
      allOrders = allOrders.concat(pageOrders);
      
      hasNextPage = data.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = data.data?.orders?.pageInfo?.endCursor || null;
    }

    // Filter out Keevtest discount codes, include approved_to_ship status and new metafields
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
        // If val is empty string, approvedToShip stays null
        const approvedAt = approvedToShip === true ? (metafield?.updatedAt || null) : null;
        
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
          tags: node.tags || [],
          is_provincial: (node.tags || []).some(t => t.toLowerCase() === 'provincial'),
          customer: {
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            email: node.customer?.email,
            orders_count: parseInt(node.customer?.numberOfOrders || '0', 10),
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
          line_items: (node.lineItems?.edges?.map(e => ({
            title: e.node.variantTitle && e.node.variantTitle !== 'Default Title' ? `${e.node.title} — ${e.node.variantTitle}` : e.node.title,
            quantity: e.node.fulfillableQuantity ?? e.node.quantity,
            original_quantity: e.node.quantity,
            sku: e.node.sku || '',
            fulfillable_quantity: e.node.fulfillableQuantity ?? e.node.quantity,
            product_type: e.node.product?.productType || ''
          })) || []).filter(li => li.fulfillable_quantity > 0)
        };
      });
    
    // Overdue helper: check if any 7AM or 12PM PHT cutoff has passed since start time
    const getNextCutoffAfter = (date) => {
      const d = new Date(date);
      const phtDate = new Date(d.getTime() + 8 * 3600000); // Convert to PHT
      const year = phtDate.getUTCFullYear();
      const month = phtDate.getUTCMonth();
      const day = phtDate.getUTCDate();
      const cutoff7am = new Date(Date.UTC(year, month, day, 7, 0, 0) - 8 * 3600000);
      const cutoff12pm = new Date(Date.UTC(year, month, day, 12, 0, 0) - 8 * 3600000);
      if (d < cutoff7am) return cutoff7am;
      if (d < cutoff12pm) return cutoff12pm;
      return new Date(Date.UTC(year, month, day + 1, 7, 0, 0) - 8 * 3600000);
    };

    // Single cutoff: 7:30 AM PHT
    // Ship Today = effective date between yesterday 7:30AM and today 7:30AM
    // Overdue = effective date before yesterday 7:30AM
    // Mirrors dashboard's getEffectiveApprovalDate
    const getEffectiveApprovalDate = (order) => {
      if ((order.upsell === true || order.upsell_paid === true) && order.upsell_paid_at) {
        return order.upsell_paid_at;
      }
      const cs = (order.consultation_status || '').toLowerCase();
      const isScheduled = cs === 'scheduled' || cs.includes('"scheduled"');
      const isNotRequired = cs === 'not required' || cs.includes('"not required"');
      if (order.consultation_status_updated_at && cs && !isScheduled && !isNotRequired) {
        const created = new Date(order.created_at).getTime();
        const approved = order.approved_at ? new Date(order.approved_at).getTime() : created;
        const diffMin = (approved - created) / (1000 * 60);
        if (diffMin <= 5) return order.consultation_status_updated_at;
      }
      const approvedAt = order.approved_at ? new Date(order.approved_at) : null;
      const createdAt = new Date(order.created_at);
      if (approvedAt && approvedAt > createdAt) return order.approved_at;
      return order.created_at;
    };

    const isOrderOverdue = (order) => {
      const cs = (order.consultation_status || '').toLowerCase();
      if (cs === 'scheduled' || cs.includes('"scheduled"')) return false;

      const now = new Date();
      const phtNow = new Date(now.getTime() + 8 * 3600000);
      const phtDay = phtNow.getUTCDay();
      if (phtDay === 0) return false; // Sundays: nothing overdue

      if (order.preferred_delivery_date) {
        const yesterday = new Date(phtNow);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        return order.preferred_delivery_date < yesterdayStr;
      }

      const ref = getEffectiveApprovalDate(order);
      if (!ref) return false;
      const startTime = new Date(ref);

      const prevBizDayOffset = phtDay === 1 ? 2 : 1; // Monday → Saturday
      const year = phtNow.getUTCFullYear();
      const month = phtNow.getUTCMonth();
      const day = phtNow.getUTCDate();
      const todayCutoff = new Date(Date.UTC(year, month, day, 7, 30, 0) - 8 * 3600000); // 7:30AM PHT in UTC
      const yesterdayCutoff = new Date(todayCutoff.getTime() - prevBizDayOffset * 86400000);

      return startTime < yesterdayCutoff;
    };

    // Fulfillment ready: approved AND (no upsell needed OR upsell is paid)
    const approvedOrders = filteredOrders
      .filter(o => {
        if (o.approved_to_ship !== true) return false;
        if (o.upsell === true || o.upsell_paid === true) return o.upsell_paid === true;
        return true;
      })
      .map(o => ({ ...o, overdue: isOrderOverdue(o) }));

    // Awaiting upsell payment: approved but upsell not yet paid
    const awaitingUpsellOrders = filteredOrders
      .filter(o => o.approved_to_ship === true && (o.upsell === true || o.upsell_paid === false) && o.upsell_paid !== true);
    const notApprovedOrders = filteredOrders.filter(o => {
      if (o.approved_to_ship !== false) return false;
      const ps = o.prescription_status || '';
      if (ps.toLowerCase().includes('on hold') || ps.toLowerCase().includes('on_hold')) return false;
      return true;
    });

    // Sort by created_at descending (newest first)
    approvedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    notApprovedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    awaitingUpsellOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Calculate totals for approved
    const approvedValue = approvedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const approvedItems = approvedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);
    
    // Calculate totals for not approved
    const notApprovedValue = notApprovedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const notApprovedItems = notApprovedOrders.reduce((sum, o) =>
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);

    // Calculate totals for awaiting upsell
    const awaitingUpsellValue = awaitingUpsellOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const awaitingUpsellItems = awaitingUpsellOrders.reduce((sum, o) =>
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);

    const overdueCount = approvedOrders.filter(o => o.overdue).length;

    res.json({ 
      approved: {
        orders: approvedOrders,
        summary: {
          count: approvedOrders.length,
          totalValue: approvedValue.toFixed(2),
          totalItems: approvedItems,
          currency: approvedOrders[0]?.currency || 'PHP'
        }
      },
      notApproved: {
        orders: notApprovedOrders,
        summary: {
          count: notApprovedOrders.length,
          totalValue: notApprovedValue.toFixed(2),
          totalItems: notApprovedItems,
          currency: notApprovedOrders[0]?.currency || 'PHP'
        }
      },
      awaitingUpsell: {
        orders: awaitingUpsellOrders,
        summary: {
          count: awaitingUpsellOrders.length,
          totalValue: awaitingUpsellValue.toFixed(2),
          totalItems: awaitingUpsellItems,
          currency: awaitingUpsellOrders[0]?.currency || 'PHP'
        }
      },
      overdueCount,
      fetchedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
}
