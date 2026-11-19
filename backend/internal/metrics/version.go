package metrics

import (
	"regexp"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
)

// SetVersion retains one bounded release label, replacing the prior startup value.
func (m *Metrics) SetVersion(version string) {
	if !m.Enabled() {
		return
	}
	version = strings.TrimPrefix(version, "v")
	valid, _ := regexp.MatchString(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`, version)
	if !valid {
		version = "unknown"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.build.Reset()
	m.build.WithLabelValues(version).Set(1)
}

func newBuildInfo() *prometheus.GaugeVec {
	return prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "clockwork_build_info",
		Help: "Current backend release; one bounded startup label, not a deployment or user identifier.",
	}, []string{"version"})
}
