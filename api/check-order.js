// Quick serverless function to check a specific order
export default async function handler(req, res) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const orderName = req.query.order || "232122252";
  
  const graphqlUrl = `https://${storeUrl}/admin/api/2025-01/graphql.json`;
  const query = `{
    orders(first: 1, query: "name:#${orderName}") {
      edges {
        node {
          id name createdAt tags
          displayFulfillmentStatus displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName email numberOfOrders }
          metafields(first: 20) {
            edges {
              node { namespace key value type }
            }
          }
          lineItems(first: 10) {
            edges {
              node { title quantity sku }
            }
          }
        }
      }
    }
  }`;

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query })
  });
  const data = await response.json();
  res.json(data);
}
