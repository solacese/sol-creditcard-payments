# Solace Credit Card Payments Demo

A reference demo showing how the **Solace** event broker powers a credit-card payment flow across independent syncronous + asyncronous applications and microservices. Everything communicates through Solace using a structured topic hierarchy, and demonstrating the **Solace REST request-reply** + ** Solace Pub Sub patterns ** — a POS terminal fires a payment over REST and *blocks* until the transaction has traversed the whole syncronous chain and a reply lands back on the broker-generated `reply-to`, while the Asyncronous microserivices get executed afterwards withouth delaying the response to the POS (and Customer)

![Payment Event Flow](/images/payment-event-flow.png)

```
                                    Solace broker
POS Sol Terminal  ─┐                                            ┌─► FraudClearing ─(success)─┐
 (web, REST v2)    ├─► sale/received/> ─► Initiator ─► Validator ─► Authorizer ─► sale/funded/> │ reply-to
POS Load Simulator ┘                          │           │          │                       ▼
 (Go, REST v1)                                 └(25%)      └(25%)     └(25%)            (HTTP reply)
                                              invalid    rejected    fraud                 ▲
                                                 └────────────┴──────────┴─► ErrorHandler ─┘

                                                                  sale/cleared/> ──┬─► Settlement
                                                                  (fan-out, 4      ├─► Upsell
                                                                   independent     ├─► Insights
                                                                   subscribers)    └─► RiskAudit
```

Everything up to `sale/cleared/>` is a **synchronous processing chain** — each
stage swaps the topic's process level and republishes to the next one. Once a
payment clears, four more consumers each get their **own independent copy**
of that same event (Solace **fan-out**): they process it asynchronously and
in parallel, and none of them republish or reply — they're terminal.

## Topic pattern

Seven variable levels:

```
sale / {process} / {version} / {credit|debit} / {merchantType} / {merchantName} / {transactionId}
  1        2           3             4                5               6                 7
```

Example: `sale/received/v1/credit/airline/voi/5723691`

- **Levels 1–3** are fixed by the producer: the web terminal publishes
  `sale/received/v2/…`, the load simulator publishes `sale/received/v1/…`.
- **Levels 4–7** are carried unchanged through the whole chain (as fields in the
  JSON payload); each stage swaps only **level 2** (the process) and republishes:
  `received → initiated → validated → funded → cleared`, with the reject branches
  `invalid`, `rejected`, `fraud`.

## Applications

| App | Tech | Role |
|-----|------|------|
| **POS Sol Terminal** | Node + Express (`payment-gui` `/pos`) | Branded web POS machine; manual payment → REST `sale/received/v2/…`, blocks for result |
| **Payment Core Monitor** | Browser + solclientjs (`payment-gui` `/monitor/v1`, `/v2`, `/v3`) | Live grid per microservice, subscribed straight to the broker; three selectable topologies (see below); per-queue depth + consumer count via SEMP |
| **Live Topic Listener** | Browser + solclientjs (`payment-gui` `/listener`) | Free-form debugging tool: subscribe to any topic (wildcards allowed) and watch matching messages arrive in a live log, with sample topics for the whole hierarchy |
| **POS Load Simulator** | Go (multi-threaded) | N virtual terminals firing random payments → REST `sale/received/v1/…`; prints traffic stats |
| **Payment Initiator** | Java / JCSMP | `sale/received/>` → `sale/initiated/…` (status `initiated`) |
| **Validator** | Java / JCSMP | `sale/initiated/>` → `sale/validated/…` or 25% → `sale/invalid/…` (all card types); used in the v1/v2 topology |
| **Validator Credit** | Java / JCSMP | `sale/initiated/*/credit/>` → `sale/validated/…` or 25% → `sale/invalid/…`; used in the v3 topology |
| **Validator Debit** | Java / JCSMP | `sale/initiated/*/debit/>` → `sale/validated/…` or 25% → `sale/invalid/…`; used in the v3 topology |
| **Authorizer** | Java / JCSMP | `sale/validated/>` → `sale/funded/…` or 25% → `sale/rejected/…` |
| **FraudClearing** | Java / JCSMP | `sale/funded/>` → `sale/cleared/…` or 5% → `sale/fraud/…`; on success replies to `reply-to` |
| **ErrorHandler** | Java / JCSMP | `sale/invalid/>`, `sale/rejected/>`, `sale/fraud/>` → logs and replies to `reply-to` |
| **Settlement** | Java / JCSMP | Fan-out subscriber of `sale/cleared/>`; simulates card-network settlement |
| **Upsell** | Java / JCSMP | Fan-out subscriber of `sale/cleared/>`; simulates a real-time upsell/loyalty offer; introduced in the v2 topology |
| **Insights** | Java / JCSMP | Fan-out subscriber of `sale/cleared/>`; simulates streaming analytics/BI ingestion |
| **RiskAudit** | Java / JCSMP | Fan-out subscriber of `sale/cleared/>`; simulates an offline post-clearance fraud audit |


POS Simulator:
![POS 1](/images/pos1.png)
![POS 2](/images/pos2.png)
![POS 3](/images/pos3.png)
![POS 4](/images/pos4.png)

Core Monitor GUI v3:
![Core Monitor GUI](/images/monitor_v3.png)

Solace Topic Listener GUI:
![Core Microservices](/images/topic_listener.png)

Core JAVA Console Microservices:
![Core Microservices](/images/core_microservices.png)

### Monitor / deployment topologies

The demo is built to be run as a **progression** — each topology adds or changes
a piece of the microservice chain, and the monitor has a matching view:

| Topology | Services (count) | What it shows |
|----------|-------------------|----------------|
| **v1** | Initiator, Validator, Authorizer, FraudClearing, ErrorHandler, Settlement, Insights, RiskAudit (8) | Baseline chain, no Upsell |
| **v2** (default) | v1 + Upsell (9) | Adds the Upsell fan-out consumer to an already-running system |
| **v3** | v1/v2 minus Validator, plus Validator Credit + Validator Debit (10) | Splits validation into two independently-scaled services, one per card type |

Start the matching microservice set with the `start-services-v1/v2/v3` scripts
(below — Windows in [`scripts/win/`](scripts/win/), macOS/Linux/Git Bash in
[`scripts/bash/`](scripts/bash/)) and open the matching monitor view
(`/monitor/v1`, `/monitor/v2`, `/monitor/v3`, also linked from the landing
page at `/`) to watch that topology's grid populate live.

Each stage in the synchronous chain **propagates the Solace `reply-to` and
`correlation-id`** so the final reply (from FraudClearing on success,
ErrorHandler on failure) is routed by the broker back to the blocked REST
caller. Settlement, Upsell, Insights and RiskAudit are pure **fan-out**
consumers: each has its own durable queue subscribed to `sale/cleared/>`, so
every one of them receives an independent copy of every cleared event, does
its (simulated) work, and neither republishes nor replies.

## Queues (auto-provisioned on startup)

Processing chain: `PaymentsReceived_Initiator`, `PaymentsInitiated_Validator`,
`PaymentsInitiated_ValidatorCredit`, `PaymentsInitiated_ValidatorDebit`,
`PaymentsValidated_Authorizer`, `PaymentsFunded_Fraud`, `PaymentsRejected_Handler`.

Fan-out (all subscribed to `sale/cleared/>`): `PaymentsCleared_Settlement`,
`PaymentsCleared_Upsell`, `PaymentsCleared_Insights`, `PaymentsCleared_RiskAudit`.

## Configuration

All apps read the single root [`config.yaml`](config.yaml) (override the location
with the `CONFIG_PATH` env var). Shared settings (broker connection, merchant
catalog, currencies) live at the top; app-specific settings under their own
section (reject percentages, processing-time windows, simulator fleet size, etc.).

The `solace:` block carries **four** connection profiles, one per port/protocol:

| Key | Port | Protocol | Used by |
|-----|------|----------|---------|
| `solace.tcp`  | `:55443` | SMF/TCP (`tcps`) | Java JCSMP microservices |
| `solace.rest` | `:9443`  | REST (`https`)   | POS terminal + load simulator (request-reply) |
| `solace.web`  | `:443`   | Secured Web Messaging (`wss`) | Payment Core Monitor, **in the browser** |
| `solace.semp` | `:943`   | SEMP v2 monitor (`https`) | monitor's queue depth / consumer counts (**server-side proxy only**) |

> **Ports differ by protocol.** Confirm each in the Solace Cloud console →
> *Connect*. `solace.web.uri` (`wss://…:443`) is the **Solace Web Messaging** host
> and is the one value to double-check if the monitor can't connect.
>
> **Credential exposure:** `solace.web.*` reaches the browser (unavoidable for any
> browser-based Solace client) — use a scoped client user. `solace.semp.*` are admin
> credentials and stay server-side: the monitor never calls SEMP directly; it goes
> through `payment-gui`'s `/api/semp/queues` proxy (also avoids CORS).

## Prerequisites

- Java 21 + Maven 3.9
- Go 1.26
- Node 20+ (tested on 24)
- A Solace broker (Solace Cloud) with SMF and REST messaging enabled.

## Build

```bash
# Java microservices (fat jars in each module's target/)
cd payment-core && mvn clean package

# Payment GUI (POS terminal + Payment Core Monitor)
cd payment-gui && npm install

# POS Load Simulator
cd pos-load-simulator && go build -o pos-load-simulator .

```

## Run

### Java microservices

Each service auto-provisions its own queue + subscription(s) on startup, so
order doesn't matter and starting them is idempotent across restarts.

#### All services (default, 9 microservices using original Validator)

```bash
# macOS / Linux / Git Bash — backgrounds all 9, Ctrl-C stops all of them
./scripts/bash/start-services.sh

# Windows cmd — opens each in its own titled window
scripts\win\start-services.bat
```

Stop all with a single command from another shell (no need to Ctrl-C the
window that started them):

```bash
./scripts/bash/stop-services.sh    # macOS / Linux / Git Bash
scripts\win\stop-services.bat      # Windows cmd
```

#### v1: All services excluding Upsell (8 microservices)

```bash
./scripts/bash/start-services-v1.sh  # macOS / Linux / Git Bash
./scripts/bash/stop-services-v1.sh   # macOS / Linux / Git Bash

scripts\win\start-services-v1.bat    # Windows cmd
scripts\win\stop-services-v1.bat     # Windows cmd
```

#### v2: All services including Upsell (9 microservices)

```bash
./scripts/bash/start-services-v2.sh  # macOS / Linux / Git Bash
./scripts/bash/stop-services-v2.sh   # macOS / Linux / Git Bash

scripts\win\start-services-v2.bat    # Windows cmd
scripts\win\stop-services-v2.bat     # Windows cmd
```

#### v3: All services excluding original Validator, including Validator Credit and Validator Debit (10 microservices)

```bash
./scripts/bash/start-services-v3.sh  # macOS / Linux / Git Bash
./scripts/bash/stop-services-v3.sh   # macOS / Linux / Git Bash

scripts\win\start-services-v3.bat    # Windows cmd
scripts\win\stop-services-v3.bat     # Windows cmd
```

#### Run individually

```bash
java -jar payment-core/payment-initiator/target/payment-initiator.jar
java -jar payment-core/validator/target/validator.jar
java -jar payment-core/validator-credit/target/validator-credit.jar
java -jar payment-core/validator-debit/target/validator-debit.jar
java -jar payment-core/authorizer/target/authorizer.jar
java -jar payment-core/fraud-clearing/target/fraud-clearing.jar
java -jar payment-core/error-handler/target/error-handler.jar
java -jar payment-core/settlement/target/settlement.jar
java -jar payment-core/insights/target/insights.jar
java -jar payment-core/risk-audit/target/risk-audit.jar
java -jar payment-core/upsell/target/upsell.jar
```

Start the Payment GUI (serves both the POS terminal and the monitor):

```bash
cd payment-gui && npm start
#   POS Sol Terminal     → http://localhost:8080/pos
#   Payment Core Monitor → http://localhost:8080/monitor
#   (landing page with links to both → http://localhost:8080/)
```

Generate load:

```bash
cd pos-load-simulator && ./pos-load-simulator

cd pos-load-simulator && pos-load-simulator.exe          # Windows cmd
# Ctrl-C to stop
```

Helper scripts (start/stop all services) are in [`scripts/win/`](scripts/win/)
(Windows `.bat`) and [`scripts/bash/`](scripts/bash/) (macOS/Linux/Git Bash `.sh`).

## Verify end-to-end

1. Submit a payment in the web terminal → watch the console of each Java stage log
   the topic republish, then the terminal shows **APPROVED** with the cleared
   event and the full `history` path (or **DECLINED** when a stage rejects).
2. On **APPROVED**, watch the Settlement, Upsell, Insights and RiskAudit
   consoles each independently log the same transaction ID at different times
   — that's the `sale/cleared/>` fan-out: four durable copies, one topic.
3. Run the simulator and watch the periodic `[stats …]` lines report throughput,
   approved/declined counts and average latency.
4. In the Solace Cloud console use **Try Me!** / message tracing (subscribe to
   `sale/>`) to see every stage's republish across the topic hierarchy, and
   the single `sale/cleared/…` publish that fans out to four queues.
5. Open the **Payment Core Monitor** (`/monitor/v1`, `/v2` or `/v3`): the stoplight
   turns green once the browser connects to `solace.web.uri`. Submit payments (or
   run the simulator) and watch each event flash into the matching grid — `received
   → initiated → validated → authorized → cleared` across the sync band, the
   fan-out grids all showing the same cleared event, and rejects landing in Error
   Handler with a Status. Each version is its own page (matching the microservice
   set you actually started — see topologies above) and re-subscribes every grid on
   load; the per-card **Enqueued / Consumers** figures come from SEMP (auto-refresh
   every N seconds, configurable, plus a manual **Refresh** button).
6. Open the **Live Topic Listener** (`/listener`) to eyeball raw broker traffic —
   subscribe to `sale/>` (or any narrower pattern, e.g. `sale/cleared/v1/>`) and
   watch every matching message land in the log with its topic, status, merchant
   and amount. Useful for spot-checking a topic pattern or watching the fan-out
   independently of the monitor's fixed grids.

## Repository layout

```
config.yaml                 shared configuration (all apps)
docs/brand.md               extracted Solace brand palette + fonts
payment-gui/                Node + Express: POS terminal (/pos), Payment Core Monitor (/monitor/v1|v2|v3),
                             and Live Topic Listener (/listener)
pos-load-simulator/         Go multi-threaded traffic generator
payment-core/               Maven multi-module: common + chain stages (incl. split credit/debit validators) + 4 fan-out consumers
scripts/                    demo_steps.md walkthrough
scripts/win/                Windows .bat start/stop-services helper scripts (v1/v2/v3 topologies)
scripts/bash/               macOS/Linux/Git Bash .sh start/stop-services helper scripts (v1/v2/v3 topologies)
```
