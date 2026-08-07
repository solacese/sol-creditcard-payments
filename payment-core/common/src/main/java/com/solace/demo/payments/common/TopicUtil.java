package com.solace.demo.payments.common;

/**
 * Builds the 7-level payment topic:
 * {@code sale/{process}/{version}/{cardType}/{merchantType}/{merchantName}/{transactionId}}
 *
 * <p>Every stage keeps levels 3-7 unchanged and only swaps level 2 (the
 * process), so the topic is rebuilt purely from the event's carried fields.
 */
public final class TopicUtil {

    public static final String ROOT = "sale";

    private TopicUtil() {}

    public static String build(String process, PaymentEvent e) {
        return String.join("/",
                ROOT,
                process,
                e.version,
                e.cardType,
                e.merchantType,
                e.merchantName,
                e.transactionId);
    }
}
