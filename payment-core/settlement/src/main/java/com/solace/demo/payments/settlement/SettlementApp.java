package com.solace.demo.payments.settlement;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Settlement — fan-out consumer of {@code sale/cleared/>} on
 * {@code PaymentsCleared_Settlement}. Simulates settling the cleared payment
 * with the card networks. Runs independently of Upsell, Insights and
 * RiskAudit (each has its own durable copy of the same event); does not
 * republish or reply — the REST request-reply was already closed by
 * FraudClearing.
 */
public class SettlementApp extends StageProcessor {

    public SettlementApp() {
        super("settlement", "Settlement");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        System.out.printf("[Settlement] settled txn=%s amount=%.2f %s merchant=%s/%s%n",
                event.transactionId, event.amount, event.currency,
                event.merchantType, event.merchantName);
    }

    public static void main(String[] args) throws Exception {
        new SettlementApp().run();
    }
}
