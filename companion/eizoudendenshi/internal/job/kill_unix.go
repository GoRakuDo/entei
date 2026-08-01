//go:build !windows

package job

import (
	"os/exec"
	"syscall"
)

// newSysProcAttr puts the helper in its own process group so the whole
// tree can be killed on cancellation.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killTree terminates the helper process group (the helper and its
// children). A negative pid targets the process group. Errors are ignored:
// the process may already have exited, and the caller always reaps it via
// cmd.Wait afterwards.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
