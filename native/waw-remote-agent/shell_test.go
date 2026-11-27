package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func lookPathOf(found ...string) func(string) (string, error) {
	set := make(map[string]bool, len(found))
	for _, name := range found {
		set[name] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/bin/" + name, nil
		}
		return "", errors.New("not found")
	}
}

/** A ProgramFiles tree with a Git bash.exe, so the candidate paths exist. */
func fakeGitBash(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	bash := filepath.Join(dir, "Git", "bin", "bash.exe")
	if err := os.MkdirAll(filepath.Dir(bash), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bash, []byte("stub"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ProgramFiles", dir)
	t.Setenv("ProgramFiles(x86)", "")
	t.Setenv("LOCALAPPDATA", "")
	return bash
}

func TestDetectShellsPOSIX(t *testing.T) {
	set := detectShells("linux", lookPathOf("bash", "sh"), func(string) bool { return false })
	if set.err != nil {
		t.Fatal(set.err)
	}
	if set.primary.name != "bash" || set.primary.flavor != "posix" {
		t.Fatalf("unexpected primary: %+v", set.primary)
	}
	if set.posix == nil || set.posix.exe != set.primary.exe {
		t.Fatal("POSIX hosts must offer their primary shell as the posix choice")
	}
	if strings.Join(set.names, ",") != "bash" {
		t.Fatalf("unexpected names: %v", set.names)
	}
}

func TestDetectShellsPOSIXFallsBackToSh(t *testing.T) {
	set := detectShells("linux", lookPathOf("sh"), func(string) bool { return false })
	if set.primary.name != "sh" {
		t.Fatalf("unexpected primary: %+v", set.primary)
	}
}

func TestDetectShellsWindowsPowerShellAndGitBash(t *testing.T) {
	gitBash := fakeGitBash(t)
	set := detectShells("windows", lookPathOf("pwsh", "powershell"), func(exe string) bool {
		return exe == gitBash
	})
	if set.err != nil {
		t.Fatal(set.err)
	}
	if set.primary.name != "pwsh" || set.primary.flavor != "powershell" {
		t.Fatalf("unexpected primary: %+v", set.primary)
	}
	if set.posix == nil || set.posix.name != "gitbash" || set.posix.exe != gitBash {
		t.Fatalf("unexpected posix shell: %+v", set.posix)
	}
	if strings.Join(set.names, ",") != "pwsh,gitbash" {
		t.Fatalf("unexpected names: %v", set.names)
	}

	chosen, err := set.pick("")
	if err != nil || chosen.name != "pwsh" {
		t.Fatalf("default pick: %+v %v", chosen, err)
	}
	chosen, err = set.pick("gitbash")
	if err != nil || chosen.name != "gitbash" {
		t.Fatalf("gitbash pick: %+v %v", chosen, err)
	}
	chosen, err = set.pick("posix")
	if err != nil || chosen.flavor != "posix" {
		t.Fatalf("posix pick: %+v %v", chosen, err)
	}
}

func TestDetectShellsWindowsFallsBackToWindowsPowerShell(t *testing.T) {
	fakeGitBash(t)
	set := detectShells("windows", lookPathOf("powershell"), func(string) bool { return false })
	if set.err != nil {
		t.Fatal(set.err)
	}
	if set.primary.name != "powershell" || set.primary.flavor != "powershell" {
		t.Fatalf("unexpected primary: %+v", set.primary)
	}
	if set.posix != nil {
		t.Fatal("no Git Bash was probed as usable")
	}
	if _, err := set.pick("gitbash"); err == nil {
		t.Fatal("gitbash must be refused when the host has none")
	}
}

func TestDetectShellsWindowsOnlyGitBash(t *testing.T) {
	gitBash := fakeGitBash(t)
	set := detectShells("windows", lookPathOf(), func(exe string) bool { return exe == gitBash })
	if set.err != nil {
		t.Fatal(set.err)
	}
	if set.primary.name != "gitbash" || set.primary.flavor != "posix" {
		t.Fatalf("the only shell must also be the default: %+v", set.primary)
	}
	if strings.Join(set.names, ",") != "gitbash" {
		t.Fatalf("unexpected names: %v", set.names)
	}
}

func TestDetectShellsWindowsWithoutAnyShell(t *testing.T) {
	fakeGitBash(t)
	set := detectShells("windows", lookPathOf(), func(string) bool { return false })
	if set.err == nil {
		t.Fatal("expected an error")
	}
	if _, err := set.pick(""); err == nil {
		t.Fatal("default pick must fail with the same reason")
	}
}

func TestPickRefusesWhatTheHostDoesNotHave(t *testing.T) {
	set := detectShells("linux", lookPathOf("bash"), func(string) bool { return false })
	if _, err := set.pick("powershell"); err == nil {
		t.Fatal("POSIX host must refuse powershell")
	}
	if _, err := set.pick("cmd"); err == nil {
		t.Fatal("unknown shells must be refused")
	}
	if chosen, err := set.pick("posix"); err != nil || chosen.name != "bash" {
		t.Fatalf("posix pick: %+v %v", chosen, err)
	}
}

func TestWrapPowerShellReportsFailures(t *testing.T) {
	script := wrapPowerShell("Get-ChildItem C:/missing")
	if !strings.Contains(script, "[Console]::OutputEncoding=[Text.Encoding]::UTF8") {
		t.Fatal("output encoding is not forced")
	}
	if !strings.Contains(script, "$OutputEncoding = [Text.UTF8Encoding]::new($false)") {
		t.Fatal("piping into a native command would use the ANSI code page")
	}
	if !strings.Contains(script, "[Console]::InputEncoding=[Text.Encoding]::UTF8") {
		t.Fatal("stdin encoding is not forced")
	}
	if !strings.Contains(script, "$ProgressPreference = 'SilentlyContinue'") {
		t.Fatal("progress records would be serialised as CLIXML on stderr")
	}
	if !strings.Contains(script, "$ErrorActionPreference = 'Stop'") {
		t.Fatal("cmdlet failures would not terminate")
	}
	if !strings.Contains(script, "$global:LASTEXITCODE = 0") {
		t.Fatal("LASTEXITCODE is not initialised")
	}
	if !strings.Contains(script, "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }") {
		t.Fatal("native exit code is not propagated")
	}
	if !strings.Contains(script, "[Console]::Error.WriteLine($_.Exception.Message)") {
		t.Fatal("the catch must write plain text, not a CLIXML error record")
	}
	if !strings.Contains(script, "Get-ChildItem C:/missing") {
		t.Fatal("the original command is missing")
	}
}

func TestCommandKeepsPOSIXCommandsVerbatim(t *testing.T) {
	set := detectShells("linux", lookPathOf("bash"), func(string) bool { return false })
	spec, err := set.pick("")
	if err != nil {
		t.Fatal(err)
	}
	cmd := spec.command(context.Background(), "echo hi")
	if got := strings.Join(cmd.Args, "\x00"); got != "bash\x00-lc\x00echo hi" {
		t.Fatalf("unexpected argv: %q", cmd.Args)
	}
}

func TestCommandWrapsPowerShellCommands(t *testing.T) {
	fakeGitBash(t)
	set := detectShells("windows", lookPathOf("pwsh"), func(string) bool { return false })
	spec, err := set.pick("")
	if err != nil {
		t.Fatal(err)
	}
	cmd := spec.command(context.Background(), "Get-Location")
	want := wrapPowerShell("Get-Location")
	if cmd.Args[len(cmd.Args)-1] != want {
		t.Fatalf("last arg is not the wrapped script: %q", cmd.Args[len(cmd.Args)-1])
	}
	if !strings.Contains(want, "Get-Location") {
		t.Fatal("the original command is missing from the wrapper")
	}
}
