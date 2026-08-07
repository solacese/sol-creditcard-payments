package com.solace.demo.payments.validator;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Validator — consumes {@code sale/initiated/>} from
 * {@code PaymentsInitiated_Validator}. Succeeds to {@code sale/validated/...}
 * (status {@code validated}), or rejects {@code rejectPct%} of transactions to
 * {@code sale/invalid/...} (status {@code invalid}). Propagates reply-to +
 * correlation-id in both cases.
 */
public class ValidatorApp extends StageProcessor {

    public ValidatorApp() {
        super("validator", "Validator");
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
        new ValidatorApp().run();
    }
}
