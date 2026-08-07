package com.solace.demo.payments.insights;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Insights — fan-out consumer of {@code sale/cleared/>} on
 * {@code PaymentsCleared_Insights}. Simulates feeding the cleared payment
 * into a real-time analytics/BI pipeline. Runs independently of Settlement,
 * Upsell and RiskAudit; does not republish or reply.
 */
public class InsightsApp extends StageProcessor {

    public InsightsApp() {
        super("insights", "Insights");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        System.out.printf("[Insights] recorded txn=%s amount=%.2f %s merchant=%s/%s%n",
                event.transactionId, event.amount, event.currency,
                event.merchantType, event.merchantName);
    }

    public static void main(String[] args) throws Exception {
        new InsightsApp().run();
    }
}
