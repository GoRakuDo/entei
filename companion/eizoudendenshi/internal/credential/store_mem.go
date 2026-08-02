package credential

import (
	"errors"
	"sync"
)

// MemStore is an in-memory Store used as a deterministic test fake by the
// API unit tests and by processes that must never touch disk (nil
// Config.Credential in api.New keeps the historical behavior; MemStore is
// the explicit in-memory variant). It is safe for concurrent use.
type MemStore struct {
	mu      sync.Mutex
	token   string
	version int
	ok      bool
	// saveErr / loadErr / deleteErr are test-only failure injectors so the
	// API's fail-closed paths (save failure fails the pair request, load
	// failure yields fresh credentials, delete failure still invalidates
	// in memory) are deterministic.
	saveErr   error
	loadErr   error
	deleteErr error
}

// NewMemStore returns an empty in-memory store (no stored credential).
func NewMemStore() *MemStore { return &MemStore{} }

// SeedToken pre-populates the store as if a previous pair had persisted.
// Test helper only.
func (m *MemStore) SeedToken(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = token
	m.version = CurrentVersion
	m.ok = true
}

// SetSaveError injects a Save failure. Test helper only.
func (m *MemStore) SetSaveError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saveErr = err
}

// SetLoadError injects a Load failure (corrupt / undecryptable storage).
// Test helper only.
func (m *MemStore) SetLoadError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.loadErr = err
}

// SetDeleteError injects a Delete failure. Test helper only.
func (m *MemStore) SetDeleteError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deleteErr = err
}

// StoredToken returns the currently stored token ("" when none). Test
// helper only.
func (m *MemStore) StoredToken() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token
}

func (m *MemStore) Load() (string, int, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.loadErr != nil {
		return "", 0, false, m.loadErr
	}
	if !m.ok {
		return "", 0, false, nil
	}
	return m.token, m.version, true, nil
}

func (m *MemStore) Save(token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.saveErr != nil {
		return m.saveErr
	}
	if !ValidToken(token) {
		return errors.New("credential: invalid token shape")
	}
	m.token = token
	m.version = CurrentVersion
	m.ok = true
	return nil
}

func (m *MemStore) Delete() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.token = ""
	m.version = 0
	m.ok = false
	return nil
}
