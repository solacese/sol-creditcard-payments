package com.solace.demo.payments.errorhandler;

import com.solace.demo.payments.common.PaymentEvent;
import com.solace.demo.payments.common.StageProcessor;
import com.solacesystems.jcsmp.BytesXMLMessage;

/**
 * Error Handler — consumes the reject topics {@code sale/invalid/>},
 * {@code sale/rejected/>} and {@code sale/fraud/>} from
 * {@code PaymentsRejected_Handler}. Logs each rejected event and publishes a
 * copy to the message's reply-to, which closes the REST request-reply back at
 * the POS terminal / load simulator with the failure result.
 */
public class ErrorHandlerApp extends StageProcessor {

    public ErrorHandlerApp() {
        super("errorHandler", "ErrorHandler");
    }

    @Override
    protected void handle(BytesXMLMessage inbound, PaymentEvent event) throws Exception {
        System.out.printf("[ErrorHandler] REJECTED txn=%s status=%s amount=%.2f %s merchant=%s/%s%n",
                event.transactionId, event.status, event.amount, event.currency,
                event.merchantType, event.merchantName);
        System.out.println("               history=" + event.history);
        if (cfg.boolVal(true, section, "replyOnReject")) {
            replyToOrigin(inbound, event);
        }
    }

    public static void main(String[] args) throws Exception {
        new ErrorHandlerApp().run();
    }
}
