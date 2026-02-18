// Check if Shopify API is configured
export default function handler(req, res) {
  const configured = !!(
    process.env.SHOPIFY_STORE_URL && 
    process.env.SHOPIFY_ACCESS_TOKEN
  );
  
  res.json({ 
    configured,
    store: process.env.SHOPIFY_STORE_URL ? '✓' : '✗',
    token: process.env.SHOPIFY_ACCESS_TOKEN ? '✓' : '✗'
  });
}
