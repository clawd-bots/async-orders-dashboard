import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

const C = {
  bg: "#FAF9F7",
  accent: "#AF6E4C",
  dark: "#101312",
  gray: "#6B7280",
  green: "#059669",
  red: "#DC2626",
  beige: "#E8E4DF",
  cream: "#F5F3F0",
};

function App() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        setConfigured(data.configured)
        if (data.configured) fetchOrders()
      })
      .catch(() => setConfigured(false));
  }, []);

  const fetchOrders = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/orders');
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setOrders(data.orders || []);
        setLastFetch(new Date().toLocaleString());
        setMessage({ type: 'success', text: `Fetched ${data.orders?.length || 0} async orders` });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setLoading(false);
  };

  const sendEmail = async () => {
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch('/api/send-email', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setMessage({ type: 'success', text: data.message || 'Email sent!' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setSending(false);
  };

  const downloadCSV = () => {
    if (orders.length === 0) return;
    const headers = ['Order Number', 'Date', 'Customer', 'Items', 'Total'];
    const rows = orders.map(o => [
      o.name,
      new Date(o.createdAt).toLocaleDateString(),
      o.customer?.firstName + ' ' + o.customer?.lastName,
      o.lineItems?.map(i => `${i.quantity}x ${i.title}`).join('; '),
      o.totalPrice?.amount + ' ' + o.totalPrice?.currencyCode
    ]);
    
    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `async-orders-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <header style={{
        background: '#fff',
        borderBottom: `1px solid ${C.beige}`,
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, background: C.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 18, fontWeight: 700
          }}>&</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: C.dark }}>Async Orders</div>
            <div style={{ fontSize: 12, color: C.gray }}>Shopify orders tagged "async"</div>
          </div>
        </div>
        <div style={{
          padding: '6px 12px',
          borderRadius: 20,
          background: configured ? '#D1FAE5' : '#FEE2E2',
          color: configured ? C.green : C.red,
          fontSize: 12,
          fontWeight: 600
        }}>
          {configured ? '● Connected' : '○ Not Configured'}
        </div>
      </header>

      {/* Main */}
      <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
        {/* Message */}
        {message && (
          <div style={{
            padding: '12px 16px',
            borderRadius: 8,
            marginBottom: 16,
            background: message.type === 'error' ? '#FEE2E2' : '#D1FAE5',
            color: message.type === 'error' ? C.red : C.green,
            fontSize: 14
          }}>
            {message.text}
          </div>
        )}

        {/* Actions */}
        <div style={{
          background: '#fff',
          borderRadius: 12,
          padding: 20,
          marginBottom: 20,
          border: `1px solid ${C.beige}`
        }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              onClick={fetchOrders}
              disabled={loading || !configured}
              style={{
                padding: '12px 24px',
                borderRadius: 8,
                border: 'none',
                background: C.accent,
                color: '#fff',
                fontWeight: 600,
                fontSize: 14,
                cursor: loading || !configured ? 'not-allowed' : 'pointer',
                opacity: loading || !configured ? 0.6 : 1
              }}
            >
              {loading ? 'Fetching...' : '🔄 Refresh Orders'}
            </button>
            
            <button
              onClick={sendEmail}
              disabled={sending || !configured}
              style={{
                padding: '12px 24px',
                borderRadius: 8,
                border: `2px solid ${C.accent}`,
                background: '#fff',
                color: C.accent,
                fontWeight: 600,
                fontSize: 14,
                cursor: sending || !configured ? 'not-allowed' : 'pointer',
                opacity: sending || !configured ? 0.6 : 1
              }}
            >
              {sending ? 'Sending...' : '📧 Send Email Now'}
            </button>

            <button
              onClick={downloadCSV}
              disabled={orders.length === 0}
              style={{
                padding: '12px 24px',
                borderRadius: 8,
                border: `1px solid ${C.beige}`,
                background: C.cream,
                color: C.dark,
                fontWeight: 500,
                fontSize: 14,
                cursor: orders.length === 0 ? 'not-allowed' : 'pointer',
                opacity: orders.length === 0 ? 0.6 : 1
              }}
            >
              ⬇️ Download CSV
            </button>
          </div>
          
          {lastFetch && (
            <div style={{ marginTop: 12, fontSize: 12, color: C.gray }}>
              Last fetched: {lastFetch}
            </div>
          )}
        </div>

        {/* Orders Table */}
        <div style={{
          background: '#fff',
          borderRadius: 12,
          border: `1px solid ${C.beige}`,
          overflow: 'hidden'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: `1px solid ${C.beige}`,
            fontWeight: 600,
            color: C.dark
          }}>
            Orders ({orders.length})
          </div>
          
          {orders.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>
              {configured ? 'Loading orders...' : 'Configure Shopify API to get started'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: C.cream }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, color: C.gray, fontWeight: 600 }}>Order</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, color: C.gray, fontWeight: 600 }}>Date</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, color: C.gray, fontWeight: 600 }}>Customer</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, color: C.gray, fontWeight: 600 }}>Items</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 12, color: C.gray, fontWeight: 600 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, i) => (
                  <tr key={order.id} style={{ borderTop: i > 0 ? `1px solid ${C.beige}` : 'none' }}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: C.accent }}>{order.name}</td>
                    <td style={{ padding: '12px 16px', fontSize: 14, color: C.gray }}>
                      {new Date(order.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 14 }}>
                      {order.customer?.firstName} {order.customer?.lastName}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13 }}>
                      {order.lineItems?.map((item, j) => (
                        <div key={j}>{item.quantity}× {item.title}</div>
                      ))}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600 }}>
                      {order.totalPrice?.currencyCode} {parseFloat(order.totalPrice?.amount).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        {/* Info */}
        <div style={{ marginTop: 20, padding: 16, background: C.cream, borderRadius: 8, fontSize: 13, color: C.gray }}>
          <strong>Daily Email:</strong> Automatically sent every day at 8:00 AM PHT to wesley@andyou.ph
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
