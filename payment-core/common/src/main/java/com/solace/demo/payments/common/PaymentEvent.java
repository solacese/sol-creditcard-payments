package com.solace.demo.payments.common;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;

/**
 * The credit-card payment event that flows through every stage as the JSON
 * message payload.
 *
 * <p>Topic levels 3-7 (version, card type, merchant type, merchant name,
 * transaction id) are carried here as fields so any stage can rebuild the
 * full topic while swapping only level 2 (the process). See {@link TopicUtil}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class PaymentEvent {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // --- business fields ---
    public String transactionId;
    public String status;          // received | initiated | validated | invalid | funded | rejected | cleared | fraud
    public double amount;
    public String currency;
    public String merchantId;

    // --- topic-defining fields (levels 3-7, minus the fixed sale/{process}) ---
    public String version;         // level 3, e.g. "v1" / "v2"
    public String cardType;        // level 4, credit | debit
    public String merchantType;    // level 5, e.g. airline
    public String merchantName;    // level 6, e.g. voi
    // transactionId is level 7

    // --- card metadata ---
    public String cardLast4;
    public String timestamp;

    /** Breadcrumb of every stage that touched the event. */
    public List<String> history = new ArrayList<>();

    public void stamp(String stage, String newStatus) {
        this.status = newStatus;
        this.history.add(stage + ":" + newStatus);
    }

    public String toJson() {
        try {
            return MAPPER.writeValueAsString(this);
        } catch (Exception e) {
            throw new RuntimeException("Failed to serialize PaymentEvent", e);
        }
    }

    public static PaymentEvent fromJson(String json) {
        try {
            return MAPPER.readValue(json, PaymentEvent.class);
        } catch (Exception e) {
            throw new RuntimeException("Failed to parse PaymentEvent: " + json, e);
        }
    }
}
