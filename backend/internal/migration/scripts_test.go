package migration //nolint:testpackage // Test private compatibility helpers without expanding the production API.

import (
	"errors"
	"io/fs"
	"testing"
	"testing/fstest"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/migrations"
)

func TestCoreMatchesDeployedFlywayChecksums(t *testing.T) {
	t.Parallel()
	scripts, err := loadScripts([]fs.FS{migrations.Files()})
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{
		875620063,
		743659534,
		642069728,
		-1918175595,
		-811800722,
		1431524599,
		-1002586587,
		597769668,
		1212498741,
		1968587691,
		273017071,
		-182932096,
		-1070811757,
		-1043891658,
	}
	if len(scripts) != len(want) {
		t.Fatalf("got %d core scripts, want %d", len(scripts), len(want))
	}
	for i, item := range scripts {
		if item.version != int64(i+1) || item.checksum != want[i] {
			t.Fatalf("V%d: got checksum %d, want %d", item.version, item.checksum, want[i])
		}
	}
}

func TestChecksumIgnoresLineEndingsAndLeadingBOM(t *testing.T) {
	t.Parallel()
	want := flywayChecksum([]byte("SELECT 1;\nSELECT 2;\n"))
	for _, body := range []string{"SELECT 1;\r\nSELECT 2;\r\n", "\ufeffSELECT 1;\rSELECT 2;", "SELECT 1;\n\nSELECT 2;"} {
		if got := flywayChecksum([]byte(body)); got != want {
			t.Fatalf("checksum %d != %d", got, want)
		}
	}
}

func TestScriptsRejectDuplicatesInvalidNamesAndEncoding(t *testing.T) {
	t.Parallel()
	for name, files := range map[string]fstest.MapFS{
		"duplicate":        {"V1__one.sql": {Data: []byte("SELECT 1")}, "nested/V01__other.sql": {Data: []byte("SELECT 2")}},
		"invalid name":     {"broken.sql": {Data: []byte("SELECT 1")}},
		"invalid encoding": {"V1__one.sql": {Data: []byte{0xff}}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := loadScripts([]fs.FS{files})
			if !errors.Is(err, apperrors.ErrMigrationValidation) {
				t.Fatalf("want validation error, got %v", err)
			}
		})
	}
}

func TestHistoryVersions(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{"01": "1", "1.0": "1", "1008_1": "1008.1", "1008.01.0": "1008.1"} {
		got, err := historyVersion(input)
		if err != nil || got != want {
			t.Fatalf("%s: %s, %v", input, got, err)
		}
	}
	for _, input := range []string{"", "bad", "1.-1", "1..2"} {
		if _, err := historyVersion(input); !errors.Is(err, apperrors.ErrMigrationValidation) {
			t.Fatalf("accepted %q", input)
		}
	}
}
