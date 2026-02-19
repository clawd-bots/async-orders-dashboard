export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' })
	}

	const storeUrl = process.env.SHOPIFY_STORE_URL
	const accessToken = process.env.SHOPIFY_ACCESS_TOKEN
	const agentmailApiKey = process.env.AGENTMAIL_API_KEY

	if (!storeUrl || !accessToken) {
		return res.status(400).json({ error: 'Shopify API not configured' })
	}

	if (!agentmailApiKey) {
		return res.status(400).json({ error: 'AgentMail API key not configured' })
	}

	try {
		const oneDayAgo = new Date()
		oneDayAgo.setDate(oneDayAgo.getDate() - 1)

		const query = `
			query ($cursor: String) {
				orders(
					first: 100,
					after: $cursor,
					sortKey: CREATED_AT,
					reverse: true,
					query: "tag:async-consult-completed created_at:>=${oneDayAgo.toISOString()}"
				) {
					edges {
						node {
							id
							name
							tags
							createdAt
							totalPriceSet { shopMoney { amount currencyCode } }
							customer { firstName lastName email }
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
		`

		const allOrders = []
		let cursor = null
		let hasNextPage = true

		while (hasNextPage) {
			const response = await fetch(
				`https://${storeUrl}/admin/api/2024-10/graphql.json`,
				{
					method: 'POST',
					headers: {
						'X-Shopify-Access-Token': accessToken,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ query, variables: { cursor } }),
				},
			)

			if (!response.ok) {
				const error = await response.text()
				console.error('Shopify GraphQL error:', error)
				return res.status(response.status).json({
					error: `Shopify API error: ${response.status}`,
				})
			}

			const { data, errors } = await response.json()

			if (errors) {
				console.error('GraphQL errors:', errors)
				return res.status(502).json({
					error: errors[0]?.message || 'GraphQL query failed',
				})
			}

			const { edges, pageInfo } = data.orders

			const orders = edges.map(({ node }) => ({
				name: node.name,
				createdAt: node.createdAt,
				customer: node.customer,
				totalPrice: node.totalPriceSet.shopMoney,
				lineItems: node.lineItems.edges.map(({ node: li }) => ({
					title: li.title,
					quantity: li.quantity,
				})),
			}))

			allOrders.push(...orders)
			hasNextPage = pageInfo.hasNextPage
			cursor = pageInfo.endCursor
		}

		if (allOrders.length === 0) {
			return res.json({
				message: 'No async orders in the last 24 hours. No email sent.',
				orderCount: 0,
			})
		}

		const tableRows = allOrders
			.map((order) => {
				const items = order.lineItems
					.map((i) => `${i.quantity}× ${i.title}`)
					.join('<br>')
				return `
				<tr>
					<td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">${order.name}</td>
					<td style="padding: 8px; border: 1px solid #ddd;">${order.customer?.firstName || ''} ${order.customer?.lastName || ''}</td>
					<td style="padding: 8px; border: 1px solid #ddd;">${items}</td>
					<td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${order.totalPrice.currencyCode} ${parseFloat(order.totalPrice.amount).toLocaleString()}</td>
				</tr>`
			})
			.join('')

		const htmlBody = `
			<div style="font-family: Arial, sans-serif; max-width: 700px;">
				<h2 style="color: #AF6E4C;">Async Orders Report</h2>
				<p>Here are the orders tagged "async-consult-completed" from the last 24 hours:</p>

				<table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
					<thead>
						<tr style="background: #f5f5f5;">
							<th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Order #</th>
							<th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Customer</th>
							<th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Items</th>
							<th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Total</th>
						</tr>
					</thead>
					<tbody>
						${tableRows}
					</tbody>
				</table>

				<p style="color: #666; font-size: 14px;">
					Total: ${allOrders.length} order(s)<br>
					Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
				</p>

				<p style="margin-top: 20px;">
					<a href="https://shopify-async-orders.vercel.app" style="color: #AF6E4C;">View Dashboard →</a>
				</p>
			</div>
		`

		const textBody =
			`Async Orders Report\n\n` +
			allOrders
				.map(
					(o) =>
						`${o.name}: ${o.lineItems.map((i) => `${i.quantity}× ${i.title}`).join(', ')}`,
				)
				.join('\n') +
			`\n\nTotal: ${allOrders.length} order(s)`

		const emailRes = await fetch(
			'https://api.agentmail.to/v0/inboxes/edwin@mail.andyou.ph/messages/send',
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${agentmailApiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					to: ['wesley@andyou.ph'],
					cc: ['paul@andyou.ph'],
					subject: `[Async Orders] ${allOrders.length} order(s) - ${new Date().toLocaleDateString('en-PH')}`,
					text: textBody,
					html: htmlBody,
				}),
			},
		)

		if (!emailRes.ok) {
			const error = await emailRes.text()
			console.error('AgentMail error:', error)
			return res.status(500).json({ error: 'Failed to send email' })
		}

		res.json({
			message: `Email sent with ${allOrders.length} async order(s)`,
			orderCount: allOrders.length,
		})
	} catch (error) {
		console.error('Error:', error)
		res.status(500).json({ error: error.message })
	}
}
