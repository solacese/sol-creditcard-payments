// ============================================================================
//  Live Topic Listener — frontend
//
//  Connects directly to the Solace broker from the browser (solclientjs over
//  WebSocket) and subscribes to whatever topic the user enters, showing every
//  matching message as it arrives. Same connection pattern as monitor.js.
// ============================================================================

const $ = (id) => document.getElementById(id);

const SAMPLE_TOPICS = [
  { topic: 'sale/>', desc: 'Every payment event, any stage' },
  { topic: 'sale/*/v1/>', desc: 'All stages, schema v1' },
  { topic: 'sale/cleared/v1/>', desc: 'Cleared transactions (async fan-out)' },
  { topic: 'sale/initiated/v1/>', desc: 'Validator input, any card type' },
  { topic: 'sale/initiated/v1/credit/>', desc: 'Credit card validations only' },
  { topic: 'sale/rejected/v1/>', desc: 'Rejected transactions only' },
  { topic: 'sale/received/v1/*/retail/amazon/>', desc: 'One merchant (Amazon), any card type' },
  { topic: 'sale/received/v1/credit/retail/amazon/>', desc: 'One merchant, credit card only' },
];

let session = null;
let currentTopic = null;
let msgCount = 0;
let tooltip = null;         // floating tooltip element, same look as monitor.js
let currencies = {};        // currency symbols from config

async function init() {
  buildSampleList();
  wireControls();
  startSolace();
}

function buildSampleList() {
  const list = $('sampleList');
  SAMPLE_TOPICS.forEach(({ topic, desc }) => {
    const el = document.createElement('div');
    el.className = 'sample-item';
    el.innerHTML = `<span class="topic">${escapeHtml(topic)}</span><span class="desc">${escapeHtml(desc)}</span>`;
    el.addEventListener('click', () => { $('topicInput').value = topic; });
    list.appendChild(el);
  });
}

function wireControls() {
  $('subscribeBtn').addEventListener('click', subscribeToInput);
  $('topicInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') subscribeToInput(); });
  $('clearBtn').addEventListener('click', clearLog);
  wireSamplesToggle();
}

function wireSamplesToggle() {
  const toggleBtn = $('samplesToggle');
  const list = $('sampleList');
  toggleBtn.addEventListener('click', () => {
    const isExpanded = toggleBtn.dataset.expanded === 'true';
    toggleBtn.dataset.expanded = isExpanded ? 'false' : 'true';
    list.dataset.collapsed = isExpanded ? 'true' : 'false';
  });
}

function subscribeToInput() {
  const topic = $('topicInput').value.trim();
  if (!topic) return;
  if (!session) { setSubStatus('Not connected to broker yet', true); return; }

  if (currentTopic) {
    try {
      session.unsubscribe(solace.SolclientFactory.createTopicDestination(currentTopic), true, currentTopic, 10000);
    } catch (e) {
      console.error('unsubscribe failed', currentTopic, e);
    }
  }

  try {
    session.subscribe(solace.SolclientFactory.createTopicDestination(topic), true, topic, 10000);
    currentTopic = topic;
    setSubStatus(`Subscribed to ${topic}`);
  } catch (e) {
    console.error('subscribe failed', topic, e);
    setSubStatus(`Subscribe failed: ${e.message}`, true);
  }
}

function setSubStatus(text, isError = false) {
  const el = $('subStatus');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
//  Solace session (direct browser connection)
// ---------------------------------------------------------------------------
function startSolace() {
  const factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.profile = solace.SolclientFactoryProfiles.version10;
  solace.SolclientFactory.init(factoryProps);

  setLight('amber', 'Connecting…');

  fetch('/api/listener/config')
    .then((r) => r.json())
    .then((cfg) => {
      currencies = cfg.currencies || {};
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
      session.on(E.UP_NOTICE, () => { setLight('green', 'Connected'); subscribeToInput(); });
      session.on(E.RECONNECTING_NOTICE, () => setLight('amber', 'Reconnecting…'));
      session.on(E.RECONNECTED_NOTICE, () => setLight('green', 'Connected'));
      session.on(E.CONNECT_FAILED_ERROR, (e) => { setLight('red', 'Connect failed'); console.error(e); });
      session.on(E.DISCONNECTED, () => setLight('red', 'Disconnected'));
      session.on(E.DOWN_ERROR, (e) => { setLight('red', 'Down'); console.error(e); });
      session.on(E.SUBSCRIPTION_ERROR, (e) => { console.error('subscription error', e); setSubStatus('Subscription rejected by broker', true); });
      session.on(E.MESSAGE, onMessage);

      try {
        session.connect();
      } catch (e) {
        setLight('red', 'Connect error');
        console.error('connect failed', e);
      }
    })
    .catch((e) => {
      setLight('red', 'Config error');
      console.error('failed to load /api/listener/config', e);
    });
}

function onMessage(message) {
  const dest = message.getDestination();
  const topic = dest ? dest.getName() : '(unknown topic)';
  const payload = payloadOf(message);
  const event = parseEvent(payload);
  addRow(topic, event, payload);
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

function addRow(topic, event, rawPayload) {
  const tbody = $('logBody');
  const empty = tbody.querySelector('.empty');
  if (empty) empty.remove();

  const rxTime = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const txnId = event?.transactionId ?? '—';
  const status = event?.status ?? '—';
  const merchantId = event?.merchantId ?? '—';
  const cur = currencies[event?.currency] || '';
  const amount = Number(event?.amount);
  const amountText = isNaN(amount) ? '—' : `${cur}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const tr = document.createElement('tr');
  tr.className = 'flash';
  tr.innerHTML = `
    <td>${escapeHtml(rxTime)}</td>
    <td>${escapeHtml(String(txnId))}</td>
    <td><span class="status-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
    <td>${escapeHtml(String(merchantId))}</td>
    <td class="amount">${escapeHtml(amountText)}</td>
    <td class="topic-cell" title="${escapeHtml(topic)}">${escapeHtml(topic)}</td>
  `;
  tr.addEventListener('mouseenter', () => showTooltip(tr, topic, event, rawPayload));
  tr.addEventListener('mouseleave', hideTooltip);

  tbody.insertBefore(tr, tbody.firstChild);
  while (tbody.rows.length > 200) tbody.deleteRow(-1);

  msgCount++;
  $('msgCount').textContent = `${msgCount} message${msgCount === 1 ? '' : 's'}`;
}

function clearLog() {
  const tbody = $('logBody');
  tbody.innerHTML = '<tr class="empty"><td colspan="6">waiting for messages…</td></tr>';
  msgCount = 0;
  $('msgCount').textContent = '0 messages';
}

// ---------------------------------------------------------------------------
//  Tooltip (full payload on hover) — same look/behavior as monitor.js
// ---------------------------------------------------------------------------
function highlightStatus(text, status) {
  const regex = new RegExp(`("status"\\s*:\\s*"${status}")`, 'g');
  return text.replace(regex, '<span class="status-highlight">$1</span>');
}

function showTooltip(tr, topic, event, rawPayload) {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'event-tooltip';
    document.body.appendChild(tooltip);
  }

  const status = event?.status || '—';
  const json = event ? JSON.stringify(event, null, 2) : (rawPayload || '(empty payload)');
  const highlightedJson = event ? highlightStatus(json, status) : escapeHtml(json);

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
  const gridRect = tr.closest('.log-grid').getBoundingClientRect();
  const TOOLTIP_WIDTH = 350; // must match .event-tooltip width in monitor.css
  const MARGIN = 10;

  // Centered horizontally over the grid; vertical alignment matches monitor.js.
  let left = gridRect.left + gridRect.width / 2 - TOOLTIP_WIDTH / 2;
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - TOOLTIP_WIDTH - MARGIN));

  tooltip.style.left = left + 'px';
  tooltip.style.top = (rect.top - 20) + 'px';
  tooltip.style.display = 'block';
}

function hideTooltip() {
  if (tooltip) tooltip.style.display = 'none';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setLight(state, label) {
  const el = $('stoplight');
  el.dataset.state = state;
  $('stoplightLabel').textContent = label || state;
}

init();
