// POS Sol Terminal — frontend logic
const $ = (id) => document.getElementById(id);

let config = null;

async function init() {
  config = await fetch('/api/config').then((r) => r.json());

  fillSelect($('currency'), Object.keys(config.currencies));
  fillSelect($('cardType'), config.cardTypes);
  fillSelect($('merchantType'), Object.keys(config.merchants));
  refreshMerchants();

  $('footTopic').textContent = `${config.topicPrefix}/…`;
  $('curSymbol').textContent = config.currencies[$('currency').value] || '$';

  $('merchantType').addEventListener('change', refreshMerchants);
  $('currency').addEventListener('change', () => {
    $('curSymbol').textContent = config.currencies[$('currency').value] || '$';
  });

  wireKeypad();
  $('payBtn').addEventListener('click', pay);
  $('againBtn').addEventListener('click', () => showView('inputView'));
}

function fillSelect(sel, items) {
  sel.innerHTML = '';
  items.forEach((v) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  });
}

function refreshMerchants() {
  const type = $('merchantType').value;
  fillSelect($('merchantName'), config.merchants[type] || []);
}

// ---- keypad ----
function wireKeypad() {
  $('keypad').addEventListener('click', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    const el = $('amount');
    let digits = el.value.replace(/[^\d]/g, '');
    if (k === 'C') digits = '';
    else if (k === 'back') digits = digits.slice(0, -1);
    else digits += k;
    digits = digits.slice(0, 9);
    el.value = formatAmount(digits);
  });
}

function formatAmount(digits) {
  const n = (parseInt(digits || '0', 10) / 100);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function amountValue() {
  return parseFloat($('amount').value.replace(/,/g, '')) || 0;
}

// ---- views ----
function showView(id) {
  ['inputView', 'processingView', 'resultView'].forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
}

// ---- pay ----
async function pay() {
  const amount = amountValue();
  if (amount <= 0) {
    $('amount').style.color = 'var(--red)';
    setTimeout(() => ($('amount').style.color = ''), 600);
    return;
  }

  const payload = {
    amount,
    currency: $('currency').value,
    cardType: $('cardType').value,
    merchantType: $('merchantType').value,
    merchantName: $('merchantName').value,
    merchantId: $('merchantId').value.trim(),
  };

  showView('processingView');
  $('procTopic').textContent =
    `${config.topicPrefix}/${payload.cardType}/${payload.merchantType}/${payload.merchantName}/…`;

  let res;
  try {
    res = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  } catch (err) {
    res = { outcome: 'ERROR', error: err.message };
  }
  renderResult(res, payload);
}

function renderResult(res, payload) {
  const badge = $('resultBadge');
  const cur = config.currencies[payload.currency] || '';
  $('resultAmount').textContent = `${cur}${payload.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  let cls = 'no', label = res.outcome || 'ERROR', statusLine = '';
  if (res.outcome === 'APPROVED') {
    cls = 'ok'; label = 'APPROVED';
    statusLine = `Cleared by the payment chain`;
  } else if (res.outcome === 'DECLINED') {
    cls = 'no'; label = 'DECLINED';
    statusLine = `Rejected at stage: ${res.finalStatus}`;
  } else if (res.outcome === 'TIMEOUT') {
    cls = 'warn'; label = 'TIMEOUT';
    statusLine = res.message || 'No reply received';
  } else {
    cls = 'warn'; label = 'ERROR';
    statusLine = res.error || 'Transport error';
  }
  badge.className = `result-badge ${cls}`;
  badge.textContent = label;
  $('resultStatus').textContent = statusLine;

  const ev = res.event || {};
  const rows = {
    'Txn ID': res.requestId || ev.transactionId || '—',
    'Final status': res.finalStatus || '—',
    'Merchant': `${payload.merchantType}/${payload.merchantName}`,
    'Card': `${payload.cardType} ••${ev.cardLast4 || '????'}`,
    'Latency': res.latencyMs != null ? `${res.latencyMs} ms` : '—',
    'Topic': res.topic || '—',
    'Path': (ev.history || []).join('  ›  ') || '—',
  };
  const dl = $('receipt');
  dl.innerHTML = '';
  Object.entries(rows).forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  });

  showView('resultView');
}

init();
