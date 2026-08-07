package com.solace.demo.payments.riskaudit;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * RiskAudit — fan-out consumer of {@code sale/cleared/>} on
 * {@code PaymentsCleared_RiskAudit}. Simulates a post-clearance, offline
 * fraud/compliance audit of the cleared payment. Runs independently of
 * Settlement, Upsell and Insights; does not republish or reply.
 */
public class RiskAuditApp extends StageProcessor {

    public RiskAuditApp() {
        super("riskAudit", "RiskAudit");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        System.out.printf("[RiskAudit] audited txn=%s amount=%.2f %s merchant=%s/%s%n",
                event.transactionId, event.amount, event.currency,
                event.merchantType, event.merchantName);
    }

    public static void main(String[] args) throws Exception {
        new RiskAuditApp().run();
    }
}
