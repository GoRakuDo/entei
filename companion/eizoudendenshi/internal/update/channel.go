// Package update implements the EizouDendenshi in-place updater and
// update channel configuration.
package update

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"eizoudendenshi/internal/credential"
)

// Channel represents a distribution channel for the companion updater.
//
//   - ChannelStable: pinned to formal releases only; filters out any
//     pre-releases / rc tags (e.g. eizoudendenshi-v0.2.0-rc.97).
//   - ChannelPrerelease: tracks the latest release candidate (the original
//     selectRelease behavior).
//
// General users default to stable; testers opt into prerelease.
// (2026-08-26 decision: distribution channel separation).
type Channel string

const (
	// ChannelStable pins updates to formal releases only.
	ChannelStable Channel = "stable"
	// ChannelPrerelease tracks latest pre-release candidates.
	ChannelPrerelease Channel = "prerelease"
)

// channelFileName is the name of the persistent update channel configuration file.
const channelFileName = "channel.json"

// channelSchemaVersion is the schema version of channel.json envelope.
const channelSchemaVersion = 1

// maxChannelBytes bounds the channel.json size to prevent unbounded memory read.
const maxChannelBytes = 4096

// channelEnvelope is the schema-versioned envelope for channel persistence.
type channelEnvelope struct {
	Version int     `json:"version"`
	Channel Channel `json:"channel"`
}

// ValidChannel reports whether ch is one of the supported update channels.
func ValidChannel(ch Channel) bool {
	return ch == ChannelStable || ch == ChannelPrerelease
}

// DefaultStorageDir returns the default platform directory used for companion
// persistent state, delegating to internal/credential.
func DefaultStorageDir() string {
	return credential.DefaultStorageDir()
}

// channelFilePath resolves the full path to channel.json given a storage root.
// If root is empty, DefaultStorageDir() is used.
func channelFilePath(root string) string {
	if root == "" {
		root = DefaultStorageDir()
	}
	return filepath.Join(root, channelFileName)
}

// LoadChannel loads the update channel from channel.json under root.
// If root is empty, the default platform storage directory is used.
// Missing file returns (ChannelStable, nil) (fresh install default).
// Corrupt/invalid/unknown values or read errors return an error and fail
// closed to ChannelStable (2026-08-26 decision).
func LoadChannel(root string) (Channel, error) {
	path := channelFilePath(root)
	fi, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ChannelStable, nil // fresh install / missing file: default to stable
		}
		return ChannelStable, errors.New("update: stored channel unreadable")
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return ChannelStable, errors.New("update: refusing symlinked channel file")
	}
	if fi.Size() > maxChannelBytes {
		return ChannelStable, errors.New("update: channel file too large")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ChannelStable, errors.New("update: stored channel unreadable")
	}
	if len(b) == 0 {
		return ChannelStable, errors.New("update: empty channel envelope")
	}
	var env channelEnvelope
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&env); err != nil {
		return ChannelStable, errors.New("update: corrupt channel envelope")
	}
	if dec.More() {
		return ChannelStable, errors.New("update: trailing data in channel envelope")
	}
	if env.Version != channelSchemaVersion {
		return ChannelStable, fmt.Errorf("update: unsupported channel version %d", env.Version)
	}
	if !ValidChannel(env.Channel) {
		return ChannelStable, fmt.Errorf("update: unknown channel %q", env.Channel)
	}
	return env.Channel, nil
}

// SaveChannel saves the update channel to channel.json under root atomically
// with user-private permissions (mode 0600). If root is empty, the default
// platform storage directory is used.
func SaveChannel(root string, ch Channel) error {
	if !ValidChannel(ch) {
		return fmt.Errorf("update: invalid channel %q", ch)
	}
	path := channelFilePath(root)
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("update: refusing symlinked channel path")
	}
	b, err := json.Marshal(channelEnvelope{
		Version: channelSchemaVersion,
		Channel: ch,
	})
	if err != nil {
		return errors.New("update: channel marshal failed")
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return errors.New("update: channel directory creation failed")
	}
	tmp, err := os.CreateTemp(dir, ".channel-*")
	if err != nil {
		return errors.New("update: channel write failed")
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		cleanup()
		return errors.New("update: channel write failed")
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		cleanup()
		return errors.New("update: channel write failed")
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return errors.New("update: channel write failed")
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return errors.New("update: channel write failed")
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return errors.New("update: channel write failed")
	}
	return nil
}
