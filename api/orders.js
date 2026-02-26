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
                preferredDeliveryDateMetafield: metafield(namespace: "custom", key: "preferred_delivery_data") {
                  value
                }
                prescriptionStatusMetafield: metafield(namespace: "custom", key: "prescription_status") {
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
        return !hasKeevtest;
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
          tags: node.tags || [],
          is_provincial: (node.tags || []).some(t => t.toLowerCase() === 'provincial'),
          customer: {
            first_name: node.customer?.firstName,
            last_name: node.customer?.lastName,
            email: node.customer?.email
          },
          shipping_address: node.shippingAddress ? {
            phone: node.shippingAddress.phone || '',
            address1: node.shippingAddress.address1 || '',
            address2: node.shippingAddress.address2 || '',
            city: node.shippingAddress.city || '',
            province: node.shippingAddress.province || '',
            zip: node.shippingAddress.zip || '',
          } : null,
          line_items: node.lineItems?.edges?.map(e => ({
            title: e.node.title,
            quantity: e.node.quantity
          })) || []
        };
      });
    
    const approvedOrders = filteredOrders.filter(o => o.approved_to_ship === true);
    const notApprovedOrders = filteredOrders.filter(o => {
      if (o.approved_to_ship !== false) return false;
      const ps = o.prescription_status || '';
      if (ps.toLowerCase().includes('on hold') || ps.toLowerCase().includes('on_hold')) return false;
      return true;
    });

    // Sort by created_at descending (newest first)
    approvedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    notApprovedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Calculate totals for approved
    const approvedValue = approvedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const approvedItems = approvedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);
    
    // Calculate totals for not approved
    const notApprovedValue = notApprovedOrders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const notApprovedItems = notApprovedOrders.reduce((sum, o) => 
      sum + (o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0);

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
      fetchedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
}
