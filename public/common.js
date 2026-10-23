// Shared helpers for the LaundryLoop customer, provider, delivery partner and admin pages.
const LL = (() => {
  const TOKEN_KEY = 'll_token';
  const HOME = { customer: '/customer', provider: '/provider', rider: '/rider', admin: '/admin' };

  const STATUS = {
    booked: { label: 'Waiting for provider', icon: 'ti-clock', tone: 'amber' },
    accepted: { label: 'Accepted', icon: 'ti-user-check', tone: 'blue' },
    picked_up: { label: 'Picked up', icon: 'ti-shopping-bag', tone: 'blue' },
    at_provider: { label: 'At laundry', icon: 'ti-building-store', tone: 'blue' },
    washing: { label: 'Washing', icon: 'ti-wash-machine', tone: 'blue' },
    drying: { label: 'Drying', icon: 'ti-wind', tone: 'blue' },
    ironing: { label: 'Ironing', icon: 'ti-ironing-steam', tone: 'blue' },
    ready: { label: 'Ready', icon: 'ti-package', tone: 'blue' },
    out_for_delivery: { label: 'Out for delivery', icon: 'ti-truck-delivery', tone: 'blue' },
    delivered: { label: 'Delivered', icon: 'ti-check', tone: 'sage' },
    cancelled: { label: 'Cancelled', icon: 'ti-x', tone: 'red' },
  };
  // Verb used on "next step" buttons.
  const ACTION = {
    accepted: 'Accept order',
    picked_up: 'Confirm pickup',
    at_provider: 'Received from rider',
    washing: 'Start washing',
    drying: 'Start drying',
    ironing: 'Start ironing',
    ready: 'Mark ready',
    out_for_delivery: 'Collected from laundry',
    delivered: 'Confirm delivery',
  };

  let config = { slots: [] };

  // Appearance: 'auto' follows the device; 'light' / 'dark' are remembered per browser.
  const THEME_KEY = 'll_theme';
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
  }
  function applyTheme(t = getTheme()) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = t;
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch {}
    applyTheme(t);
    document.querySelectorAll('.seg[data-theme-picker] button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  }
  applyTheme();
  function themePicker() {
    const t = getTheme();
    return `<div class="seg" data-theme-picker role="group" aria-label="Appearance">${[['auto', 'ti-device-mobile', 'Auto'], ['light', 'ti-sun', 'Light'], ['dark', 'ti-moon', 'Dark']]
      .map(([k, icon, label]) => `<button type="button" data-t="${k}" class="${t === k ? 'on' : ''}" onclick="LL.setTheme('${k}')"><i class="ti ${icon}"></i>${label}</button>`).join('')}</div>`;
  }

  // Shimmer placeholders while a screen loads.
  const skeleton = () => `<div class="skel-stack"><div class="skel" style="height:52px"></div><div class="skel" style="height:160px"></div>
    <div class="skel" style="height:74px"></div><div class="skel" style="height:74px"></div></div>`;

  // Tokens are kept per role so the customer, provider and admin apps can be
  // open side by side in one browser.
  const PAGE_ROLE = Object.keys(HOME).find((r) => location.pathname === HOME[r]) || null;
  function getToken(role = PAGE_ROLE) {
    if (!role) return null;
    try { return localStorage.getItem(`${TOKEN_KEY}_${role}`); } catch { return null; }
  }
  function setToken(t, role = PAGE_ROLE) {
    if (!role) return;
    try { t ? localStorage.setItem(`${TOKEN_KEY}_${role}`, t) : localStorage.removeItem(`${TOKEN_KEY}_${role}`); } catch {}
  }

  async function api(path, { method = 'GET', body } = {}) {
    const token = getToken();
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      setToken(null);
      location.href = '/';
      throw new Error('Signed out');
    }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function requireRole(role) {
    if (!getToken()) { location.href = '/'; return new Promise(() => {}); }
    const [me, cfg] = await Promise.all([api('/api/me'), api('/api/config')]);
    config = cfg;
    if (me.role !== role) { location.href = HOME[me.role]; return new Promise(() => {}); }
    return me;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    setToken(null);
    location.href = '/';
  }

  // Live updates by polling a cheap change-stamp; fires onEvent when something moved.
  // Polls every 3s while the tab is visible, and immediately when it becomes visible.
  function live(onEvent, onState) {
    let last = null;
    let timer;
    async function tick() {
      clearTimeout(timer);
      try {
        const now = await api('/api/pulse');
        onState && onState(true);
        if (last) {
          if (now.o !== last.o) onEvent({ type: 'order', id: null });
          if (now.p !== last.p) onEvent({ type: 'providers' });
          if (now.n !== last.n) onEvent({ type: 'notification' });
        }
        last = now;
      } catch { onState && onState(false); }
      timer = setTimeout(tick, document.hidden ? 30000 : 3000);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    tick();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupee = (n) => (n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
  const slotLabel = (id) => config.slots.find((s) => s.id === id)?.label || id;

  function localDate(d = new Date()) {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return localDate(d);
  }
  function fmtDay(dateStr) {
    const today = localDate();
    if (dateStr === today) return 'Today';
    if (dateStr === addDays(today, 1)) return 'Tomorrow';
    if (dateStr === addDays(today, -1)) return 'Yesterday';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = fmtDay(localDate(d));
    return `${day}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
  }
  const fmtSlot = (date, slot) => `${fmtDay(date)}, ${slotLabel(slot)}`;
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return fmtTime(iso);
  }

  const mapsLink = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const pinLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  const statusChip = (s) => `<span class="chip ${STATUS[s]?.tone || 'grey'}">${esc(STATUS[s]?.label || s)}</span>`;
  const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  // Timeline for an order, using event timestamps where available.
  function stepperHtml(order) {
    if (order.status === 'cancelled') {
      const ev = (order.events || []).find((e) => e.status === 'cancelled');
      return `<div class="banner red"><i class="ti ti-circle-x"></i><div><b>Order cancelled</b><br>${esc(order.cancel_reason || '')}${ev ? ' · ' + esc(fmtTime(ev.created_at)) : ''}</div></div>`;
    }
    const at = {};
    for (const e of order.events || []) if (!at[e.status]) at[e.status] = e;
    const idx = order.flow.indexOf(order.status);
    return `<div class="stepper">${order.flow.map((s, i) => {
      const state = i < idx || order.status === 'delivered' ? 'done' : i === idx ? 'current' : 'pending';
      const ev = at[s];
      let sd;
      if (state === 'pending') {
        sd = s === 'delivered' ? `Due ${fmtSlot(order.delivery_date, order.delivery_slot)}`
          : s === 'picked_up' ? `Due ${fmtSlot(order.pickup_date, order.pickup_slot)}${order.pickup_rider_name ? ' · ' + order.pickup_rider_name : ''}`
          : s === 'out_for_delivery' && order.delivery_rider_name ? `${order.delivery_rider_name} assigned` : '';
      } else if (state === 'current' && s !== 'delivered') {
        sd = s === 'booked' ? 'Finding a provider…'
          : s === 'accepted' ? (order.needs_reschedule === 'pickup' ? 'Missed pickup · waiting for a new slot' : order.pickup_rider_name ? `${order.pickup_rider_name} is coming to pick up` : 'Finding a delivery partner…')
          : s === 'picked_up' ? `On the way to ${order.provider_name || 'the laundry'}`
          : s === 'ready' ? (order.needs_reschedule === 'delivery' ? 'Missed delivery · waiting for a new slot' : order.delivery_rider_name ? `${order.delivery_rider_name} will collect it` : 'Finding a delivery partner…')
          : s === 'out_for_delivery' ? `${order.delivery_rider_name || 'Rider'} is on the way` + (ev ? ' · since ' + fmtTime(ev.created_at) : '')
          : 'In progress' + (ev ? ' · since ' + fmtTime(ev.created_at) : '');
      } else {
        sd = ev ? fmtTime(ev.created_at) : 'Done';
      }
      if (ev?.note && state !== 'pending') sd += ` · ${ev.note}`;
      const label = s === 'booked' ? 'Booked' : STATUS[s].label;
      const icon = state === 'done' ? 'ti-check' : STATUS[s].icon;
      return `<div class="step ${state}">
        <div class="rail"><div class="node"><i class="ti ${icon}"></i></div>${i < order.flow.length - 1 ? '<div class="line"></div>' : ''}</div>
        <div class="content"><p class="st">${esc(label)}</p>${sd ? `<p class="sd">${esc(sd)}</p>` : ""}</div>
      </div>`;
    }).join('')}</div>`;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.className = 'toast' + (isError ? ' error' : '');
    el.innerHTML = `<i class="ti ${isError ? 'ti-alert-circle' : 'ti-check'}"></i><span>${esc(msg)}</span>`;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // Wrap an async click handler: disables the button and reports errors.
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(e.message, true); }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  }

  // Pickup / drop panel for whoever holds a delivery leg (a rider, or a homemaker doing it themselves).
  function legPanel(o) {
    const leg = o.my_leg;
    if (!leg) return '';
    const call = (p) => (p ? `<a class="btn ghost small" href="tel:${esc(p)}"><i class="ti ti-phone"></i>Call</a>` : '');
    const map = (a) => (a ? `<a class="btn ghost small" href="${mapsLink(a)}" target="_blank" rel="noopener"><i class="ti ti-map-2"></i>Directions</a>` : '');
    const stop = (label, name, addr, phone) => `<div class="stop"><p class="fl">${esc(label)}</p><p class="t1">${esc(name || '')}</p>
      <p class="t2">${esc(addr || '')}</p><div class="btn-row">${map(addr)}${call(phone)}</div></div>`;
    const id = o.id;
    if (leg === 'pickup' && o.status === 'accepted') {
      return `<div class="card leg">
        ${stop(`Pick up · ${fmtSlot(o.pickup_date, o.pickup_slot)}`, o.customer_name, o.address_text, o.customer_phone)}
        ${o.notes ? `<p class="muted" style="font-size:12.5px;">Note: ${esc(o.notes)}</p>` : ''}
        <div class="row2" style="margin-top:12px;">
          <div><label class="fl" for="leg-items">Items counted</label><input class="input" id="leg-items" type="number" min="1" max="500" placeholder="e.g. 12"></div>
          <div><label class="fl" for="leg-otp">Customer's pickup code</label><input class="input" id="leg-otp" inputmode="numeric" maxlength="4" placeholder="4 digits"></div>
        </div>
        <button class="btn primary block" style="margin-top:12px;" onclick="LL.leg.pickup(${id}, this)"><i class="ti ti-shopping-bag"></i>Confirm pickup</button>
        <div class="btn-row"><button class="btn ghost small" onclick="LL.leg.failed(${id}, this)">Customer not available</button>
          <button class="btn danger small" onclick="LL.leg.drop(${id}, this)">Drop job</button></div>
      </div>`;
    }
    if (leg === 'pickup' && o.status === 'picked_up') {
      return `<div class="card leg">
        ${stop('Drop at the laundry', o.provider_name, o.provider_address, o.provider_phone)}
        <div class="banner blue"><i class="ti ti-info-circle"></i><div>Hand over the bag of <b>${o.items_count} items</b>. ${esc(o.provider_name)} confirms receipt in their app, and that completes this job.</div></div>
      </div>`;
    }
    if (leg === 'delivery' && o.status === 'ready') {
      return `<div class="card leg">
        ${stop(`Collect from the laundry · deliver ${fmtSlot(o.delivery_date, o.delivery_slot)}`, o.provider_name, o.provider_address, o.provider_phone)}
        <p class="muted" style="font-size:12.5px;">Check the bag has ${o.items_received || o.items_count || 'all the'} items before you leave.</p>
        <button class="btn primary block" style="margin-top:8px;" onclick="LL.leg.collect(${id}, this)"><i class="ti ti-package"></i>Collected from laundry</button>
        <div class="btn-row"><button class="btn danger small" onclick="LL.leg.drop(${id}, this)">Drop job</button></div>
      </div>`;
    }
    if (leg === 'delivery' && o.status === 'out_for_delivery') {
      const paid = o.payment_status === 'paid';
      return `<div class="card leg">
        ${stop(`Deliver · ${fmtSlot(o.delivery_date, o.delivery_slot)}`, o.customer_name, o.address_text, o.customer_phone)}
        <div class="due">${paid ? '<span class="chip sage">Already paid</span>' : `Collect <b>${rupee(o.total)}</b> <small class="muted">(laundry ${rupee(o.laundry_price)}${o.delivery_fee ? ` + delivery ${rupee(o.delivery_fee)}` : ''})</small>`}</div>
        ${paid ? '' : `<div class="pill-row" id="leg-pay" style="margin-top:10px;">
          <label class="pill sel"><input type="radio" name="leg-pay" value="cash" checked hidden> Cash</label>
          <label class="pill"><input type="radio" name="leg-pay" value="upi" hidden> UPI</label></div>`}
        <label class="fl" for="leg-otp" style="margin-top:12px;">Customer's delivery code</label>
        <input class="input" id="leg-otp" inputmode="numeric" maxlength="4" placeholder="4 digits">
        <button class="btn sage block" style="margin-top:12px;" onclick="LL.leg.deliver(${id}, this)"><i class="ti ti-check"></i>Confirm delivery</button>
        <div class="btn-row"><button class="btn ghost small" onclick="LL.leg.failed(${id}, this)">Customer not available</button></div>
      </div>`;
    }
    return '';
  }

  // Pill-styled radio buttons inside the panel.
  document.addEventListener('change', (e) => {
    if (e.target.name === 'leg-pay') document.querySelectorAll('#leg-pay .pill').forEach((p) => p.classList.toggle('sel', p.contains(e.target)));
  });

  const legDone = (msg) => { toast(msg); if (typeof window.onLegDone === 'function') window.onLegDone(); };
  const val = (id) => document.getElementById(id)?.value || '';
  const leg = {
    take: (id, btn) => busy(btn, async () => { await api(`/api/orders/${id}/take`, { method: 'POST' }); legDone('Job is yours'); }),
    pickup: (id, btn) => busy(btn, async () => {
      await api(`/api/orders/${id}/pickup`, { method: 'POST', body: { items_count: Number(val('leg-items')), otp: val('leg-otp') } });
      legDone('Pickup confirmed');
    }),
    collect: (id, btn) => busy(btn, async () => { await api(`/api/orders/${id}/collect`, { method: 'POST' }); legDone('Out for delivery'); }),
    deliver: (id, btn) => busy(btn, async () => {
      const method = document.querySelector('input[name=leg-pay]:checked')?.value;
      await api(`/api/orders/${id}/deliver`, { method: 'POST', body: { otp: val('leg-otp'), payment_method: method } });
      legDone('Delivered');
    }),
    failed: async (id, btn) => {
      const reason = window.prompt('What happened?', 'Customer not available');
      if (reason === null) return;
      await busy(btn, async () => { await api(`/api/orders/${id}/attempt-failed`, { method: 'POST', body: { reason } }); legDone('Attempt logged; customer asked to reschedule'); });
    },
    drop: async (id, btn) => {
      if (!window.confirm('Drop this job so someone else can take it?')) return;
      await busy(btn, async () => { await api(`/api/orders/${id}/drop-job`, { method: 'POST', body: {} }); legDone('Job dropped'); });
    },
  };

  function clock(el) {
    const tick = () => { el.textContent = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };
    tick();
    setInterval(tick, 30000);
  }

  return {
    STATUS, ACTION, HOME, mapsLink, pinLink, setTheme, themePicker, skeleton, api, getToken, setToken, requireRole, logout, live, esc, rupee, slotLabel,
    localDate, addDays, fmtDay, fmtTime, fmtSlot, ago, statusChip, initials, stepperHtml, toast, busy, clock, legPanel, leg,
    get config() { return config; },
  };
})();
