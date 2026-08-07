// Package config loads the shared config.yaml used by every app in the demo.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Solace struct {
		Rest struct {
			URI              string `yaml:"uri"`
			Username         string `yaml:"username"`
			Password         string `yaml:"password"`
			RequestTimeoutMs int    `yaml:"requestTimeoutMs"`
			TLSVerify        bool   `yaml:"tlsVerify"`
		} `yaml:"rest"`
	} `yaml:"solace"`

	Merchants  map[string][]string `yaml:"merchants"`
	Currencies map[string]string   `yaml:"currencies"` // code -> symbol, e.g. USD -> "U$"
	CardTypes  []string            `yaml:"cardTypes"`

	LoadSimulator struct {
		RestTopicPrefix  string  `yaml:"restTopicPrefix"`
		Terminals        int     `yaml:"terminals"`
		IdleMinMs        int     `yaml:"idleMinMs"`
		IdleMaxMs        int     `yaml:"idleMaxMs"`
		StatsIntervalSec int     `yaml:"statsIntervalSec"`
		AmountMin        float64 `yaml:"amountMin"`
		AmountMax        float64 `yaml:"amountMax"`
		LogLevel         string  `yaml:"logLevel"`
	} `yaml:"loadSimulator"`
}

// Load resolves config.yaml from CONFIG_PATH, the working dir, or by walking up.
func Load() (*Config, error) {
	path, err := resolvePath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	fmt.Printf("[config] loaded %s\n", path)
	return &c, nil
}

func resolvePath() (string, error) {
	if env := os.Getenv("CONFIG_PATH"); env != "" {
		return env, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "config.yaml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("config.yaml not found (set CONFIG_PATH)")
}
