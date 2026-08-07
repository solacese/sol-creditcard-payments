package com.solace.demo.payments.authorizer;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Authorizer — consumes {@code sale/validated/>} from
 * {@code PaymentsValidated_Authorizer}. Succeeds to {@code sale/funded/...}
 * (status {@code funded}), or rejects {@code rejectPct%} to
 * {@code sale/rejected/...} (status {@code rejected}). Propagates reply-to +
 * correlation-id in both cases.
 */
public class AuthorizerApp extends StageProcessor {

    public AuthorizerApp() {
        super("authorizer", "Authorizer");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        String process = isRejected()
                ? cfg.str(section, "rejectProcess")   // "rejected"
                : cfg.str(section, "successProcess");  // "funded"
        republish(process, process, inbound, event);
    }

    public static void main(String[] args) throws Exception {
        new AuthorizerApp().run();
    }
}
