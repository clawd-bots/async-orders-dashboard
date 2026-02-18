export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!storeUrl || !accessToken) {
    return res.status(400).json({
      error:
        "Shopify API not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN in Vercel.",
    });
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const query = `
		query ($cursor: String) {
			orders(
				first: 100,
				after: $cursor,
				sortKey: CREATED_AT,
				reverse: true,
				query: "tag:async-consult-completed created_at:>=${thirtyDaysAgo.toISOString()}"
			) {
				edges {
					node {
						id
						name
						tags
						createdAt
						displayFinancialStatus
						displayFulfillmentStatus
						totalPriceSet { shopMoney { amount currencyCode } }
						customer { id firstName lastName email }
						lineItems(first: 50) {
							edges {
								node { title quantity }
							}
						}
					}
				}
				pageInfo {
					hasNextPage
					endCursor
				}
			}
		}
	`;

  try {
    const allOrders = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await fetch(
        `https://${storeUrl}/admin/api/2024-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables: { cursor } }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        console.error("Shopify GraphQL error:", error);
        return res.status(response.status).json({
          error: `Shopify API error: ${response.status}`,
        });
      }

      const { data, errors } = await response.json();

      if (errors) {
        console.error("GraphQL errors:", errors);
        return res.status(502).json({
          error: errors[0]?.message || "GraphQL query failed",
        });
      }

      const { edges, pageInfo } = data.orders;

      const orders = edges.map(({ node }) => ({
        id: node.id,
        name: node.name,
        tags: node.tags,
        createdAt: node.createdAt,
        financialStatus: node.displayFinancialStatus,
        fulfillmentStatus: node.displayFulfillmentStatus,
        totalPrice: node.totalPriceSet.shopMoney,
        customer: node.customer,
        lineItems: node.lineItems.edges.map(({ node: li }) => ({
          title: li.title,
          quantity: li.quantity,
        })),
      }));

      allOrders.push(...orders);
      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    }

    res.json({
      orders: allOrders,
      total: allOrders.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: error.message });
  }
}
