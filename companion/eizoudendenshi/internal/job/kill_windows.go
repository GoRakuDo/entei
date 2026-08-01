//go:build windows

package job

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNewProcessGroup = 0x00000200

// newSysProcAttr puts the helper in its own Windows process group so the
// whole tree can be killed on cancellation.
func newSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

// killTree terminates the helper process and its children. On Windows this
// uses the system `taskkill` binary with /T (tree) — never a shell; the
// argument vector is fixed. Errors are ignored: the process may already
// have exited, and the caller always reaps it via cmd.Wait afterwards.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
