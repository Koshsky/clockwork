package migration

import (
	"fmt"
	"io"
	"io/fs"
	"math"
	"strings"

	"github.com/golang-migrate/migrate/v4/source"
)

type embeddedSource struct {
	items map[uint]script
	index *source.Migrations
}

func newSource(scripts []script) (*embeddedSource, error) {
	s := &embeddedSource{items: make(map[uint]script), index: source.NewMigrations()}
	for _, item := range scripts {
		if item.version < 1 || item.version > math.MaxUint32 {
			return nil, fmt.Errorf("unsupported embedded version %d", item.version)
		}
		version := uint(item.version)
		s.items[version] = item
		s.index.Append(&source.Migration{Version: version, Identifier: item.name, Direction: source.Up})
	}
	return s, nil
}
func (s *embeddedSource) Open(string) (source.Driver, error) { return s, nil }
func (s *embeddedSource) Close() error                       { return nil }
func (s *embeddedSource) First() (uint, error) {
	if v, ok := s.index.First(); ok {
		return v, nil
	}
	return 0, fs.ErrNotExist
}
func (s *embeddedSource) Prev(v uint) (uint, error) {
	if n, ok := s.index.Prev(v); ok {
		return n, nil
	}
	return 0, fs.ErrNotExist
}
func (s *embeddedSource) Next(v uint) (uint, error) {
	if n, ok := s.index.Next(v); ok {
		return n, nil
	}
	return 0, fs.ErrNotExist
}
func (s *embeddedSource) ReadUp(v uint) (io.ReadCloser, string, error) {
	if item, ok := s.items[v]; ok {
		return io.NopCloser(strings.NewReader(item.body)), item.name, nil
	}
	return nil, "", fs.ErrNotExist
}
func (s *embeddedSource) ReadDown(uint) (io.ReadCloser, string, error) {
	return nil, "", fs.ErrNotExist
}
