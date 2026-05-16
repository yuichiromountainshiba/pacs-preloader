# Sends an F15 keystroke every $intervalSec seconds. This updates Windows'
# LastInputInfo timer, so the "Machine inactivity limit" / screen-saver
# lock policy treats the session as active.
#
# F15 has no default behavior in any common app, so it's safe to fire
# while you're working — it won't type anything visible or trigger
# shortcuts.
#
# Stop the script: close the window, or Ctrl+C.

param(
    [int]$intervalSec = 60
)

Add-Type -AssemblyName System.Windows.Forms

$startedAt = Get-Date
Write-Host "[keep-awake] started at $($startedAt.ToString('HH:mm:ss')); jiggling every $intervalSec s. Close window or Ctrl+C to stop." -ForegroundColor Cyan

while ($true) {
    try {
        [System.Windows.Forms.SendKeys]::SendWait("{F15}")
        $stamp = (Get-Date).ToString("HH:mm:ss")
        Write-Host "[$stamp] tick" -ForegroundColor DarkGray
    } catch {
        Write-Host "[keep-awake] send failed: $_" -ForegroundColor Yellow
    }
    Start-Sleep -Seconds $intervalSec
}
