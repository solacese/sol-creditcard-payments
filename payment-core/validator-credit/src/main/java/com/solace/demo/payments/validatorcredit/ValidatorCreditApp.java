package com.solace.demo.payments.validatorcredit;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Validator Credit processes credit card transactions from
 * PaymentsInitiated_ValidatorCredit queue. Succeeds 75% of the time,
 * publishes validated events; rejects 25% with invalid status.
 * Always propagates reply-to and correlation-id.
 */
public class ValidatorCreditApp extends StageProcessor {

    public ValidatorCreditApp() {
        super("validatorCredit", "ValidatorCredit");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        if (isRejected()) {
            String process = cfg.str(section, "rejectProcess"); // "invalid"
            republish(process, process, inbound, event);
        } else {
            String process = cfg.str(section, "successProcess"); // "validated"
            republish(process, process, inbound, event);
        }
    }

    public static void main(String[] args) throws Exception {
        new ValidatorCreditApp().run();
    }
}
