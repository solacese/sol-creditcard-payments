package com.solace.demo.payments.initiator;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Payment Initiator — consumes {@code sale/received/>} from the
 * {@code PaymentsReceived_Initiator} queue and republishes to
 * {@code sale/initiated/...} with status {@code initiated}.
 * Always succeeds; propagates reply-to + correlation-id.
 */
public class PaymentInitiatorApp extends StageProcessor {

    public PaymentInitiatorApp() {
        super("paymentInitiator", "Initiator");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        String process = cfg.str(section, "successProcess"); // "initiated"
        republish(process, process, inbound, event);
    }

    public static void main(String[] args) throws Exception {
        new PaymentInitiatorApp().run();
    }
}
