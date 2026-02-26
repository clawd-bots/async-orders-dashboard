import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';

const C = {
  bg: "#FAF9F7",
  accent: "#AF6E4C",
  dark: "#101312",
  gray: "#6B7280",
  green: "#059669",
  red: "#DC2626",
  yellow: "#D97706",
  beige: "#E8E4DF",
  cream: "#F5F3F0",
  blue: "#3B82F6",
};

function App() {
  const [approvedOrders, setApprovedOrders] = useState([]);
  const [notApprovedOrders, setNotApprovedOrders] = useState([]);
  const [approvedSummary, setApprovedSummary] = useState(null);
  const [notApprovedSummary, setNotApprovedSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [activeTab, setActiveTab] = useState('approved');
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [deliveryFilter, setDeliveryFilter] = useState('all'); // 'all' | 'with_date' | 'without_date' | 'overdue'

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        setConfigured(data.configured);
        if (data.configured) {
          fetchOrders();
          fetchMetrics();
        }
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
        setApprovedOrders(data.approved?.orders || []);
        setApprovedSummary(data.approved?.summary);
        setNotApprovedOrders(data.notApproved?.orders || []);
        setNotApprovedSummary(data.notApproved?.summary);
        setLastFetch(new Date().toLocaleString());
        const ac = data.approved?.summary?.count || 0;
        const nc = data.notApproved?.summary?.count || 0;
        setMessage({ type: 'success', text: `Found ${ac} approved, ${nc} not approved` });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setLoading(false);
  };

  const fetchMetrics = async () => {
    setMetricsLoading(true);
    try {
      const res = await fetch('/api/metrics');
      const data = await res.json();
      if (!data.error) setMetrics(data);
    } catch (e) { /* silent */ }
    setMetricsLoading(false);
  };

  const sendEmail = async () => {
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch('/api/send-email', { method: 'POST' });
      const data = await res.json();
      if (data.error) setMessage({ type: 'error', text: data.error });
      else setMessage({ type: 'success', text: data.message || 'Email sent!' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    }
    setSending(false);
  };

  const downloadCSV = () => {
    const orders = activeTab === 'approved' ? approvedOrders : notApprovedOrders;
    if (orders.length === 0) return;

    let headers, rows;
    if (activeTab === 'approved') {
      headers = ['Order Number', 'Date', 'Customer', 'Phone', 'Items', 'Shipping Address', 'Provincial', 'Preferred Delivery', 'Delivery Date', 'Approved On', 'Since Approval'];
      rows = orders.map(o => [
        o.name,
        new Date(o.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }),
        `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
        o.shipping_address?.phone || '',
        o.line_items?.map(i => `${i.quantity}x ${i.title}`).join('; '),
        o.shipping_address ? `${o.shipping_address.address1}, ${o.shipping_address.city}, ${o.shipping_address.province} ${o.shipping_address.zip}` : '',
        o.is_provincial ? 'Yes' : 'No',
        o.preferred_delivery === true ? 'Yes' : o.preferred_delivery === false ? 'No' : '',
        o.preferred_delivery_date || '',
        o.approved_at ? new Date(o.approved_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '',
        getHoursAgo(o.approved_at || o.created_at),
      ]);
    } else {
      headers = ['Order Number', 'Date', 'Customer', 'Email', 'Items', 'Prescription Status', 'Total'];
      rows = orders.map(o => [
        o.name,
        new Date(o.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }),
        `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
        o.customer?.email || '',
        o.line_items?.map(i => `${i.quantity}x ${i.title}`).join('; '),
        o.prescription_status || '',
        `${o.currency} ${parseFloat(o.total_price || 0).toLocaleString()}`,
      ]);
    }

    const csv = [headers, ...rows].map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fulfillment-${activeTab}-${new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }).replace(/\//g, '-')}.csv`;
    a.click();
  };

  const getHoursAgo = (dateStr) => {
    if (!dateStr) return '—';
    const hrs = (new Date() - new Date(dateStr)) / (1000 * 60 * 60);
    if (hrs < 1) return '<1h';
    if (hrs < 24) return `${Math.floor(hrs)}h`;
    const days = Math.floor(hrs / 24);
    const remHrs = Math.floor(hrs % 24);
    return `${days}d ${remHrs}h`;
  };

  // Overdue: approved before yesterday's cutoff (12NN prov / 3PM metro) and still unfulfilled
  // Due Today: approved yesterday after cutoff (carried over) or approved today before cutoff
  const getDueTodayCounts = () => {
    const now = new Date();
    const phtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const phtDay = phtNow.getDay(); // 0=Sun

    if (phtDay === 0) return { dueToday: 0, overdue: 0, total: 0 };

    // Yesterday's cutoffs in PHT
    const yesterday12NN = new Date(phtNow);
    yesterday12NN.setDate(yesterday12NN.getDate() - 1);
    yesterday12NN.setHours(12, 0, 0, 0);

    const yesterday3PM = new Date(phtNow);
    yesterday3PM.setDate(yesterday3PM.getDate() - 1);
    yesterday3PM.setHours(15, 0, 0, 0);

    // Today's cutoffs in PHT
    const today12NN = new Date(phtNow);
    today12NN.setHours(12, 0, 0, 0);
    const today3PM = new Date(phtNow);
    today3PM.setHours(15, 0, 0, 0);

    const eligible = approvedOrders.filter(o => !o.preferred_delivery_date);

    let dueToday = 0;
    let overdue = 0;

    for (const o of eligible) {
      const ref = o.approved_at || o.created_at;
      const approvedPHT = new Date(new Date(ref).toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
      const isProvincial = o.is_provincial === true;
      const yesterdayCutoff = isProvincial ? yesterday12NN : yesterday3PM;
      const todayCutoff = isProvincial ? today12NN : today3PM;

      if (approvedPHT < yesterdayCutoff) {
        // Approved before yesterday's cutoff — should have shipped yesterday — overdue
        overdue++;
      } else if (approvedPHT < todayCutoff) {
        // Approved between yesterday's cutoff and today's cutoff — due today
        dueToday++;
      }
      // Approved today after cutoff — due tomorrow, not counted
    }

    return { dueToday, overdue, total: dueToday + overdue };
  };

  const rawOrders = activeTab === 'approved' ? approvedOrders : notApprovedOrders;
  const summary = activeTab === 'approved' ? approvedSummary : notApprovedSummary;
  const dueCounts = getDueTodayCounts();

  // Sort approved orders by approved_at descending (most recent first)
  const sortedOrders = activeTab === 'approved'
    ? [...rawOrders].sort((a, b) => {
        const aDate = a.approved_at ? new Date(a.approved_at) : new Date(0);
        const bDate = b.approved_at ? new Date(b.approved_at) : new Date(0);
        return bDate - aDate;
      })
    : rawOrders;

  // Overdue: approved before yesterday's cutoff (12NN prov / 3PM metro), no delivery date
  const isOverdue = (o) => {
    if (o.preferred_delivery_date) return false;
    const ref = o.approved_at || o.created_at;
    const phtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const isProvincial = o.is_provincial === true;
    const yesterdayCutoff = new Date(phtNow);
    yesterdayCutoff.setDate(yesterdayCutoff.getDate() - 1);
    yesterdayCutoff.setHours(isProvincial ? 12 : 15, 0, 0, 0);
    const approvedPHT = new Date(new Date(ref).toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    return approvedPHT < yesterdayCutoff;
  };

  // Apply filters (approved tab only)
  const orders = activeTab === 'approved'
    ? sortedOrders.filter(o => {
        if (deliveryFilter === 'with_date') return !!o.preferred_delivery_date;
        if (deliveryFilter === 'without_date') return !o.preferred_delivery_date;
        if (deliveryFilter === 'overdue') return isOverdue(o);
        return true;
      })
    : sortedOrders;

  // Filter counts for badges
  const withDateCount = approvedOrders.filter(o => o.preferred_delivery_date).length;
  const withoutDateCount = approvedOrders.filter(o => !o.preferred_delivery_date).length;
  const overdueCount = approvedOrders.filter(o => isOverdue(o)).length;

  // Prepare chart data (filter out Sundays for ship time)
  const shipTimeData = metrics?.days?.filter(d => !d.isSunday && d.avgShipTimeHours !== null) || [];
  const fulfilledData = metrics?.days?.filter(d => !d.isSunday) || [];

  // Calculate monthly averages
  const avgShipTime = shipTimeData.length > 0 
    ? shipTimeData.reduce((sum, d) => sum + d.avgShipTimeHours, 0) / shipTimeData.length 
    : 0;
  
  const avgMetroPerDay = fulfilledData.length > 0
    ? fulfilledData.reduce((sum, d) => sum + (d.metro || 0), 0) / fulfilledData.length
    : 0;
  
  const avgProvincialPerDay = fulfilledData.length > 0
    ? fulfilledData.reduce((sum, d) => sum + (d.provincial || 0), 0) / fulfilledData.length
    : 0;

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
          }}>📦</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: C.dark }}>Fulfillment Dashboard</div>
            <div style={{ fontSize: 12, color: C.gray }}>Approved to ship + Unfulfilled orders</div>
          </div>
        </div>
        <div style={{
          padding: '6px 12px', borderRadius: 20,
          background: configured ? '#D1FAE5' : '#FEE2E2',
          color: configured ? C.green : C.red,
          fontSize: 12, fontWeight: 600
        }}>
          {configured ? '● Connected' : '○ Not Configured'}
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>
        {message && (
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 16,
            background: message.type === 'error' ? '#FEE2E2' : '#D1FAE5',
            color: message.type === 'error' ? C.red : C.green, fontSize: 14
          }}>{message.text}</div>
        )}

        {/* Summary Tiles */}
        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Pending Orders</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: summary.count > 0 ? C.yellow : C.green }}>
                {summary.count}
              </div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Due Today</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: dueCounts.dueToday > 0 ? C.accent : C.green }}>
                {dueCounts.dueToday}
              </div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Overdue</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: dueCounts.overdue > 0 ? C.red : C.green }}>
                {dueCounts.overdue}
              </div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Scheduled Delivery</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: withDateCount > 0 ? C.blue : C.green }}>
                {withDateCount}
              </div>
            </div>
          </div>
        )}

        {/* Charts Row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          {/* Approved to Ship Time */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.dark, marginBottom: 4 }}>Approved to Ship Time</div>
            <div style={{ fontSize: 11, color: C.gray, marginBottom: 16 }}>Average hours from approval to fulfillment · Target: 24h</div>
            {shipTimeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={shipTimeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.beige} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.gray }} tickFormatter={v => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10, fill: C.gray }} unit="h" />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    formatter={(v) => [`${v}h`, 'Avg Ship Time']}
                    labelFormatter={(v) => v}
                  />
                  <ReferenceLine y={24} stroke={C.green} strokeDasharray="5 5" label={{ value: '24h target', fontSize: 10, fill: C.green, position: 'right' }} />
                  <ReferenceLine y={avgShipTime} stroke={C.blue} strokeDasharray="3 3" label={{ value: `${avgShipTime.toFixed(1)}h avg`, fontSize: 10, fill: C.blue, position: 'left' }} />
                  <Line type="monotone" dataKey="avgShipTimeHours" stroke={C.accent} strokeWidth={2} dot={{ r: 3, fill: C.accent }} name="Avg Hours" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 13 }}>
                {metricsLoading ? 'Loading metrics...' : 'No data yet'}
              </div>
            )}
          </div>

          {/* Orders Fulfilled Per Day (MTD) */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.dark, marginBottom: 4 }}>Orders Fulfilled Per Day</div>
            <div style={{ fontSize: 11, color: C.gray, marginBottom: 16 }}>Provincial vs Metro · Excludes Sundays · Avg: {avgMetroPerDay.toFixed(0)} metro / {avgProvincialPerDay.toFixed(0)} provincial per day</div>
            {fulfilledData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={fulfilledData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.beige} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.gray }} tickFormatter={v => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10, fill: C.gray }} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    labelFormatter={(v) => v}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="metro" stackId="a" fill={C.accent} name="Metro" />
                  <Bar dataKey="provincial" stackId="a" fill={C.yellow} name="Provincial" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 13 }}>
                {metricsLoading ? 'Loading metrics...' : 'No data yet'}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{
          background: '#fff', borderRadius: 12, padding: 20, marginBottom: 20,
          border: `1px solid ${C.beige}`
        }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button onClick={() => { fetchOrders(); fetchMetrics(); }} disabled={loading || !configured}
              style={{
                padding: '12px 24px', borderRadius: 8, border: 'none',
                background: C.accent, color: '#fff', fontWeight: 600, fontSize: 14,
                cursor: loading || !configured ? 'not-allowed' : 'pointer',
                opacity: loading || !configured ? 0.6 : 1
              }}>
              {loading ? 'Fetching...' : '🔄 Refresh'}
            </button>
            <button onClick={sendEmail} disabled={sending || !configured}
              style={{
                padding: '12px 24px', borderRadius: 8,
                border: `2px solid ${C.accent}`, background: '#fff',
                color: C.accent, fontWeight: 600, fontSize: 14,
                cursor: sending || !configured ? 'not-allowed' : 'pointer',
                opacity: sending || !configured ? 0.6 : 1
              }}>
              {sending ? 'Sending...' : '📧 Send Report'}
            </button>
            <button onClick={downloadCSV} disabled={orders.length === 0}
              style={{
                padding: '12px 24px', borderRadius: 8,
                border: `1px solid ${C.beige}`, background: C.cream,
                color: C.dark, fontWeight: 500, fontSize: 14,
                cursor: orders.length === 0 ? 'not-allowed' : 'pointer',
                opacity: orders.length === 0 ? 0.6 : 1
              }}>
              ⬇️ Export CSV
            </button>
          </div>
          {lastFetch && <div style={{ marginTop: 12, fontSize: 12, color: C.gray }}>Last updated: {lastFetch}</div>}
          
          {/* Tabs */}
          {(approvedOrders.length > 0 || notApprovedOrders.length > 0) && (
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button onClick={() => setActiveTab('approved')}
                style={{
                  padding: '10px 20px', borderRadius: 8,
                  border: activeTab === 'approved' ? `2px solid ${C.green}` : `1px solid ${C.beige}`,
                  background: activeTab === 'approved' ? '#D1FAE5' : '#fff',
                  color: activeTab === 'approved' ? C.green : C.dark,
                  fontWeight: 600, fontSize: 14, cursor: 'pointer'
                }}>
                ✓ Approved ({approvedSummary?.count || 0})
              </button>
              <button onClick={() => setActiveTab('notApproved')}
                style={{
                  padding: '10px 20px', borderRadius: 8,
                  border: activeTab === 'notApproved' ? `2px solid ${C.red}` : `1px solid ${C.beige}`,
                  background: activeTab === 'notApproved' ? '#FEE2E2' : '#fff',
                  color: activeTab === 'notApproved' ? C.red : C.dark,
                  fontWeight: 600, fontSize: 14, cursor: 'pointer'
                }}>
                ✗ Rejected ({notApprovedSummary?.count || 0})
              </button>
            </div>
          )}
        </div>

        {/* Orders Table */}
        <div style={{
          background: '#fff', borderRadius: 12, border: `1px solid ${C.beige}`, overflow: 'hidden'
        }}>
          <div style={{
            padding: '16px 20px', borderBottom: `1px solid ${C.beige}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12
          }}>
            <div style={{ fontWeight: 600, color: C.dark }}>
              {activeTab === 'approved' ? 'Approved & Pending Fulfillment' : 'Rejected (For Cancellation/Refund)'} ({orders.length})
            </div>
            {activeTab === 'approved' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { key: 'all', label: 'All', count: approvedOrders.length },
                  { key: 'with_date', label: 'With Delivery Date', count: withDateCount },
                  { key: 'without_date', label: 'No Delivery Date', count: withoutDateCount },
                  { key: 'overdue', label: 'Overdue', count: overdueCount },
                ].map(f => (
                  <button key={f.key} onClick={() => setDeliveryFilter(f.key)}
                    style={{
                      padding: '4px 12px', borderRadius: 16, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      border: deliveryFilter === f.key ? `2px solid ${C.accent}` : `1px solid ${C.beige}`,
                      background: deliveryFilter === f.key ? '#FDF2EC' : '#fff',
                      color: deliveryFilter === f.key ? C.accent : C.gray,
                    }}>
                    {f.label} ({f.count})
                  </button>
                ))}
              </div>
            )}
          </div>

          {orders.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>
              {configured
                ? (lastFetch
                  ? (activeTab === 'approved' ? '✅ All approved orders fulfilled!' : '✅ No rejected orders')
                  : 'Click "Refresh" to load')
                : 'Configure Shopify API to get started'}
            </div>
          ) : (
            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: C.cream, position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={thStyle}>Order</th>
                    <th style={thStyle}>Customer</th>
                    {activeTab === 'approved' && <th style={thStyle}>Phone</th>}
                    <th style={thStyle}>Items</th>
                    {activeTab === 'approved' && (
                      <>
                        <th style={thStyle}>Shipping Address</th>
                        <th style={{ ...thStyle, textAlign: 'center' }}>Provincial</th>
                        <th style={{ ...thStyle, textAlign: 'center' }}>Pref. Delivery</th>
                        <th style={thStyle}>Delivery Date</th>
                        <th style={thStyle}>Approved On</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Since Approval</th>
                      </>
                    )}
                    {activeTab === 'notApproved' && (
                      <>
                        <th style={thStyle}>Prescription Status</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order, i) => {
                    const waitRef = order.approved_at || order.created_at;
                    const waitHrs = (new Date() - new Date(waitRef)) / (1000 * 60 * 60);
                    const waitColor = waitHrs > 72 ? C.red : waitHrs > 24 ? C.yellow : C.gray;
                    const addr = order.shipping_address;

                    return (
                      <tr key={order.id} style={{ borderTop: i > 0 ? `1px solid ${C.beige}` : 'none' }}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600, color: C.accent }}>{order.name}</div>
                          <div style={{ fontSize: 11, color: C.gray }}>{new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}</div>
                        </td>
                        <td style={tdStyle}>
                          <div style={{ fontSize: 14 }}>{order.customer?.first_name} {order.customer?.last_name}</div>
                          {activeTab === 'notApproved' && (
                            <div style={{ fontSize: 11, color: C.gray }}>{order.customer?.email}</div>
                          )}
                        </td>
                        {activeTab === 'approved' && (
                          <td style={{ ...tdStyle, fontSize: 12 }}>{addr?.phone || <span style={{ color: C.gray }}>—</span>}</td>
                        )}
                        <td style={{ ...tdStyle, fontSize: 13 }}>
                          {order.line_items?.slice(0, 2).map((item, j) => (
                            <div key={j}>{item.quantity}× {item.title.length > 25 ? item.title.slice(0, 25) + '...' : item.title}</div>
                          ))}
                          {order.line_items?.length > 2 && (
                            <div style={{ color: C.gray, fontSize: 11 }}>+{order.line_items.length - 2} more</div>
                          )}
                        </td>
                        {activeTab === 'approved' && (
                          <>
                            <td style={{ ...tdStyle, fontSize: 11, maxWidth: 180 }}>
                              {addr ? (
                                <div style={{ lineHeight: 1.4 }}>
                                  {addr.address1}{addr.address2 ? `, ${addr.address2}` : ''}<br />
                                  {addr.city}, {addr.province} {addr.zip}
                                </div>
                              ) : <span style={{ color: C.gray }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'center', fontSize: 12 }}>
                              {order.is_provincial
                                ? <span style={{ background: '#FEF3C7', color: C.yellow, padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 11 }}>Provincial</span>
                                : <span style={{ color: C.gray }}>Metro</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'center', fontSize: 13 }}>
                              {order.preferred_delivery === true && <span style={{ color: C.green }}>✓</span>}
                              {order.preferred_delivery === false && <span style={{ color: C.red }}>✗</span>}
                              {order.preferred_delivery === null && <span style={{ color: C.gray }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, fontSize: 12 }}>
                              {order.preferred_delivery_date
                                ? new Date(order.preferred_delivery_date).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })
                                : <span style={{ color: C.gray }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, fontSize: 11, color: C.gray }}>
                              {order.approved_at
                                ? new Date(order.approved_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                                : <span style={{ color: C.gray }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12, fontWeight: 600, color: waitColor }}>
                              {getHoursAgo(waitRef)}
                            </td>
                          </>
                        )}
                        {activeTab === 'notApproved' && (
                          <>
                            <td style={{ ...tdStyle, fontSize: 13 }}>
                              {order.prescription_status || <span style={{ color: C.gray }}>—</span>}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                              {order.currency} {parseFloat(order.total_price).toLocaleString()}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ marginTop: 20, padding: 16, background: C.cream, borderRadius: 8, fontSize: 13, color: C.gray }}>
          <strong>📧 Daily Email:</strong> Sent every day at 8:00 AM PHT with pending fulfillment orders.
          {' · '}<strong>🕒 Cutoff:</strong> Orders approved before 3:00 PM are due same day (Mon–Sat). No fulfillment on Sundays.
        </div>
      </main>
    </div>
  );
}

const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 11, color: '#6B7280', fontWeight: 600, whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 12px', verticalAlign: 'top' };

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
