//go:build !windows

package torrent

import (
	"os/exec"
	"syscall"
)

// newSysProcAttr puts the helper in its own process group so the whole
// tree can be killed on cancellation.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killTree terminates the helper process group (helper and its children).
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
