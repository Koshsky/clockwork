package metrics_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/metrics"
)

func TestBuildInfoVersionIsBoundedAndReplaced(t *testing.T) {
	t.Parallel()
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ input, want string }{
		{"v1.6.0", "1.6.0"}, {"2.0.0", "2.0.0"}, {"01.0.0", "unknown"},
		{"private-token-url", "unknown"}, {"1.6.0\nprivate", "unknown"},
	} {
		m.SetVersion(tc.input)
		families := scrape(t, m)
		found := false
		for _, family := range families {
			if family.GetName() == "clockwork_build_info" {
				values := family.GetMetric()
				if len(values) != 1 || len(values[0].GetLabel()) != 1 || values[0].GetLabel()[0].GetValue() != tc.want {
					t.Fatal("release leaked or accumulated version labels")
				}
				found = true
			}
		}
		if !found {
			t.Fatal("missing version")
		}
	}
	(*metrics.Metrics)(nil).SetVersion("1.6.0")
}
