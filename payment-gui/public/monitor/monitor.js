// ============================================================================
//  Payment Core Monitor — frontend
//
//  Connects directly to the Solace broker from the browser (solclientjs over
//  WebSocket) and shows a live grid per microservice: the last N events seen on
//  that stage's topic. Queue depth + consumer counts come from SEMP via the
//  payment-gui backend proxy (/api/semp/queues). A version toggle (v1/v2) swaps
//  every grid's subscriptions; a stoplight reflects the broker connection.
// ============================================================================

const $ = (id) => document.getElementById(id);

let cfg = null;             // /api/monitor/config payload
let currencies = {};        // currency symbols from config
let session = null;         // solclientjs session
const monitorVersion = typeof MONITOR_VERSION !== 'undefined' ? MONITOR_VERSION : 'v2';  // page identifier (v1/v2/v3) — picks which config/cards to load; distinct from the Topic Version toggle below
let version = 'v2';         // selected event/topic version (v1|v2, user-toggleable)
let maxRows = 10;
let maxRowsStacked = 5;     // for stacked validator grids (v3 only)
let animationMs = 1000;    // flying-message duration, configurable via config.yaml (monitor.animationMs)
let subscribedTopics = [];  // topic strings currently subscribed (for teardown)
let refreshTimer = null;
let refreshing = false;
let tooltip = null;         // floating tooltip element

const cards = {};           // key -> { tbody, sub, enq, con, root, hasStatus }
const processToKeys = {};   // "cleared" -> ["settlement","upsell",...]
const topicPatternServices = [];  // services with custom topicPattern, for topic matching

// ---------------------------------------------------------------------------
//  Tooltip
// ---------------------------------------------------------------------------
function highlightStatus(text, status) {
  const regex = new RegExp(`("status"\\s*:\\s*"${status}")`, 'g');
  return text.replace(regex, '<span class="status-highlight">$1</span>');
}

function showTooltip(tr, topic, event) {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'event-tooltip';
    document.body.appendChild(tooltip);
  }

  const status = event.status || '—';
  const json = JSON.stringify(event, null, 2);
  const highlightedJson = highlightStatus(json, status);

  tooltip.innerHTML = `
    <div class="tooltip-section topic-section">
      <div class="tooltip-label">Topic</div>
      <pre>${escapeHtml(topic)}</pre>
    </div>
    <div class="tooltip-section json-section">
      <div class="tooltip-label">Event</div>
      <pre>${highlightedJson}</pre>
    </div>
  `;

  const rect = tr.getBoundingClientRect();
  const TOOLTIP_WIDTH = 350; // must match .event-tooltip width in monitor.css
  const MARGIN = 10;
  let left = rect.right + MARGIN;

  // If tooltip would overflow right side, position on left instead
  if (left + TOOLTIP_WIDTH + MARGIN > window.innerWidth) {
    left = rect.left - TOOLTIP_WIDTH - MARGIN;
  }
  // Final clamp: keep it fully within the visible viewport either way
  // (rightmost grids can otherwise push it past the edge on both sides).
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - TOOLTIP_WIDTH - MARGIN));

  tooltip.style.left = left + 'px';
  tooltip.style.top = (rect.top - 20) + 'px';
  tooltip.style.display = 'block';
}

function hideTooltip() {
  if (tooltip) tooltip.style.display = 'none';
}

// ---------------------------------------------------------------------------
//  Flying message animation (broker logo -> destination card, over the bus)
// ---------------------------------------------------------------------------
const REDUCE_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const activeAnims = [];     // in-flight Animation objects, so a version switch can cancel them
let animGeneration = 0;     // bumped on version switch; cancelled anims skip onArrive if stale

// Runs the flying-message animation, then invokes onArrive once the message
// image has fully faded out — this is what lets the grid-row highlight start
// right as the flight ends, instead of firing in parallel with it.
function flyMessageToCard(card, onArrive) {
  if (REDUCE_MOTION || !card || !card.root) { onArrive?.(); return; }
  const busEl = document.querySelector('.bus');
  const busImg = document.querySelector('.bus img');
  if (!busEl || !busImg) { onArrive?.(); return; }

  const asyncCards = $('asyncCards');
  const isCardInAsync = asyncCards.contains(card.root);
  const isAsyncCollapsed = asyncCards.dataset.collapsed === 'true';
  if (isCardInAsync && isAsyncCollapsed) {
    onArrive?.();
    return;
  }

  const busRect = busEl.getBoundingClientRect();
  const busImgRect = busImg.getBoundingClientRect();
  const cardRect = card.root.getBoundingClientRect();

  // Leg 1: horizontal, traversing the bus band from the broker icon to the
  // column above/below the destination card. Leg 2: vertical, from the bus
  // band down/up into the card.
  const startX = busImgRect.left + busImgRect.width / 2;
  const startY = busRect.top + busRect.height / 2;
  const endX = cardRect.left + cardRect.width / 2;
  const endY = cardRect.top + cardRect.height / 2;
  const dxHoriz = endX - startX;
  const dyVert = endY - startY;

  const img = document.createElement('img');
  img.src = '/assets/sol-pay-msg-2.png';
  img.className = 'flying-msg';
  img.style.left = startX + 'px';
  img.style.top = startY + 'px';
  document.body.appendChild(img);

  const gen = animGeneration;
  const anim = img.animate([
    { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0, offset: 0 },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 },
    { transform: `translate(calc(-50% + ${dxHoriz}px), -50%) scale(1)`, opacity: 1, offset: 0.55 },
    { transform: `translate(calc(-50% + ${dxHoriz}px), calc(-50% + ${dyVert}px)) scale(1)`, opacity: 1, offset: 0.9 },
    { transform: `translate(calc(-50% + ${dxHoriz}px), calc(-50% + ${dyVert}px)) scale(0.5)`, opacity: 0, offset: 1 },
  ], { duration: animationMs, easing: 'ease-in-out' });
  activeAnims.push(anim);

  const cleanup = () => {
    img.remove();
    const i = activeAnims.indexOf(anim);
    if (i !== -1) activeAnims.splice(i, 1);
  };
  // A version switch cancels every in-flight animation via stopAllAnimations();
  // skip onArrive for those so a stale event never lands on the new grid.
  anim.onfinish = () => { cleanup(); if (gen === animGeneration) onArrive?.(); };
  anim.oncancel = cleanup;
}

// Cancels every in-flight flying-message animation without running its
// onArrive callback — used when switching Topic Version so a message that
// was mid-flight for the old version never gets added to the new grid.
function stopAllAnimations() {
  animGeneration++;
  activeAnims.slice().forEach((anim) => anim.cancel());
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
async function init() {
  cfg = await fetch(`/api/monitor/${monitorVersion}/config`).then((r) => r.json());
  version = cfg.defaultVersion || 'v2';
  maxRows = cfg.maxRows || 10;
  maxRowsStacked = cfg.maxRowsStacked || 5;
  animationMs = cfg.animationMs || 1000;
  currencies = cfg.currencies || {};

  buildCards();
  buildProcessIndex();
  wireControls();

  $('refreshSec').value = cfg.refreshSec || 60;
  $('speedSlider').value = animationMs;
  $('speedVal').textContent = animationMs + 'ms';
  markVersionButtons();

  startSolace();
  scheduleRefresh();
  refreshStats(); // first pull immediately
}

// ---------------------------------------------------------------------------
//  Cards
// ---------------------------------------------------------------------------
function buildCards() {
  let validatorBranch = null;  // container for Credit and Debit

  cfg.services.forEach((svc, idx) => {
    const parent = svc.band === 'async' ? $('asyncCards') : $('syncCards');

    // Create branch container for validators if we haven't already
    if ((svc.key === 'validatorCredit' || svc.key === 'validatorDebit') && !validatorBranch) {
      validatorBranch = document.createElement('div');
      validatorBranch.className = 'card-validators-branch';
      parent.appendChild(validatorBranch);
    }

    const el = document.createElement('div');
    el.className = 'card' + (svc.key === 'errorHandler' ? ' error' : '');
    el.id = `card-${svc.key}`;

    const cols = ['Txn ID', 'Merchant ID', 'Amount'];
    if (svc.hasStatus) cols.push('Status');
    const colSpan = cols.length;

    // Use maxRowsStacked for validators, maxRows for others
    const isStacked = svc.key === 'validatorCredit' || svc.key === 'validatorDebit';
    const rowsForThisCard = isStacked ? maxRowsStacked : maxRows;

    el.innerHTML = `
      <div class="card-head">
        <div class="card-title">${svc.label}</div>
        <div class="card-sub" data-sub></div>
      </div>
      <div class="grid-wrap">
        <table class="grid">
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${emptyRowsHtml(colSpan, rowsForThisCard)}</tbody>
        </table>
      </div>
      <div class="card-foot">
        <div class="qname" title="${svc.queue || ''}">${svc.queue || ''}</div>
        <div class="stats-row">
          <span class="stat">Msgs in Queue: <b class="enq" data-enq>–</b></span>
          <span class="stat">Consumers: <b class="con" data-con>–</b></span>
        </div>
      </div>`;

    // Append to branch if it's a validator, otherwise to parent
    if (isStacked) {
      validatorBranch.appendChild(el);
    } else {
      parent.appendChild(el);
    }

    cards[svc.key] = {
      svc,
      root: el,
      tbody: el.querySelector('tbody'),
      sub: el.querySelector('[data-sub]'),
      enq: el.querySelector('[data-enq]'),
      con: el.querySelector('[data-con]'),
      hasStatus: svc.hasStatus,
      maxRows: rowsForThisCard,
    };
  });
  updateSubtitles();
}

// Map each level-2 process to the card keys that should receive it. Several
// cards can share a process (all four async cards subscribe to "cleared").
// For services with a custom topicPattern, store them separately for matching.
function buildProcessIndex() {
  topicPatternServices.length = 0;  // clear
  cfg.services.forEach((svc) => {
    if (svc.topicPattern) {
      topicPatternServices.push(svc);
    } else {
      svc.processes.forEach((p) => {
        (processToKeys[p] ||= []).push(svc.key);
      });
    }
  });
}

function updateSubtitles() {
  Object.values(cards).forEach(({ svc, sub }) => {
    if (svc.topicPattern) {
      sub.textContent = `sale/${svc.processes[0]}/${version}/${svc.topicPattern}/>`;
    } else {
      const ps = svc.processes;
      sub.textContent = ps.length === 1
        ? `sale/${ps[0]}/${version}/>`
        : `sale/(${ps.join('|')})/${version}/>`;
    }
  });
}

// Pre-sizes the grid to `numRows` rows so the table never resizes as events
// arrive: one "waiting" row plus blank spacer rows to fill out the count.
function emptyRowsHtml(colSpan, numRows = maxRows) {
  const waiting = `<tr class="empty"><td colspan="${colSpan}">waiting for events…</td></tr>`;
  const spacer = `<tr class="empty-row">${'<td>&nbsp;</td>'.repeat(colSpan)}</tr>`;
  return waiting + spacer.repeat(Math.max(0, numRows - 1));
}

function clearGrids() {
  Object.values(cards).forEach(({ tbody, svc, maxRows: cardMaxRows }) => {
    const span = 4 + (svc.hasStatus ? 1 : 0);
    tbody.innerHTML = emptyRowsHtml(span, cardMaxRows);
  });
}

function addRow(key, event, process, topic) {
  const card = cards[key];
  if (!card) return;
  const empty = card.tbody.querySelector('.empty');
  if (empty) empty.remove();

  const cur = currencies[event.currency] || '';
  const amount = Number(event.amount);
  const cells = [
    event.transactionId ?? '—',
    event.merchantId ?? '—',
    `${cur}${isNaN(amount) ? '—' : amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  ];

  const tr = document.createElement('tr');
  tr.className = 'flash';
  tr.dataset.event = JSON.stringify(event);
  tr.innerHTML = cells
    .map((v, i) => `<td class="${i === 3 ? 'amount' : ''}">${escapeHtml(String(v))}</td>`)
    .join('');

  if (card.hasStatus) {
    const status = event.status || process || '—';
    tr.innerHTML += `<td><span class="status-pill status-${status}">${escapeHtml(status)}</span></td>`;
  }

  tr.addEventListener('mouseenter', () => showTooltip(tr, topic, event));
  tr.addEventListener('mouseleave', hideTooltip);

  card.tbody.insertBefore(tr, card.tbody.firstChild);
  while (card.tbody.rows.length > card.maxRows) card.tbody.deleteRow(-1);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
//  Solace session (direct browser connection)
// ---------------------------------------------------------------------------
function startSolace() {
  const factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.profile = solace.SolclientFactoryProfiles.version10;
  solace.SolclientFactory.init(factoryProps);

  setLight('amber', 'Connecting…');
  try {
    session = solace.SolclientFactory.createSession({
      url: cfg.web.url,
      vpnName: cfg.web.vpn,
      userName: cfg.web.userName,
      password: cfg.web.password,
      reconnectRetries: -1,
      connectRetries: 3,
    });
  } catch (e) {
    setLight('red', 'Config error');
    console.error('createSession failed', e);
    return;
  }

  const E = solace.SessionEventCode;
  session.on(E.UP_NOTICE, () => { setLight('green', 'Connected'); subscribeAll(); });
  session.on(E.RECONNECTING_NOTICE, () => setLight('amber', 'Reconnecting…'));
  session.on(E.RECONNECTED_NOTICE, () => { setLight('green', 'Connected'); });
  session.on(E.CONNECT_FAILED_ERROR, (e) => { setLight('red', 'Connect failed'); console.error(e); });
  session.on(E.DISCONNECTED, () => { setLight('red', 'Disconnected'); });
  session.on(E.DOWN_ERROR, (e) => { setLight('red', 'Down'); console.error(e); });
  session.on(E.SUBSCRIPTION_ERROR, (e) => console.error('subscription error', e));
  session.on(E.MESSAGE, onMessage);

  try {
    session.connect();
  } catch (e) {
    setLight('red', 'Connect error');
    console.error('connect failed', e);
  }
}

// Distinct processes across all services, subscribed once each for the current
// version; messages are routed to cards by process afterwards. Also handle services
// with custom topicPattern subscriptions.
function distinctProcesses() {
  return Object.keys(processToKeys);
}

function subscribeAll() {
  subscribedTopics = [];

  // Subscribe to distinct processes with version
  distinctProcesses().forEach((p) => {
    const topic = `sale/${p}/${version}/>`;
    try {
      session.subscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic, 10000);
      subscribedTopics.push(topic);
    } catch (e) {
      console.error('subscribe failed', topic, e);
    }
  });

  // Subscribe to custom topicPattern subscriptions with version
  topicPatternServices.forEach((svc) => {
    const topic = `sale/${svc.processes[0]}/${version}/${svc.topicPattern}/>`;
    try {
      session.subscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic, 10000);
      subscribedTopics.push(topic);
    } catch (e) {
      console.error('subscribe failed', topic, e);
    }
  });
}

function unsubscribeAll() {
  subscribedTopics.forEach((topic) => {
    try {
      session.unsubscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic, 10000);
    } catch (e) {
      console.error('unsubscribe failed', topic, e);
    }
  });
  subscribedTopics = [];
}

function onMessage(message) {
  const dest = message.getDestination();
  const topic = dest ? dest.getName() : '';
  const parts = topic.split('/');          // sale/{process}/{version}/{cardType|...}
  const process = parts[1];
  const msgVersion = parts[2];
  const cardType = parts[3];

  let keys = [];

  // Check if message matches a topicPattern (e.g., sale/initiated/v2/credit/merchant/...)
  for (const svc of topicPatternServices) {
    if (svc.processes[0] === process && msgVersion === version && svc.topicPattern === cardType) {
      keys.push(svc.key);
    }
  }

  // If no topicPattern match, try process-based routing
  if (keys.length === 0) {
    if (msgVersion !== version) return;    // stale message from a version switch mid-flight
    keys = processToKeys[process] || [];
  }

  if (!keys || keys.length === 0) return;

  const event = parseEvent(payloadOf(message));
  if (!event) { console.warn('unparseable payload on', topic); return; }
  keys.forEach((key) => {
    flyMessageToCard(cards[key], () => addRow(key, event, process, topic));
  });
}

// The Java stages publish a JCSMP TextMessage — its JSON lands in the SDT
// container, NOT the binary attachment. The REST-published "received" events
// carry JSON in the binary attachment. Try SDT first, then binary; decode any
// typed array as UTF-8.
function payloadOf(message) {
  try {
    if (typeof message.getSdtContainer === 'function') {
      const c = message.getSdtContainer();
      if (c && typeof c.getValue === 'function') {
        const v = c.getValue();
        if (typeof v === 'string' && v.length) return v;
      }
    }
  } catch { /* not an SDT message — fall through to binary */ }

  let raw = message.getBinaryAttachment();
  if (raw instanceof Uint8Array || Array.isArray(raw)) {
    raw = new TextDecoder('utf-8').decode(new Uint8Array(raw));
  }
  return typeof raw === 'string' ? raw : '';
}

// Tolerant JSON parse: if the payload has any SDT/type framing around it,
// salvage the object between the first "{" and the last "}".
function parseEvent(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try salvage */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch { /* give up */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Controls
// ---------------------------------------------------------------------------
function wireControls() {
  $('versionSeg').addEventListener('click', (e) => {
    const v = e.target?.dataset?.v;
    if (!v || v === version) return;
    setVersion(v);
  });
  $('refreshBtn').addEventListener('click', refreshStats);
  $('refreshSec').addEventListener('change', scheduleRefresh);
  $('speedSlider').addEventListener('input', (e) => {
    animationMs = Number(e.target.value);
    $('speedVal').textContent = animationMs + 'ms';
  });
  wireAsyncPanelToggle();
}

function wireAsyncPanelToggle() {
  const toggleBtn = $('asyncToggle');
  const asyncCards = $('asyncCards');

  toggleBtn.addEventListener('click', () => {
    const isExpanded = toggleBtn.dataset.expanded === 'true';
    toggleBtn.dataset.expanded = isExpanded ? 'false' : 'true';
    asyncCards.dataset.collapsed = isExpanded ? 'true' : 'false';
  });
}

function markVersionButtons() {
  document.querySelectorAll('#versionSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === version);
  });
}

function setVersion(v) {
  version = v;
  stopAllAnimations();
  if (session && subscribedTopics.length) {
    unsubscribeAll();
    subscribeAll();
  }
  markVersionButtons();
  updateSubtitles();
  clearGrids();
}

// ---------------------------------------------------------------------------
//  SEMP queue stats (via backend proxy)
// ---------------------------------------------------------------------------
function scheduleRefresh() {
  const secs = Math.max(5, Number($('refreshSec').value) || 60);
  $('refreshSec').value = secs;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshStats, secs * 1000);
}

async function refreshStats() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { queues, at } = await fetch(`/api/semp/${monitorVersion}/queues`).then((r) => r.json());
    const when = new Date(at).toLocaleTimeString();
    $('globalUpdated').textContent = `Updated ${when}`;
    queues.forEach((q) => {
      const card = cards[q.key];
      if (!card) return;
      card.root.classList.toggle('stat-error', !q.ok);
      card.enq.textContent = q.messages ?? '—';
      card.con.textContent = q.consumers ?? '—';
      card.con.classList.remove('con-zero', 'con-one', 'con-many');
      if (q.consumers === 0) card.con.classList.add('con-zero');
      else if (q.consumers === 1) card.con.classList.add('con-one');
      else if (q.consumers > 1) card.con.classList.add('con-many');
    });
  } catch (e) {
    console.error('SEMP refresh failed', e);
  } finally {
    refreshing = false;
  }
}

// ---------------------------------------------------------------------------
//  Stoplight
// ---------------------------------------------------------------------------
function setLight(state, label) {
  const el = $('stoplight');
  el.dataset.state = state;
  $('stoplightLabel').textContent = label || state;
}

init();
