import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_INVENTORY_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_INVENTORY_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

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
  const [awaitingUpsellOrders, setAwaitingUpsellOrders] = useState([]);
  const [approvedSummary, setApprovedSummary] = useState(null);
  const [notApprovedSummary, setNotApprovedSummary] = useState(null);
  const [awaitingUpsellSummary, setAwaitingUpsellSummary] = useState(null);
  const [overdueCount, setOverdueCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [activeTab, setActiveTab] = useState('approved');
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [deliveryFilter, setDeliveryFilter] = useState('all'); // 'all' | 'with_date' | 'ship_today' | 'overdue' | 'awaiting_consult'
  const [batchMap, setBatchMap] = useState({}); // SKU -> [{ batch_number, expiry_date, quantity }]

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
        const approved = data.approved?.orders || [];
        setApprovedOrders(approved);
        setApprovedSummary(data.approved?.summary);
        setNotApprovedOrders(data.notApproved?.orders || []);
        setNotApprovedSummary(data.notApproved?.summary);
        setAwaitingUpsellOrders(data.awaitingUpsell?.orders || []);
        setAwaitingUpsellSummary(data.awaitingUpsell?.summary);
        setOverdueCount(data.overdueCount || 0);
        setLastFetch(new Date().toLocaleString());
        fetchBatches(approved);
        const ac = data.approved?.summary?.count || 0;
        const nc = data.notApproved?.summary?.count || 0;
        const uc = data.awaitingUpsell?.summary?.count || 0;
        const oc = data.overdueCount || 0;
        setMessage({ type: 'success', text: `Found ${ac} approved, ${nc} not approved${uc > 0 ? `, ${uc} awaiting upsell` : ''}${oc > 0 ? `, ${oc} overdue` : ''}` });
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

  const fetchBatches = async (orders) => {
    if (!supabase || orders.length === 0) return;
    try {
      const skus = [...new Set(orders.flatMap(o => (o.line_items || []).map(li => li.sku).filter(Boolean)))];
      if (skus.length === 0) return;

      const { data: products } = await supabase
        .from('shopify_products')
        .select('id, sku')
        .in('sku', skus);
      if (!products || products.length === 0) return;

      const skuToProductId = {};
      for (const p of products) skuToProductId[p.sku] = p.id;
      const productIds = [...new Set(Object.values(skuToProductId))];

      const { data: batches } = await supabase
        .from('product_batches')
        .select('product_id, batch_number, expiry_date, quantity')
        .in('product_id', productIds)
        .gt('quantity', 0)
        .order('expiry_date', { ascending: true });
      if (!batches) return;

      const productIdToSku = {};
      for (const [sku, pid] of Object.entries(skuToProductId)) {
        if (!productIdToSku[pid]) productIdToSku[pid] = [];
        productIdToSku[pid].push(sku);
      }

      const map = {};
      for (const b of batches) {
        const skusForProduct = productIdToSku[b.product_id] || [];
        for (const sku of skusForProduct) {
          if (!map[sku]) map[sku] = [];
          map[sku].push({ batch_number: b.batch_number, expiry_date: b.expiry_date, quantity: b.quantity });
        }
      }
      setBatchMap(map);
    } catch (e) {
      console.error('Failed to fetch batches:', e);
    }
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
    const csvOrders = activeTab === 'approved' ? approvedOrders : notApprovedOrders;
    if (csvOrders.length === 0) return;

    let headers, rows;
    if (activeTab === 'approved') {
      const csvAllocations = allocateBatches(csvOrders);
      let allocIdx = 0;
      headers = ['Order Number', 'Date', 'Customer', 'Phone', 'Product', 'SKU', 'Qty', 'Batch', 'Batch Expiry', 'Shipping Address', 'Provincial', 'Preferred Delivery', 'Delivery Date', 'Approved On', 'Since Approval', 'Upsell', 'Upsell Paid', 'Upsell Paid Date', 'Overdue', 'Shipped'];
      rows = csvOrders.flatMap(o =>
        (o.line_items?.length > 0 ? o.line_items : [{ title: '', sku: '', quantity: 0 }]).flatMap(item =>
          Array.from({ length: Math.max(item.quantity || 1, 1) }, () => {
            const alloc = csvAllocations[allocIdx++];
            return [
              o.name,
              new Date(o.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }),
              `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
              o.shipping_address?.phone || '',
              item.title || '',
              item.sku || '',
              1,
              alloc ? alloc.batch_number : 'No stock',
              alloc ? alloc.expiry_date : '',
              o.shipping_address ? `${o.shipping_address.address1}, ${o.shipping_address.city}, ${o.shipping_address.province} ${o.shipping_address.zip}` : '',
              o.is_provincial ? 'Yes' : 'No',
              o.preferred_delivery === true ? 'Yes' : o.preferred_delivery === false ? 'No' : '',
              o.preferred_delivery_date || '',
              getEffectiveApprovalDate(o) ? new Date(getEffectiveApprovalDate(o)).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '',
              getHoursAgo(getEffectiveApprovalDate(o)),
              o.upsell === true ? 'Yes' : 'No',
              o.upsell_paid === true ? 'Yes' : 'No',
              o.upsell_paid_at ? new Date(o.upsell_paid_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '',
              o.overdue ? 'Yes' : 'No',
              'No',
            ];
          })
        )
      );
    } else {
      headers = ['Order Number', 'Date', 'Customer', 'Email', 'Product', 'SKU', 'Qty', 'Prescription Status', 'Total'];
      rows = csvOrders.flatMap(o =>
        (o.line_items?.length > 0 ? o.line_items : [{ title: '', sku: '', quantity: 0 }]).flatMap(item =>
          Array.from({ length: Math.max(item.quantity || 1, 1) }, () => [
            o.name,
            new Date(o.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }),
            `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
            o.customer?.email || '',
            item.title || '',
            item.sku || '',
            1,
            o.prescription_status || '',
            `${o.currency} ${parseFloat(o.total_price || 0).toLocaleString()}`,
          ])
        )
      );
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

  // New tile structure logic
  // Check if order was auto-approved (within 5 min of creation) AND has scheduled consultation
  const isAwaitingConsultation = (o) => {
    if (!o.consultation_status || o.consultation_status.toLowerCase() !== 'scheduled') return false;
    // Only hold if approved within 5 minutes of order creation (auto-approval)
    // If manually approved (>5 min), someone already reviewed it — ship normally
    if (!o.approved_at || !o.created_at) return true; // no approval time = treat as auto
    const created = new Date(o.created_at).getTime();
    const approved = new Date(o.approved_at).getTime();
    const diffMinutes = (approved - created) / (1000 * 60);
    return diffMinutes <= 5;
  };

  const getTileCounts = () => {
    const now = new Date();
    const phtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const phtDay = phtNow.getDay(); // 0=Sun

    if (phtDay === 0) return { shipToday: 0, overdue: 0, scheduled: 0, newOrders: 0, awaitingConsult: 0, pending: 0 };

    // Today's date for comparison (YYYY-MM-DD in PHT)
    const todayPHT = new Date(phtNow.getFullYear(), phtNow.getMonth(), phtNow.getDate());

    // "Previous business day" cutoffs in PHT
    // If today is Monday (1), previous business day is Saturday (not Sunday)
    // If today is Sunday (0), we already returned zeros above
    const prevBizDayOffset = phtDay === 1 ? 2 : 1; // Mon → go back 2 days (Sat), else go back 1 day

    // Cutoff hours: 7:30 AM for all orders, 12 noon for sexual health (Erectile Dysfunction)
    const defaultCutoffHour = 7.5; // 7:30 AM
    const sexualHealthCutoffHour = 12; // 12 noon

    // Helper: check if order contains sexual health products
    const isSexualHealthOrder = (o) => (o.line_items || []).some(li =>
      (li.product_type || '').toLowerCase().includes('erectile dysfunction')
    );

    // Helper: get cutoff times for a given hour (supports half hours)
    const makeCutoff = (baseDate, hour) => {
      const d = new Date(baseDate);
      d.setHours(Math.floor(hour), (hour % 1) * 60, 0, 0);
      return d;
    };

    const yesterdayDefault = makeCutoff(new Date(phtNow.getTime() - prevBizDayOffset * 86400000), defaultCutoffHour);
    const yesterdaySexHealth = makeCutoff(new Date(phtNow.getTime() - prevBizDayOffset * 86400000), sexualHealthCutoffHour);
    const todayDefault = makeCutoff(phtNow, defaultCutoffHour);
    const todaySexHealth = makeCutoff(phtNow, sexualHealthCutoffHour);

    let shipToday = 0; // Orders that need to ship today (past cutoff, ≤24h)
    let overdue = 0;   // Urgent: >24h past when they should have shipped
    let scheduled = 0;
    let newOrders = 0;
    let awaitingConsult = 0;

    const yesterdayPHT = new Date(todayPHT);
    yesterdayPHT.setDate(yesterdayPHT.getDate() - 1);

    for (const o of approvedOrders) {
      // Orders with "Scheduled" consultation status are held — don't ship yet
      if (isAwaitingConsultation(o)) {
        awaitingConsult++;
        continue;
      }
      if (o.preferred_delivery_date) {
        // Orders WITH delivery date
        const deliveryDate = new Date(o.preferred_delivery_date + 'T00:00:00');
        const deliveryDatePHT = new Date(deliveryDate.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
        const deliveryDateOnly = new Date(deliveryDatePHT.getFullYear(), deliveryDatePHT.getMonth(), deliveryDatePHT.getDate());
        
        if (deliveryDateOnly < yesterdayPHT) {
          // Delivery date is >1 day past → overdue (urgent)
          overdue++;
        } else if (deliveryDateOnly <= todayPHT) {
          // Delivery date is today or yesterday → Ship Today
          shipToday++;
        } else {
          // Delivery date is future → scheduled
          scheduled++;
        }
      } else {
        // Orders WITHOUT delivery date: use cutoff logic
        const ref = getEffectiveApprovalDate(o);
        const approvedPHT = new Date(new Date(ref).toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
        const isSH = isSexualHealthOrder(o);
        const cutoffH = isSH ? sexualHealthCutoffHour : defaultCutoffHour;

        // Find first cutoff after approval
        const approvedDay = new Date(approvedPHT.getFullYear(), approvedPHT.getMonth(), approvedPHT.getDate());
        let firstCutoff = new Date(approvedDay);
        firstCutoff.setHours(Math.floor(cutoffH), (cutoffH % 1) * 60, 0, 0);
        if (approvedPHT >= firstCutoff) {
          firstCutoff.setDate(firstCutoff.getDate() + 1);
        }

        const hoursSinceCutoff = (now.getTime() - firstCutoff.getTime()) / (1000 * 60 * 60);

        if (hoursSinceCutoff > 24) {
          // >24h past their cutoff → overdue (urgent)
          overdue++;
        } else if (hoursSinceCutoff > 0) {
          // Past cutoff but ≤24h → Ship Today
          shipToday++;
        } else {
          // Not yet past cutoff → new (due tomorrow)
          newOrders++;
        }
      }
    }

    const pending = shipToday + overdue + scheduled + newOrders + awaitingConsult;
    return { shipToday, overdue, scheduled, newOrders, awaitingConsult, pending };
  };

  // Helper function to get the effective approval date
  // For orders that went through consultation: use consultation completion time
  // For others: later of approved_at vs created_at
  const getEffectiveApprovalDate = (order) => {
    // Upsell orders: use the date they paid the upsell
    if (order.upsell === true && order.upsell_paid_at) {
      return order.upsell_paid_at;
    }

    // If order was auto-approved (within 5 min) and had a consultation that's now complete,
    // the real approval is when the consultation completed
    const cs = order.consultation_status?.toLowerCase();
    if (order.consultation_status_updated_at && cs && cs !== 'scheduled' && cs !== 'not required') {
      // Only use consultation time if it was auto-approved (within 5 min)
      const created = new Date(order.created_at).getTime();
      const approved = order.approved_at ? new Date(order.approved_at).getTime() : created;
      const diffMin = (approved - created) / (1000 * 60);
      if (diffMin <= 5) {
        return order.consultation_status_updated_at;
      }
    }
    
    const approvedAt = order.approved_at ? new Date(order.approved_at) : null;
    const createdAt = new Date(order.created_at);
    
    // Use the LATER of approval date vs payment date (created_at approximates payment time)
    if (approvedAt && approvedAt > createdAt) {
      return order.approved_at;
    }
    return order.created_at;
  };

  // FIFO batch allocation: assign earliest-expiring batch to each unit row
  const allocateBatches = (orderList) => {
    const remaining = {};
    for (const [sku, batches] of Object.entries(batchMap)) {
      remaining[sku] = batches.map(b => ({ ...b, remaining: b.quantity }));
    }
    const allocations = []; // parallel array to expanded rows
    for (const order of orderList) {
      const items = order.line_items?.length > 0 ? order.line_items : [{ title: '', sku: '', quantity: 1 }];
      for (const item of items) {
        const units = Math.max(item.quantity || 1, 1);
        for (let u = 0; u < units; u++) {
          const skuBatches = remaining[item.sku];
          if (skuBatches) {
            const batch = skuBatches.find(b => b.remaining > 0);
            if (batch) {
              allocations.push({ batch_number: batch.batch_number, expiry_date: batch.expiry_date });
              batch.remaining--;
            } else {
              allocations.push(null);
            }
          } else {
            allocations.push(null);
          }
        }
      }
    }
    return allocations;
  };

  const getBatchExpiryColor = (expiryDate) => {
    if (!expiryDate) return C.gray;
    const days = (new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24);
    if (days <= 7) return C.red;
    if (days <= 30) return C.yellow;
    if (days > 90) return C.green;
    return C.dark;
  };

  const rawOrders = activeTab === 'approved' ? approvedOrders : activeTab === 'awaitingUpsell' ? awaitingUpsellOrders : notApprovedOrders;
  const summary = activeTab === 'approved' ? approvedSummary : activeTab === 'awaitingUpsell' ? awaitingUpsellSummary : notApprovedSummary;
  const tileCounts = getTileCounts();

  // Sort approved orders by approved_at descending (most recent first)
  const sortedOrders = activeTab === 'approved'
    ? [...rawOrders].sort((a, b) => {
        const aDate = a.approved_at ? new Date(a.approved_at) : new Date(0);
        const bDate = b.approved_at ? new Date(b.approved_at) : new Date(0);
        return bDate - aDate;
      })
    : rawOrders;

    // Ship Today: needs to go out today — past their cutoff but not yet >24h overdue
  // Includes: delivery date today or past, OR no-date orders past their cutoff
  const isShipToday = (o) => {
    const phtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const phtDay = phtNow.getDay();
    if (phtDay === 0) return false;

    const todayPHT = new Date(phtNow.getFullYear(), phtNow.getMonth(), phtNow.getDate());
    const ref = getEffectiveApprovalDate(o);
    if (!ref) return false;

    if (o.preferred_delivery_date) {
      const deliveryDate = new Date(o.preferred_delivery_date + 'T00:00:00');
      const deliveryDatePHT = new Date(deliveryDate.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
      const deliveryDateOnly = new Date(deliveryDatePHT.getFullYear(), deliveryDatePHT.getMonth(), deliveryDatePHT.getDate());
      return deliveryDateOnly <= todayPHT; // today or past
    } else {
      // No delivery date: ship today if approved before today's cutoff
      const isSH = (o.line_items || []).some(li => (li.product_type || '').toLowerCase().includes('erectile dysfunction'));
      const cutoffH = isSH ? 12 : 7.5;
      const todayCutoff = new Date(phtNow);
      todayCutoff.setHours(Math.floor(cutoffH), (cutoffH % 1) * 60, 0, 0);
      const approvedPHT = new Date(new Date(ref).toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
      return approvedPHT < todayCutoff;
    }
  };

  // Overdue: urgent — >24h since they should have been shipped
  // For delivery-date orders: delivery date is >1 day in the past
  // For no-date orders: >24h past their first applicable cutoff
  const isOverdue = (o) => {
    const now = new Date();
    const phtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    const phtDay = phtNow.getDay();
    if (phtDay === 0) return false;

    const todayPHT = new Date(phtNow.getFullYear(), phtNow.getMonth(), phtNow.getDate());
    const yesterdayPHT = new Date(todayPHT);
    yesterdayPHT.setDate(yesterdayPHT.getDate() - 1);

    if (o.preferred_delivery_date) {
      // Overdue if delivery date is strictly before yesterday (i.e. >1 day past)
      const deliveryDate = new Date(o.preferred_delivery_date + 'T00:00:00');
      const deliveryDatePHT = new Date(deliveryDate.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
      const deliveryDateOnly = new Date(deliveryDatePHT.getFullYear(), deliveryDatePHT.getMonth(), deliveryDatePHT.getDate());
      return deliveryDateOnly < yesterdayPHT;
    } else {
      // No delivery date: overdue if >24h past their cutoff
      const ref = getEffectiveApprovalDate(o);
      if (!ref) return false;
      const isSH = (o.line_items || []).some(li => (li.product_type || '').toLowerCase().includes('erectile dysfunction'));
      const cutoffH = isSH ? 12 : 7.5;

      // Find the first cutoff after approval
      const approvedPHT = new Date(new Date(ref).toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
      const approvedDay = new Date(approvedPHT.getFullYear(), approvedPHT.getMonth(), approvedPHT.getDate());
      let firstCutoff = new Date(approvedDay);
      firstCutoff.setHours(Math.floor(cutoffH), (cutoffH % 1) * 60, 0, 0);
      if (approvedPHT >= firstCutoff) {
        // Approved after cutoff, next cutoff is next day
        firstCutoff.setDate(firstCutoff.getDate() + 1);
      }

      // Overdue if >24h past that first cutoff
      const hoursSinceCutoff = (now.getTime() - firstCutoff.getTime()) / (1000 * 60 * 60);
      return hoursSinceCutoff > 24;
    }
  };

  // Legacy alias for tile counts compatibility
  const isDueToday = isShipToday;

  // Apply filters (approved tab only)
  const orders = activeTab === 'approved'
    ? sortedOrders.filter(o => {
        const awaitingConsult = isAwaitingConsultation(o);
        if (deliveryFilter === 'awaiting_consult') return awaitingConsult;
        if (deliveryFilter === 'with_date') return !!o.preferred_delivery_date && !isShipToday(o) && !awaitingConsult;
        if (deliveryFilter === 'ship_today') return isShipToday(o) && !isOverdue(o) && !awaitingConsult;
        if (deliveryFilter === 'overdue') return isOverdue(o) && !awaitingConsult;
        return true;
      })
    : sortedOrders;

  // Compute FIFO batch allocations for displayed approved orders
  const batchAllocations = activeTab === 'approved' ? allocateBatches(orders) : [];

  // Filter counts for badges
  const phtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
  const todayPHT = new Date(phtNow.getFullYear(), phtNow.getMonth(), phtNow.getDate());
  
  const awaitingConsultCount = approvedOrders.filter(o => isAwaitingConsultation(o)).length;
  const nonConsultOrders = approvedOrders.filter(o => !isAwaitingConsultation(o));
  const allWithDateCount = nonConsultOrders.filter(o => o.preferred_delivery_date && !isShipToday(o)).length;
  const shipTodayCount = nonConsultOrders.filter(o => isShipToday(o) && !isOverdue(o)).length;
  const localOverdueCount = nonConsultOrders.filter(o => isOverdue(o)).length;

  // Prepare chart data (filter out Sundays for ship time)
  const shipTimeData = metrics?.days?.filter(d => !d.isSunday && d.avgShipTimeHours !== null) || [];
  const fulfilledData = metrics?.days?.filter(d => !d.isSunday) || [];

  // Calculate 30-day averages
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

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 12px' }}>
        {message && (
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 16,
            background: message.type === 'error' ? '#FEE2E2' : '#D1FAE5',
            color: message.type === 'error' ? C.red : C.green, fontSize: 14
          }}>{message.text}</div>
        )}

        {/* Summary Tiles */}
        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Ship Today</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: (tileCounts.shipToday + tileCounts.overdue) > 0 ? C.accent : C.green, marginBottom: 2 }}>
                {tileCounts.shipToday + tileCounts.overdue}
              </div>
              <div style={{ fontSize: 10, color: C.gray }}>Must go out today{tileCounts.overdue > 0 ? ` (incl. ${tileCounts.overdue} overdue)` : ''}</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Overdue</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: tileCounts.overdue > 0 ? C.red : C.green, marginBottom: 2 }}>
                {tileCounts.overdue}
              </div>
              <div style={{ fontSize: 10, color: C.gray }}>Missed their window</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Scheduled</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: tileCounts.scheduled > 0 ? C.blue : C.green, marginBottom: 2 }}>
                {tileCounts.scheduled}
              </div>
              <div style={{ fontSize: 10, color: C.gray }}>Future delivery dates</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Awaiting Consult</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: tileCounts.awaitingConsult > 0 ? '#9b59b6' : C.green, marginBottom: 2 }}>
                {tileCounts.awaitingConsult}
              </div>
              <div style={{ fontSize: 10, color: C.gray }}>Consultation scheduled</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
              <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>New</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: tileCounts.newOrders > 0 ? C.yellow : C.green, marginBottom: 2 }}>
                {tileCounts.newOrders}
              </div>
              <div style={{ fontSize: 10, color: C.gray }}>Approved after today's cutoff</div>
            </div>
            {awaitingUpsellOrders.length > 0 && (
              <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
                <div style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Awaiting Upsell</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#e67e22', marginBottom: 2 }}>
                  {awaitingUpsellOrders.length}
                </div>
                <div style={{ fontSize: 10, color: C.gray }}>Upsell payment pending</div>
              </div>
            )}
          </div>
        )}
        
        {/* Pending Total */}
        {summary && tileCounts.pending > 0 && (
          <div style={{ 
            background: '#fff', borderRadius: 12, padding: 16, marginBottom: 20, 
            border: `1px solid ${C.beige}`, textAlign: 'center' 
          }}>
            <div style={{ fontSize: 14, color: C.gray }}>
              Total Pending: <span style={{ fontWeight: 700, color: C.dark, fontSize: 16 }}>{tileCounts.pending}</span>
              <span style={{ color: C.gray, marginLeft: 8 }}>({tileCounts.shipToday + tileCounts.overdue} Ship Today + {tileCounts.scheduled} Scheduled{tileCounts.awaitingConsult > 0 ? ` + ${tileCounts.awaitingConsult} Awaiting Consult` : ''} + {tileCounts.newOrders} New)</span>
            </div>
          </div>
        )}

        {/* Charts Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
          {/* Approved to Ship Time */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>Approved to Ship Time</div>
              {avgShipTime > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.dark }}>{avgShipTime.toFixed(1)}h</div>
                  <div style={{ fontSize: 11, color: C.gray }}>↔ Last 30 days</div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontSize: 11, color: C.gray }}>Average hours from approval to fulfillment</div>
            </div>
            <div style={{ fontSize: 11, color: C.gray, marginBottom: 16 }}>Target: 24h</div>
            {shipTimeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={shipTimeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.beige} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.gray }} tickFormatter={v => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10, fill: C.gray }} unit="h" />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    formatter={(v, name, props) => {
                      const d = new Date(props.payload.date + 'T00:00:00');
                      const isMonday = d.getDay() === 1;
                      return [`${v}h${isMonday ? ' (includes Sunday gap — no fulfillment on Sundays)' : ''}`, 'Avg Ship Time'];
                    }}
                    labelFormatter={(v) => {
                      const d = new Date(v + 'T00:00:00');
                      const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
                      return `${day} ${v}`;
                    }}
                  />
                  <ReferenceLine y={24} stroke={C.green} strokeDasharray="5 5" label={{ value: '24h target', fontSize: 10, fill: C.green, position: 'right' }} />
                  {shipTimeData.filter(d => new Date(d.date + 'T00:00:00').getDay() === 1).map(d => (
                    <ReferenceLine key={d.date} x={d.date} stroke="#e9967a" strokeDasharray="3 3" strokeWidth={1} />
                  ))}
                  <Line type="monotone" dataKey="avgShipTimeHours" stroke={C.accent} strokeWidth={2} dot={(props) => {
                    const isMonday = new Date(props.payload.date + 'T00:00:00').getDay() === 1;
                    return <circle cx={props.cx} cy={props.cy} r={isMonday ? 5 : 3} fill={isMonday ? '#e9967a' : C.accent} stroke={isMonday ? '#c0392b' : 'none'} strokeWidth={isMonday ? 1.5 : 0} />;
                  }} name="Avg Hours" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontSize: 13 }}>
                {metricsLoading ? 'Loading metrics...' : 'No data yet'}
              </div>
            )}
            <div style={{ fontSize: 10, color: C.gray, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#e9967a', border: '1.5px solid #c0392b' }}></span>
              Mondays — times include Sunday (no fulfillment)
            </div>
          </div>

          {/* Orders Fulfilled Per Day (MTD) */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: `1px solid ${C.beige}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>Orders Fulfilled Per Day</div>
              {(avgMetroPerDay > 0 || avgProvincialPerDay > 0) && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.dark }}>{(avgMetroPerDay + avgProvincialPerDay).toFixed(0)} avg/day</div>
                  <div style={{ fontSize: 11, color: C.gray }}>({avgMetroPerDay.toFixed(0)} metro · {avgProvincialPerDay.toFixed(0)} provincial)</div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: C.gray }}>Provincial vs Metro · Excludes Sundays</div>
            </div>
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
              {awaitingUpsellOrders.length > 0 && (
                <button onClick={() => setActiveTab('awaitingUpsell')}
                  style={{
                    padding: '10px 20px', borderRadius: 8,
                    border: activeTab === 'awaitingUpsell' ? `2px solid #e67e22` : `1px solid ${C.beige}`,
                    background: activeTab === 'awaitingUpsell' ? '#FEF3C7' : '#fff',
                    color: activeTab === 'awaitingUpsell' ? '#e67e22' : C.dark,
                    fontWeight: 600, fontSize: 14, cursor: 'pointer'
                  }}>
                  💰 Awaiting Upsell ({awaitingUpsellSummary?.count || 0})
                </button>
              )}
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
              {activeTab === 'approved' ? 'Approved & Pending Fulfillment' : activeTab === 'awaitingUpsell' ? 'Awaiting Upsell Payment' : 'Rejected (For Cancellation/Refund)'} ({orders.length})
            </div>
            {activeTab === 'approved' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { key: 'all', label: 'All', count: approvedOrders.length },
                  { key: 'ship_today', label: 'Ship Today', count: shipTodayCount },
                  { key: 'overdue', label: '🚨 Overdue (>24h)', count: localOverdueCount },
                  { key: 'with_date', label: 'With Delivery Date', count: allWithDateCount },
                  { key: 'awaiting_consult', label: '⏳ Awaiting Consult', count: awaitingConsultCount },
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
                  ? (activeTab === 'approved' ? '✅ All approved orders fulfilled!' : activeTab === 'awaitingUpsell' ? '✅ No orders awaiting upsell payment' : '✅ No rejected orders')
                  : 'Click "Refresh" to load')
                : 'Configure Shopify API to get started'}
            </div>
          ) : (
            <div style={{ maxHeight: 600, overflowY: 'auto', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
                <thead>
                  <tr style={{ background: C.cream, position: 'sticky', top: 0, zIndex: 1 }}>
                    <th style={thStyle}>Order</th>
                    <th style={thStyle}>Customer</th>
                    <th style={thStyle}>Product</th>
                    {activeTab === 'approved' && (
                      <>
                        <th style={thStyle}>Batch</th>
                        <th style={{ ...thStyle, textAlign: 'center' }}>Provincial</th>
                        <th style={{ ...thStyle, textAlign: 'center' }}>Pref. Delivery</th>
                        <th style={thStyle}>Delivery Date</th>
                        <th style={thStyle}>Approved On</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Since Approval</th>
                      </>
                    )}
                    {activeTab === 'awaitingUpsell' && (
                      <>
                        <th style={thStyle}>Upsell Status</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
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
                  {orders.flatMap((order) => {
                    const items = order.line_items?.length > 0 ? order.line_items : [{ title: '', sku: '', quantity: 1 }];
                    // Expand each item by its quantity (1 row per unit)
                    const expandedRows = items.flatMap((item, itemIdx) =>
                      Array.from({ length: Math.max(item.quantity || 1, 1) }, (_, unitIdx) => ({
                        order,
                        item,
                        key: `${order.id}-${itemIdx}-${unitIdx}`,
                      }))
                    );
                    return expandedRows;
                  }).map(({ order, item, key }, i) => {
                    const waitRef = getEffectiveApprovalDate(order);
                    const waitHrs = (new Date() - new Date(waitRef)) / (1000 * 60 * 60);
                    const waitColor = waitHrs > 72 ? C.red : waitHrs > 24 ? C.yellow : C.gray;
                    const addr = order.shipping_address;

                    return (
                      <tr key={key} style={{ borderTop: i > 0 ? `1px solid ${C.beige}` : 'none' }}>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: C.accent }}>{order.name}</span>
                            {order.overdue && (
                              <span style={{ background: C.red, color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>OVERDUE</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: C.gray }}>{new Date(order.created_at).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}</div>
                          {isAwaitingConsultation(order) && (
                            <div style={{ fontSize: 10, color: '#9b59b6', fontWeight: 600, marginTop: 2 }}>⏳ Consult Scheduled</div>
                          )}
                          {order.upsell === true && (
                            <div style={{ fontSize: 10, fontWeight: 600, marginTop: 2, color: order.upsell_paid ? C.green : '#e67e22' }}>
                              {order.upsell_paid ? 'Upsell: Paid ✅' : 'Upsell: Awaiting Payment ⏳'}
                            </div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <div style={{ fontSize: 14 }}>{order.customer?.first_name} {order.customer?.last_name}</div>
                          {activeTab === 'notApproved' && (
                            <div style={{ fontSize: 11, color: C.gray }}>{order.customer?.email}</div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, fontSize: 13 }}>
                          {item.title ? (item.title.length > 45 ? item.title.slice(0, 45) + '...' : item.title) : '—'}
                        </td>
                        {activeTab === 'approved' && (
                          <>
                            <td style={{ ...tdStyle, fontSize: 12 }}>
                              {(() => {
                                const alloc = batchAllocations[i];
                                if (!alloc) return <span style={{ color: C.red, fontWeight: 600, fontSize: 11 }}>No stock</span>;
                                const expiryColor = getBatchExpiryColor(alloc.expiry_date);
                                return (
                                  <div>
                                    <div style={{ fontWeight: 600, color: expiryColor, fontSize: 12 }}>{alloc.batch_number}</div>
                                    <div style={{ fontSize: 10, color: expiryColor }}>
                                      Exp: {new Date(alloc.expiry_date).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}
                                    </div>
                                  </div>
                                );
                              })()}
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
                              {(() => {
                                const effectiveDate = getEffectiveApprovalDate(order);
                                const cs = order.consultation_status?.toLowerCase();
                                const wasConsult = order.consultation_status_updated_at && cs && cs !== 'scheduled' && cs !== 'not required';
                                return effectiveDate ? (
                                  <>
                                    {new Date(effectiveDate).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                    {wasConsult && <div style={{ fontSize: 9, color: '#9b59b6', marginTop: 1 }}>Post-consult</div>}
                                  </>
                                ) : <span style={{ color: C.gray }}>—</span>;
                              })()}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12, fontWeight: 600, color: waitColor }}>
                              {getHoursAgo(waitRef)}
                            </td>
                          </>
                        )}
                        {activeTab === 'awaitingUpsell' && (
                          <>
                            <td style={{ ...tdStyle, fontSize: 13 }}>
                              <span style={{ color: '#e67e22', fontWeight: 600 }}>⏳ Awaiting Payment</span>
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                              {order.currency} {parseFloat(order.total_price).toLocaleString()}
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
          {' · '}<strong>🕒 Cutoff:</strong> 7:30 AM for all orders, 12:00 PM for Sexual Health (Mon–Sat). No fulfillment on Sundays.
          {' · '}<strong>💰 Upsell:</strong> Orders with upsell require payment before appearing on fulfillment list. Overdue after next 7AM/12PM PHT cutoff.
        </div>
      </main>
    </div>
  );
}

const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 11, color: '#6B7280', fontWeight: 600, whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 12px', verticalAlign: 'top' };

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
