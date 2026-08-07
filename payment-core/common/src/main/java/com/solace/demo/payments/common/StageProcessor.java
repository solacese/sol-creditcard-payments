package com.solace.demo.payments.common;

import com.solacesystems.jcsmp.BytesXMLMessage;
import com.solacesystems.jcsmp.ConsumerFlowProperties;
import com.solacesystems.jcsmp.Destination;
import com.solacesystems.jcsmp.EndpointProperties;
import com.solacesystems.jcsmp.FlowReceiver;
import com.solacesystems.jcsmp.JCSMPFactory;
import com.solacesystems.jcsmp.JCSMPProperties;
import com.solacesystems.jcsmp.JCSMPSession;
import com.solacesystems.jcsmp.JCSMPErrorResponseException;
import com.solacesystems.jcsmp.JCSMPErrorResponseSubcodeEx;
import com.solacesystems.jcsmp.Queue;
import com.solacesystems.jcsmp.TextMessage;
import com.solacesystems.jcsmp.Topic;
import com.solacesystems.jcsmp.XMLMessageListener;
import com.solacesystems.jcsmp.XMLMessageProducer;
import com.solacesystems.jcsmp.JCSMPException;
import com.solacesystems.jcsmp.JCSMPStreamingPublishCorrelatingEventHandler;

import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.CountDownLatch;

/**
 * Base class for every consuming payment microservice.
 *
 * <p>Handles the boilerplate shared by all stages:
 * <ul>
 *   <li>connect to Solace, provision a durable queue, add topic subscription(s);</li>
 *   <li>bind a flow with client-ack and dispatch each message to the subclass;</li>
 *   <li>simulate processing with a random delay in {@code [procMinMs, procMaxMs]};</li>
 *   <li>republish downstream while <b>propagating the Solace reply-to and
 *       correlation-id</b> so the end-to-end REST request-reply can complete.</li>
 * </ul>
 *
 * <p>Subclasses implement {@link #handle} using the {@link #republish} and
 * {@link #replyToOrigin} helpers.
 */
public abstract class StageProcessor implements XMLMessageListener {

    protected final Config cfg;
    protected final String section;   // config section name for this stage
    protected final String stageName; // human label used in logs / history

    private JCSMPSession session;
    private FlowReceiver flow;
    private XMLMessageProducer producer;
    private final CountDownLatch shutdown = new CountDownLatch(1);

    protected StageProcessor(String section, String stageName) {
        this.cfg = Config.load();
        this.section = section;
        this.stageName = stageName;
    }

    // ---- lifecycle ---------------------------------------------------------

    public final void run() throws Exception {
        session = SolaceSessionFactory.connect(cfg);
        producer = session.getMessageProducer(new NoopPublishEventHandler());

        Queue queue = provisionQueue();
        bindFlow(queue);

        System.out.printf("[%s] up. queue=%s waiting for messages... (Ctrl-C to stop)%n",
                stageName, cfg.str(section, "queue"));
        Runtime.getRuntime().addShutdownHook(new Thread(this::close));
        shutdown.await();
    }

    private Queue provisionQueue() throws Exception {
        String queueName = cfg.str(section, "queue");
        Queue queue = JCSMPFactory.onlyInstance().createQueue(queueName);

        EndpointProperties ep = new EndpointProperties();
        ep.setPermission(EndpointProperties.PERMISSION_CONSUME);
        ep.setAccessType(EndpointProperties.ACCESSTYPE_NONEXCLUSIVE);
        ep.setRespectsMsgTTL(true );
        session.provision(queue, ep, JCSMPSession.FLAG_IGNORE_ALREADY_EXISTS);

        // Add subscription(s): a single "subscription" or a "subscriptions" list.
        // Tolerate an already-present subscription so startup is idempotent
        // across restarts (addSubscription itself has no ignore-exists flag).
        for (String sub : subscriptions()) {
            Topic topic = JCSMPFactory.onlyInstance().createTopic(sub);
            try {
                session.addSubscription(queue, topic, JCSMPSession.WAIT_FOR_CONFIRM);
                System.out.printf("[%s] queue %s <- topic %s%n", stageName, queueName, sub);
            } catch (JCSMPErrorResponseException e) {
                if (e.getSubcodeEx() == JCSMPErrorResponseSubcodeEx.SUBSCRIPTION_ALREADY_PRESENT) {
                    System.out.printf("[%s] queue %s already has topic %s%n", stageName, queueName, sub);
                } else {
                    throw e;
                }
            }
        }
        return queue;
    }

    private List<String> subscriptions() {
        String single = cfg.str(section, "subscription");
        if (single != null) {
            return List.of(single);
        }
        return cfg.strList(section, "subscriptions");
    }

    private void bindFlow(Queue queue) throws Exception {
        ConsumerFlowProperties flowProps = new ConsumerFlowProperties();
        flowProps.setEndpoint(queue);
        flowProps.setAckMode(JCSMPProperties.SUPPORTED_MESSAGE_ACK_CLIENT);
        flow = session.createFlow(this, flowProps, new EndpointProperties());
        flow.start();
    }

    private void close() {
        try {
            if (flow != null) flow.close();
            if (session != null) session.closeSession();
        } catch (Exception ignore) {
        }
    }

    // ---- message dispatch --------------------------------------------------

    @Override
    public final void onReceive(BytesXMLMessage msg) {
        try {
            String json = extractText(msg);
            PaymentEvent event = PaymentEvent.fromJson(json);
            simulateProcessing();
            handle(msg, event);
            msg.ackMessage(); // CLIENT_ACK — remove from queue only after success
        } catch (Exception e) {
            System.err.printf("[%s] error handling message: %s%n", stageName, e.getMessage());
            // No ack -> the broker will redeliver.
        }
    }

    @Override
    public final void onException(JCSMPException e) {
        System.err.printf("[%s] consumer exception: %s%n", stageName, e.getMessage());
    }

    /** Subclass business logic. */
    protected abstract void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception;

    // ---- helpers for subclasses -------------------------------------------

    /**
     * Republish the event downstream on {@code sale/{process}/...}, copying the
     * payload and propagating reply-to + correlation-id from the inbound message.
     */
    protected void republish(String process, String newStatus, BytesXMLMessage inbound,
                             PaymentEvent event) throws Exception {
        event.stamp(stageName, newStatus);
        Topic topic = JCSMPFactory.onlyInstance().createTopic(TopicUtil.build(process, event));
        TextMessage out = newMessage(inbound, event);
        producer.send(out, topic);
        System.out.printf("[%s] %s -> %s%n", stageName, event.transactionId, topic.getName());
    }

    /**
     * Publish a copy of the event directly to the inbound message's reply-to
     * destination (closes the REST request-reply). No-op if reply-to is absent.
     */
    protected void replyToOrigin(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        Destination replyTo = inbound.getReplyTo();
        if (replyTo == null) {
            System.out.printf("[%s] %s has no reply-to; skipping reply%n", stageName, event.transactionId);
            return;
        }
        TextMessage out = newMessage(inbound, event);
        producer.send(out, replyTo);
        System.out.printf("[%s] %s -> reply-to %s%n", stageName, event.transactionId, replyTo.getName());
    }

    /** Build an outbound text message carrying the JSON + propagated headers. */
    private TextMessage newMessage(BytesXMLMessage inbound, PaymentEvent event) {
        TextMessage out = JCSMPFactory.onlyInstance().createMessage(TextMessage.class);
        out.setText(event.toJson());
        out.setDeliveryMode(com.solacesystems.jcsmp.DeliveryMode.PERSISTENT);
        // Propagate the request-reply metadata end-to-end.
        if (inbound.getReplyTo() != null) {
            out.setReplyTo(inbound.getReplyTo());
        }
        if (inbound.getCorrelationId() != null) {
            out.setCorrelationId(inbound.getCorrelationId());
        }
        return out;
    }

    private void simulateProcessing() {
        Object minObj = cfg.get(section, "procMinMs");
        Object maxObj = cfg.get(section, "procMaxMs");
        if (minObj == null || maxObj == null) {
            return; // stage does not simulate processing time (e.g. ErrorHandler)
        }
        int min = ((Number) minObj).intValue();
        int max = ((Number) maxObj).intValue();
        try {
            Thread.sleep(ThreadLocalRandom.current().nextInt(min, Math.max(min + 1, max)));
        } catch (InterruptedException ignore) {
            Thread.currentThread().interrupt();
        }
    }

    /** Returns true with probability {@code rejectPct}% (from this stage's config). */
    protected boolean isRejected() {
        Object pct = cfg.get(section, "rejectPct");
        int rejectPct = pct == null ? 0 : ((Number) pct).intValue();
        return ThreadLocalRandom.current().nextInt(100) < rejectPct;
    }

    private static String extractText(BytesXMLMessage msg) {
        if (msg instanceof TextMessage tm) {
            return tm.getText();
        }
        byte[] bytes = msg.getBytes();
        return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    }

    /** Publish confirmations are not needed for this demo. */
    private static final class NoopPublishEventHandler
            implements JCSMPStreamingPublishCorrelatingEventHandler {
        @Override public void responseReceivedEx(Object key) {}
        @Override public void handleErrorEx(Object key, JCSMPException cause, long timestamp) {
            System.err.println("[publish] error: " + cause.getMessage());
        }
    }
}
