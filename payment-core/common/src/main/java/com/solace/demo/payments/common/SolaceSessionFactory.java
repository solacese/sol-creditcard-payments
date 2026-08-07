package com.solace.demo.payments.common;

import com.solacesystems.jcsmp.JCSMPProperties;
import com.solacesystems.jcsmp.JCSMPSession;
import com.solacesystems.jcsmp.JCSMPFactory;

/**
 * Creates a connected JCSMP session from the shared {@code solace.tcp} config.
 */
public final class SolaceSessionFactory {

    private SolaceSessionFactory() {}

    public static JCSMPSession connect(Config cfg) throws Exception {
        JCSMPProperties props = new JCSMPProperties();
        props.setProperty(JCSMPProperties.HOST, cfg.str("solace", "tcp", "uri"));
        props.setProperty(JCSMPProperties.VPN_NAME, cfg.str("solace", "tcp", "vpn"));
        props.setProperty(JCSMPProperties.USERNAME, cfg.str("solace", "tcp", "username"));
        props.setProperty(JCSMPProperties.PASSWORD, cfg.str("solace", "tcp", "password"));
        props.setProperty(JCSMPProperties.REAPPLY_SUBSCRIPTIONS, true);

        JCSMPSession session = JCSMPFactory.onlyInstance().createSession(props);
        session.connect();
        System.out.println("[solace] connected to " + cfg.str("solace", "tcp", "uri")
                + " (vpn=" + cfg.str("solace", "tcp", "vpn") + ")");
        return session;
    }
}
