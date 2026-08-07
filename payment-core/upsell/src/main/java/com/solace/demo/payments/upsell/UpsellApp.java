package com.solace.demo.payments.upsell;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Upsell — fan-out consumer of {@code sale/cleared/>} on
 * {@code PaymentsCleared_Upsell}. Simulates evaluating the cleared payment for
 * a real-time upsell/loyalty offer. Runs independently of Settlement,
 * Insights and RiskAudit; does not republish or reply.
 */
public class UpsellApp extends StageProcessor {

    public UpsellApp() {
        super("upsell", "Upsell");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        System.out.printf("[Upsell] evaluated offer for txn=%s amount=%.2f %s merchant=%s/%s%n",
                event.transactionId, event.amount, event.currency,
                event.merchantType, event.merchantName);
    }

    public static void main(String[] args) throws Exception {
        new UpsellApp().run();
    }
}
