// ============================================================================
//  POS Sol Terminal — Express backend
//
//  Serves the branded terminal UI and proxies each payment to the Solace broker
//  using the REST *request-reply* pattern: the POST carries a
//  `Solace-Reply-Wait-Time-In-ms` header, so the broker auto-generates a
//  reply-to, waits, and returns the reply (published by FraudClearing on success
//  or ErrorHandler on failure) as the HTTP response body.
// ============================================================================

import express from 'express';
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { log, configure as configureLog } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- load the shared config (walk up to find config.yaml) ------------------
function findConfig() {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'config.yaml');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('config.yaml not found');
}

const CONFIG_PATH = findConfig();
const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));

const REST = cfg.solace.rest;
const TERMINAL = cfg.posTerminal;
const PORT = TERMINAL.httpPort || 8080;
const TOPIC_PREFIX = TERMINAL.restTopicPrefix || 'sale/received/v2';
const WAIT_MS = REST.requestTimeoutMs || 30000;

// ---- Payment Core Monitor settings ----------------------------------------
const WEB = cfg.solace.web || {};      // solclientjs (browser) connection
const SEMP = cfg.solace.semp || {};    // SEMP v2 monitor (server-side only)
const MONITOR = cfg.monitor || {};

// The nine Payment Core microservices the monitor visualizes. `processes` are
// level-2 topic values; the browser composes `sale/{process}/{version}/>` per
// the selected version. Queue names come straight from the shared config (DRY).
const MONITOR_SERVICES_FULL = [
  { key: 'initiator',    label: 'Payment Initiator', band: 'sync',  processes: ['received'],                     queue: cfg.paymentInitiator?.queue, hasStatus: false },
  { key: 'validator',    label: 'Validator',         band: 'sync',  processes: ['initiated'],                    queue: cfg.validator?.queue,        hasStatus: false },
  { key: 'authorizer',   label: 'Authorizer',        band: 'sync',  processes: ['validated'],                    queue: cfg.authorizer?.queue,       hasStatus: false },
  { key: 'fraudClearing', label: 'Fraud Clearing',   band: 'sync',  processes: ['authorized'],                       queue: cfg.fraudClearing?.queue,    hasStatus: false },
  { key: 'errorHandler', label: 'Error Handler',     band: 'sync',  processes: ['invalid', 'rejected', 'fraud'], queue: cfg.errorHandler?.queue,     hasStatus: true },
  { key: 'upsell',       label: 'Upsell',            band: 'async', processes: ['cleared'],                      queue: cfg.upsell?.queue,           hasStatus: false },
  { key: 'riskAudit',    label: 'Risk Audit',        band: 'async', processes: ['cleared'],                      queue: cfg.riskAudit?.queue,        hasStatus: false },
  { key: 'insights',     label: 'Insights',          band: 'async', processes: ['cleared'],                      queue: cfg.insights?.queue,         hasStatus: false },
  { key: 'settlement',   label: 'Settlement',        band: 'async', processes: ['cleared'],                      queue: cfg.settlement?.queue,       hasStatus: false },
];

// v3 splits Validator into two: Validator Credit (above) and Validator Debit (below)
// Each has a custom topicPattern to subscribe to the appropriate card type
const MONITOR_SERVICES_V3 = [
  { key: 'initiator',           label: 'Payment Initiator',   band: 'sync',  processes: ['received'],                     queue: cfg.paymentInitiator?.queue,     hasStatus: false },
  { key: 'validatorCredit',     label: 'Validator Credit',    band: 'sync',  processes: ['initiated'],  topicPattern: 'credit', queue: cfg.validatorCredit?.queue,      hasStatus: false },
  { key: 'validatorDebit',      label: 'Validator Debit',     band: 'sync',  processes: ['initiated'],  topicPattern: 'debit',  queue: cfg.validatorDebit?.queue,       hasStatus: false },
  { key: 'authorizer',          label: 'Authorizer',          band: 'sync',  processes: ['validated'],                    queue: cfg.authorizer?.queue,           hasStatus: false },
  { key: 'fraudClearing',       label: 'Fraud Clearing',      band: 'sync',  processes: ['authorized'],                       queue: cfg.fraudClearing?.queue,        hasStatus: false },
  { key: 'errorHandler',        label: 'Error Handler',       band: 'sync',  processes: ['invalid', 'rejected', 'fraud'], queue: cfg.errorHandler?.queue,         hasStatus: true },
  { key: 'upsell',              label: 'Upsell',              band: 'async', processes: ['cleared'],                      queue: cfg.upsell?.queue,               hasStatus: false },
  { key: 'riskAudit',           label: 'Risk Audit',          band: 'async', processes: ['cleared'],                      queue: cfg.riskAudit?.queue,            hasStatus: false },
  { key: 'insights',            label: 'Insights',            band: 'async', processes: ['cleared'],                      queue: cfg.insights?.queue,             hasStatus: false },
  { key: 'settlement',          label: 'Settlement',          band: 'async', processes: ['cleared'],                      queue: cfg.settlement?.queue,           hasStatus: false },
];

// v1 excludes Upsell (all other grids in same position)
const MONITOR_SERVICES_V1 = MONITOR_SERVICES_FULL.filter(s => s.key !== 'upsell');
const MONITOR_SERVICES_V2 = MONITOR_SERVICES_FULL;

const activeLevel = configureLog(TERMINAL.logLevel);
log.info(`config loaded`, { path: CONFIG_PATH, logLevel: activeLevel });

// ---- helpers ---------------------------------------------------------------
function txnId() {
  return String(Math.floor(1_000_000 + Math.random() * 9_000_000));
}

function last4() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Publish one payment to Solace over REST request-reply and resolve with the
 * broker's reply (the final event) or reject on timeout / transport error.
 */
function publishRequestReply(topic, bodyJson, ctx = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(REST.uri);
    const isHttps = url.protocol === 'https:' || url.protocol === 'tcps:';
    const lib = isHttps ? https : http;
    const auth = Buffer.from(`${REST.username}:${REST.password}`).toString('base64');
    const port = url.port || (isHttps ? 9443 : 9000);

    const options = {
      hostname: url.hostname,
      port,
      path: `/TOPIC/${topic}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyJson),
        'Authorization': `Basic ${auth}`,
        // This header turns the publish into a blocking request-reply.
        'Solace-Reply-Wait-Time-In-ms': String(WAIT_MS),
      },
      rejectUnauthorized: REST.tlsVerify !== false,
      timeout: WAIT_MS + 5000,
    };

    // SENT: outbound request-reply to the broker.
    log.info('→ Solace REQUEST sent', { ...ctx, topic, waitMs: WAIT_MS });
    log.debug('request detail', {
      ...ctx,
      url: `${url.protocol}//${url.hostname}:${port}/TOPIC/${topic}`,
      bytes: Buffer.byteLength(bodyJson),
      body: bodyJson,
    });

    const started = Date.now();
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const latencyMs = Date.now() - started;
        log.debug('raw response', { ...ctx, httpStatus: res.statusCode, latencyMs, body: data });
        resolve({ status: res.statusCode, body: data, latencyMs });
      });
    });
    req.on('timeout', () => {
      log.warn('socket timeout — aborting request', { ...ctx, topic, afterMs: Date.now() - started });
      req.destroy(new Error('request timed out'));
    });
    req.on('error', (err) => {
      log.error('transport error', { ...ctx, topic, error: err.message });
      reject(err);
    });
    req.write(bodyJson);
    req.end();
  });
}

// ---- app -------------------------------------------------------------------
const app = express();
app.use(express.json());

// Route handlers for versioned monitor pages (must come before static middleware)
app.get('/monitor/v1', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor', 'v1.html'));
});
app.get('/monitor/v2', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor', 'v2.html'));
});
app.get('/monitor/v3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor', 'v3.html'));
});
app.get('/listener', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'listener', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Expose config the UI needs (never leak credentials).
app.get('/api/config', (_req, res) => {
  res.json({
    merchants: cfg.merchants,
    currencies: cfg.currencies,
    cardTypes: cfg.cardTypes,
    topicPrefix: TOPIC_PREFIX,
    broker: new URL(REST.uri).host,
  });
});

// ---- Payment Core Monitor --------------------------------------------------
// What the browser needs to open its OWN Solace session (solclientjs) and lay
// out the grids. The web-messaging password is delivered to the browser — this
// is inherent to any browser-based Solace client; the SEMP admin creds are NOT
// (those stay behind /api/semp/queues below).
function getMonitorConfig(version = 'v2') {
  let services;
  if (version === 'v1') services = MONITOR_SERVICES_V1;
  else if (version === 'v3') services = MONITOR_SERVICES_V3;
  else services = MONITOR_SERVICES_V2;

  return {
    web: { url: WEB.uri, vpn: WEB.vpn, userName: WEB.username, password: WEB.password },
    version,
    defaultVersion: MONITOR.defaultVersion || 'v2',
    refreshSec: MONITOR.refreshSec || 60,
    maxRows: MONITOR.maxRows || 10,
    maxRowsStacked: MONITOR.maxRowsStacked || 5,
    animationMs: MONITOR.animationMs || 1000,
    currencies: cfg.currencies || {},
    services: services.map(({ key, label, band, processes, topicPattern, queue, hasStatus }) => {
      const svc = { key, label, band, processes, queue, hasStatus };
      if (topicPattern) svc.topicPattern = topicPattern;
      return svc;
    }),
  };
}

app.get('/api/monitor/config', (_req, res) => {
  res.json(getMonitorConfig('v2'));
});

app.get('/api/monitor/:version/config', (req, res) => {
  const version = req.params.version;
  if (!['v1', 'v2', 'v3'].includes(version)) {
    return res.status(400).json({ error: 'Invalid version: must be v1, v2, or v3' });
  }
  res.json(getMonitorConfig(version));
});

// ---- Live Topic Listener ----------------------------------------------------
// Just the web-messaging connection details — the browser subscribes to
// whatever topic the user types in, no service/queue metadata needed.
app.get('/api/listener/config', (_req, res) => {
  res.json({
    web: { url: WEB.uri, vpn: WEB.vpn, userName: WEB.username, password: WEB.password },
    currencies: cfg.currencies || {},
  });
});

// Thin SEMP v2 monitor GET helper (path is relative to the VPN).
async function sempGet(pathAndQuery) {
  const base = String(SEMP.uri || '').replace(/\/+$/, '');
  const url = `${base}/SEMP/v2/monitor/msgVpns/${encodeURIComponent(SEMP.vpn)}${pathAndQuery}`;
  const auth = Buffer.from(`${SEMP.username}:${SEMP.password}`).toString('base64');
  const r = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`SEMP ${r.status} ${r.statusText}`);
  return r.json();
}

// One queue's depth + consumer count. Messages enqueued = `collections.msgs.count`
// on the queue object itself (the number of messages currently spooled);
// consumers = the number of bound transmit flows (txFlows), i.e. how many
// clients are currently draining the queue.
async function sempQueue(queueName) {
  const q = encodeURIComponent(queueName);
  const [queue, flows] = await Promise.all([
    sempGet(`/queues/${q}`),
    sempGet(`/queues/${q}/txFlows?count=100&select=flowId`),
  ]);
  return {
    messages: queue?.collections?.msgs?.count ?? null,
    consumers: flows?.meta?.count ?? (Array.isArray(flows?.data) ? flows.data.length : null),
  };
}

// Server-side proxy: the browser polls this instead of calling SEMP directly
// (avoids CORS and keeps the admin credentials off the client). One lookup per
// queue, in parallel; a single failing queue doesn't sink the batch.
function getSempQueuesForVersion(version = 'v2') {
  let services;
  if (version === 'v1') services = MONITOR_SERVICES_V1;
  else if (version === 'v3') services = MONITOR_SERVICES_V3;
  else services = MONITOR_SERVICES_V2;

  return async (_req, res) => {
    const results = await Promise.allSettled(services.map((s) => sempQueue(s.queue)));
    const queues = services.map((s, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') return { key: s.key, queue: s.queue, ...r.value, ok: true };
      log.warn('SEMP query failed', { queue: s.queue, error: r.reason?.message });
      return { key: s.key, queue: s.queue, messages: null, consumers: null, ok: false, error: r.reason?.message };
    });
    res.json({ queues, at: new Date().toISOString() });
  };
}

app.get('/api/semp/queues', getSempQueuesForVersion('v2'));
app.get('/api/semp/:version/queues', (req, res) => {
  const version = req.params.version;
  if (!['v1', 'v2', 'v3'].includes(version)) {
    return res.status(400).json({ error: 'Invalid version: must be v1, v2, or v3' });
  }
  getSempQueuesForVersion(version)(req, res);
});

app.post('/api/pay', async (req, res) => {
  const { amount, currency, merchantId, merchantType, merchantName, cardType } = req.body;
  if (!amount || !currency || !merchantType || !merchantName || !cardType) {
    log.warn('rejected invalid /api/pay request (missing fields)', { body: req.body });
    return res.status(400).json({ error: 'amount, currency, merchantType, merchantName and cardType are required' });
  }

  const version = TOPIC_PREFIX.split('/')[2] || 'v2';
  const id = txnId();
  const event = {
    transactionId: id,
    status: 'received',
    amount: Number(amount),
    currency,
    merchantId: merchantId || `${merchantName}-${Math.floor(Math.random() * 1000)}`,
    version,
    cardType,
    merchantType,
    merchantName,
    cardLast4: last4(),
    timestamp: new Date().toISOString(),
    history: ['POSSolTerminal:received'],
  };

  // sale/received/v2/{cardType}/{merchantType}/{merchantName}/{txnId}
  const topic = `${TOPIC_PREFIX}/${cardType}/${merchantType}/${merchantName}/${id}`;
  const bodyJson = JSON.stringify(event);
  const ctx = { txn: id };

  log.debug('payment requested from UI', {
    ...ctx, amount: event.amount, currency, merchant: `${merchantType}/${merchantName}`, card: cardType,
  });

  try {
    const reply = await publishRequestReply(topic, bodyJson, ctx);
    let replyEvent = null;
    try { replyEvent = JSON.parse(reply.body); } catch { /* non-JSON / empty */ }

    const finalStatus = replyEvent?.status || null;
    const approved = finalStatus === 'cleared';

    if (!replyEvent) {
      // No reply within the window (broker returned empty / timeout).
      log.warn('⏱ Solace TIMEOUT — no reply received', {
        ...ctx, topic, httpStatus: reply.status, latencyMs: reply.latencyMs, rawBody: reply.body ,
      });
      return res.status(504).json({
        outcome: 'TIMEOUT', topic, requestId: id,
        message: 'No reply received — is the processing chain running?',
        httpStatus: reply.status, latencyMs: reply.latencyMs,
      });
    }

    // RECEIVED: the broker returned the final event on the reply-to.
    log.info(`← Solace RESPONSE received: ${approved ? 'APPROVED' : 'DECLINED'}`, {
      ...ctx, finalStatus, latencyMs: reply.latencyMs, httpStatus: reply.status,
    });
    log.debug('reply path', { ...ctx, history: replyEvent.history });

    res.json({
      outcome: approved ? 'APPROVED' : 'DECLINED',
      finalStatus,
      topic,
      requestId: id,
      event: replyEvent,
      latencyMs: reply.latencyMs,
    });
  } catch (err) {
    // Transport failure already logged at error level in publishRequestReply.
    res.status(502).json({ outcome: 'ERROR', topic, requestId: id, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Payment GUI`);
  console.log(`  POS Sol Terminal           →  http://localhost:${PORT}/pos`);
  console.log(`  Payment Core Monitor (v1)  →  http://localhost:${PORT}/monitor/v1`);
  console.log(`  Payment Core Monitor (v2)  →  http://localhost:${PORT}/monitor/v2`);
  console.log(`  Live Topic Listener        →  http://localhost:${PORT}/listener`);
  console.log(`  Index                      →  http://localhost:${PORT}/`);
  console.log(`  Broker REST                →  ${REST.uri}`);
  console.log(`  Web messaging              →  ${WEB.uri || '(not configured)'}`);
  console.log(`  Topic prefix               →  ${TOPIC_PREFIX}/{card}/{merchantType}/{merchantName}/{txnId}\n`);
  log.info('Payment GUI listening', { port: PORT, broker: new URL(REST.uri).host });
  log.debug('effective settings', { topicPrefix: TOPIC_PREFIX, waitMs: WAIT_MS, tlsVerify: REST.tlsVerify !== false });
});
