package com.solace.demo.payments.fraudclearing;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Fraud Clearing — consumes {@code sale/funded/>} from
 * {@code PaymentsFunded_Risk}. Succeeds to {@code sale/cleared/...}
 * (status {@code cleared}) or rejects {@code rejectPct%} to
 * {@code sale/fraud/...} (status {@code fraud}).
 *
 * <p>This is the final successful stage: on success it ALSO publishes a copy of
 * the cleared event to the message's reply-to, which closes the end-to-end REST
 * request-reply back at the POS terminal / load simulator. On fraud it only
 * routes to the fraud topic (the ErrorHandler owns the reply for rejects).
 */
public class FraudClearingApp extends StageProcessor {

    public FraudClearingApp() {
        super("fraudClearing", "FraudClearing");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        if (isRejected()) {
            String process = cfg.str(section, "rejectProcess"); // "fraud"
            republish(process, process, inbound, event);
        } else {
            String process = cfg.str(section, "successProcess"); // "cleared"
            republish(process, process, inbound, event);
            if (cfg.boolVal(true, section, "replyOnSuccess")) {
                replyToOrigin(inbound, event); // event already stamped "cleared"
            }
        }
    }

    public static void main(String[] args) throws Exception {
        new FraudClearingApp().run();
    }
}
