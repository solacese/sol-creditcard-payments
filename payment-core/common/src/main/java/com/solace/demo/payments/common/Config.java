package com.solace.demo.payments.common;

import org.yaml.snakeyaml.Yaml;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Loads the shared {@code config.yaml} and exposes typed, path-based lookups.
 *
 * <p>Resolution order for the config location:
 * <ol>
 *   <li>the {@code CONFIG_PATH} environment variable, if set;</li>
 *   <li>a {@code config.yaml} in the current working directory;</li>
 *   <li>walk up parent directories looking for {@code config.yaml} (so any app
 *       can be launched from its own module folder in the monorepo).</li>
 * </ol>
 */
public final class Config {

    private final Map<String, Object> root;

    @SuppressWarnings("unchecked")
    private Config(Map<String, Object> root) {
        this.root = root;
    }

    public static Config load() {
        try {
            Path path = resolvePath();
            try (InputStream in = Files.newInputStream(path)) {
                Map<String, Object> data = new Yaml().load(in);
                System.out.println("[config] loaded " + path.toAbsolutePath());
                return new Config(data);
            }
        } catch (Exception e) {
            throw new RuntimeException("Unable to load config.yaml: " + e.getMessage(), e);
        }
    }

    private static Path resolvePath() {
        String env = System.getenv("CONFIG_PATH");
        if (env != null && !env.isBlank()) {
            return Path.of(env);
        }
        Path dir = Path.of("").toAbsolutePath();
        for (int i = 0; i < 6 && dir != null; i++) {
            Path candidate = dir.resolve("config.yaml");
            if (Files.exists(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        // last resort: expect it in the working directory
        return Path.of("config.yaml");
    }

    /** Navigate nested maps, e.g. {@code get("solace", "tcp", "uri")}. */
    @SuppressWarnings("unchecked")
    public Object get(String... keys) {
        Object node = root;
        for (String key : keys) {
            if (!(node instanceof Map)) {
                return null;
            }
            node = ((Map<String, Object>) node).get(key);
        }
        return node;
    }

    public String str(String... keys) {
        Object v = get(keys);
        return v == null ? null : String.valueOf(v);
    }

    public int intVal(String... keys) {
        Object v = get(keys);
        if (v == null) throw new IllegalStateException("Missing config: " + String.join(".", keys));
        return ((Number) v).intValue();
    }

    public boolean boolVal(boolean dflt, String... keys) {
        Object v = get(keys);
        return v == null ? dflt : Boolean.parseBoolean(String.valueOf(v));
    }

    @SuppressWarnings("unchecked")
    public List<String> strList(String... keys) {
        Object v = get(keys);
        return v == null ? List.of() : (List<String>) v;
    }
}
